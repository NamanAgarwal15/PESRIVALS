// Two-tier clan wars. Framework-free, no LLM.
//   Tier 1 "Clan vs Clan":    best-of-N series (N = 3 or 5), first clan to ceil(N/2) wins takes the war.
//   Tier 2 "Player vs Player": each slot pairs one player from each clan; the slot is won by the
//                              winner of a CONFIRMED match between exactly those two players.
//
// Integrity rules (OWASP A08):
//  - only matches with status = 'confirmed', not soft-deleted, saved AFTER the war went active,
//    inside the pair's active rivalry, with no open anti-sybil flag on that rivalry, can settle a slot
//  - draws never settle a slot (the slot waits for a decisive match; penalties are not recorded as a winner)
//  - clan_war_pairings.match_id is UNIQUE, so one match can settle one slot, ever
//  - settlement is idempotent: every write is a conditional UPDATE (status = 'pending'), counts are
//    recomputed from the pairings, and re-running changes nothing
//  - a slot whose match is later disputed or deleted is reopened while the war is still active;
//    a completed war is final

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clanMembers, clanWarPairings, clanWars, clans, matches, rivalries, users } from "@/db/schema";
import { type ClanFail, clanFail, getMembership, tagSchema } from "@/lib/clans";
import { pgErrorCode } from "@/lib/pg-error";
import { LIMITS, consumeRateLimit } from "@/lib/rate-limit";
import { canonicalPair } from "@/lib/rivalry-helpers";

export const MAX_OPEN_WARS_PER_CLAN = 3;
export const winsNeeded = (seriesSize: number) => Math.ceil(seriesSize / 2);

const usernameSchema = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,20}$/);
const challengeSchema = z
  .object({
    defenderTag: tagSchema,
    seriesSize: z.union([z.literal(3), z.literal(5)]),
    pairings: z.array(z.object({ mine: usernameSchema, theirs: usernameSchema })).min(3).max(5),
  })
  .refine((v) => v.pairings.length === v.seriesSize, "Provide exactly one pairing per game in the series.");

const isOfficer = (role: string) => role === "leader" || role === "officer";

/** An officer or leader challenges another clan and names the player pairings. */
export async function createClanWar(actorId: string, input: unknown): Promise<{ ok: true; warId: string } | ClanFail> {
  const parsed = challengeSchema.safeParse(input);
  if (!parsed.success) return clanFail("invalid", parsed.error.issues[0]?.message ?? "Invalid war challenge.");
  const me = await getMembership(actorId);
  if (!me) return clanFail("not_found", "You are not in a clan.");
  if (!isOfficer(me.role)) return clanFail("forbidden", "Only the leader or an officer can challenge another clan.");

  const limited = await consumeRateLimit(`clan-war:${actorId}`, LIMITS.warChallenge.max, LIMITS.warChallenge.windowMinutes);
  if (!limited.ok) return clanFail("rate_limited", "You have sent a lot of war challenges. Try again later.");

  const [defender] = await db.select({ id: clans.id }).from(clans).where(eq(clans.tag, parsed.data.defenderTag));
  if (!defender) return clanFail("not_found", "Clan not found.");
  if (defender.id === me.clanId) return clanFail("invalid", "You cannot challenge your own clan.");

  const open = await db
    .select({ id: clanWars.id, a: clanWars.challengerClanId, b: clanWars.defenderClanId })
    .from(clanWars)
    .where(and(inArray(clanWars.status, ["pending", "active"]), sql`(${clanWars.challengerClanId} IN (${me.clanId}, ${defender.id}) OR ${clanWars.defenderClanId} IN (${me.clanId}, ${defender.id}))`));
  if (open.some((w) => (w.a === me.clanId && w.b === defender.id) || (w.a === defender.id && w.b === me.clanId))) {
    return clanFail("conflict", "These clans already have a war pending or underway.");
  }
  const count = (clanId: string) => open.filter((w) => w.a === clanId || w.b === clanId).length;
  if (count(me.clanId) >= MAX_OPEN_WARS_PER_CLAN || count(defender.id) >= MAX_OPEN_WARS_PER_CLAN) {
    return clanFail("conflict", "One of the clans already has the maximum number of open wars.");
  }

  // Resolve every named player and prove clan membership on the server.
  const names = [...new Set(parsed.data.pairings.flatMap((p) => [p.mine, p.theirs]))];
  const found = await db
    .select({ id: users.id, username: users.username, clanId: clanMembers.clanId, suspended: users.suspended })
    .from(users)
    .innerJoin(clanMembers, eq(clanMembers.userId, users.id))
    .where(inArray(users.username, names));
  const byName = new Map(found.map((f) => [f.username, f]));
  const rows: { slot: number; c: string; d: string }[] = [];
  for (const [i, p] of parsed.data.pairings.entries()) {
    const mine = byName.get(p.mine);
    const theirs = byName.get(p.theirs);
    if (!mine || mine.clanId !== me.clanId || mine.suspended) return clanFail("invalid", `@${p.mine} is not an active member of your clan.`);
    if (!theirs || theirs.clanId !== defender.id || theirs.suspended) return clanFail("invalid", `@${p.theirs} is not an active member of that clan.`);
    rows.push({ slot: i + 1, c: mine.id, d: theirs.id });
  }
  if (new Set(rows.map((r) => r.c)).size !== rows.length || new Set(rows.map((r) => r.d)).size !== rows.length) {
    return clanFail("invalid", "Each player can only be used once per side in a war.");
  }

  const warId = crypto.randomUUID();
  try {
    await db.batch([
      db.insert(clanWars).values({ id: warId, challengerClanId: me.clanId, defenderClanId: defender.id, seriesSize: parsed.data.seriesSize, createdBy: actorId }),
      db.insert(clanWarPairings).values(rows.map((r) => ({ warId, slotNumber: r.slot, challengerPlayerId: r.c, defenderPlayerId: r.d }))),
    ]);
  } catch (err) {
    if (pgErrorCode(err) === "23505" || pgErrorCode(err) === "23514") return clanFail("invalid", "Those pairings are not valid.");
    throw err;
  }
  return { ok: true, warId };
}

/** Defender officers accept or decline; challenger officers cancel. Only a pending war can change. */
export async function respondToClanWar(actorId: string, warId: unknown, action: unknown): Promise<{ ok: true } | ClanFail> {
  const id = z.uuid().safeParse(warId);
  const act = z.enum(["accept", "decline", "cancel"]).safeParse(action);
  if (!id.success || !act.success) return clanFail("invalid", "Invalid request.");
  const me = await getMembership(actorId);
  if (!me) return clanFail("not_found", "War not found.");
  const [war] = await db.select().from(clanWars).where(eq(clanWars.id, id.data));
  const involved = war && (war.challengerClanId === me.clanId || war.defenderClanId === me.clanId);
  if (!war || !involved) return clanFail("not_found", "War not found."); // not your war: no signal
  if (!isOfficer(me.role)) return clanFail("forbidden", "Only the leader or an officer can answer a war.");
  if (war.status !== "pending") return clanFail("conflict", "This war is no longer pending.");

  const asDefender = war.defenderClanId === me.clanId;
  if ((act.data === "accept" || act.data === "decline") && !asDefender) return clanFail("forbidden", "Only the challenged clan can answer.");
  if (act.data === "cancel" && asDefender) return clanFail("forbidden", "Only the challenging clan can cancel.");

  if (act.data === "accept") {
    // Everyone paired must still be in the right clan.
    const pairs = await db.select().from(clanWarPairings).where(eq(clanWarPairings.warId, war.id));
    const members = await db
      .select({ userId: clanMembers.userId, clanId: clanMembers.clanId })
      .from(clanMembers)
      .where(inArray(clanMembers.userId, pairs.flatMap((p) => [p.challengerPlayerId, p.defenderPlayerId])));
    const clanOf = new Map(members.map((m) => [m.userId, m.clanId]));
    if (pairs.some((p) => clanOf.get(p.challengerPlayerId) !== war.challengerClanId || clanOf.get(p.defenderPlayerId) !== war.defenderClanId)) {
      return clanFail("conflict", "A paired player has left their clan. Ask for a new challenge.");
    }
  }
  const status = act.data === "accept" ? "active" : act.data === "decline" ? "declined" : "cancelled";
  const updated = await db
    .update(clanWars)
    .set({ status, // The database clock stamps the start, so it compares exactly with matches.created_at (no app/DB clock skew).
    ...(act.data === "accept" ? { startedAt: sql`now()` } : {}) })
    .where(and(eq(clanWars.id, war.id), eq(clanWars.status, "pending")))
    .returning({ id: clanWars.id });
  if (!updated.length) return clanFail("conflict", "This war is no longer pending.");
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

type Rows<T> = { rows?: T[] };
const rowsOf = <T>(res: unknown): T[] => (res as Rows<T>).rows ?? [];

/**
 * Settles whatever can be settled for one active war. Safe to call any number of times, from
 * anywhere (match save, dispute resolution, page view): it only ever moves pending slots to
 * completed using eligible confirmed matches, and recomputes the series from the slots.
 */
export async function settleWarPairings(warId: string): Promise<void> {
  const [war] = await db.select().from(clanWars).where(eq(clanWars.id, warId));
  if (!war || war.status !== "active" || !war.startedAt) return;

  // 1. Reopen slots whose match is no longer confirmed / was deleted (only while the war is open).
  await db.execute(sql`
    UPDATE clan_war_pairings p
    SET status = 'pending', match_id = NULL, winner_player_id = NULL, winner_clan_id = NULL
    WHERE p.war_id = ${warId}::uuid AND p.status = 'completed'
      AND NOT EXISTS (SELECT 1 FROM matches m WHERE m.id = p.match_id AND m.status = 'confirmed' AND m.deleted_at IS NULL)`);

  // 2. Settle pending slots in slot order.
  const pending = await db
    .select()
    .from(clanWarPairings)
    .where(and(eq(clanWarPairings.warId, warId), eq(clanWarPairings.status, "pending")))
    .orderBy(clanWarPairings.slotNumber);
  for (const p of pending) {
    const [a, b] = canonicalPair(p.challengerPlayerId, p.defenderPlayerId);
    const found = rowsOf<{ id: string; a_goals: number; b_goals: number }>(
      await db.execute(sql`
        SELECT m.id, m.user_a_goals AS a_goals, m.user_b_goals AS b_goals
        FROM matches m JOIN rivalries r ON r.id = m.rivalry_id
        WHERE r.user_a_id = ${a}::uuid AND r.user_b_id = ${b}::uuid AND r.status = 'active'
          AND m.status = 'confirmed' AND m.deleted_at IS NULL
          AND m.created_at >= (SELECT started_at FROM clan_wars WHERE id = ${warId}::uuid)
          AND m.user_a_goals <> m.user_b_goals
          AND NOT EXISTS (SELECT 1 FROM clan_war_pairings x WHERE x.match_id = m.id)
          AND NOT EXISTS (SELECT 1 FROM sybil_flags f WHERE f.rivalry_id = r.id AND f.status = 'open')
        ORDER BY m.created_at ASC, m.id ASC
        LIMIT 1`),
    )[0];
    if (!found) continue;
    const challengerIsA = p.challengerPlayerId === a;
    const challengerGoals = challengerIsA ? found.a_goals : found.b_goals;
    const defenderGoals = challengerIsA ? found.b_goals : found.a_goals;
    const challengerWon = challengerGoals > defenderGoals;
    try {
      await db
        .update(clanWarPairings)
        .set({
          matchId: found.id,
          status: "completed",
          winnerPlayerId: challengerWon ? p.challengerPlayerId : p.defenderPlayerId,
          winnerClanId: challengerWon ? war.challengerClanId : war.defenderClanId,
        })
        // Conditional: a concurrent settle that got here first leaves this a no-op.
        .where(and(eq(clanWarPairings.id, p.id), eq(clanWarPairings.status, "pending"), sql`${clanWarPairings.matchId} IS NULL`));
    } catch (err) {
      if (pgErrorCode(err) !== "23505") throw err; // match already used by another slot: skip
    }
  }

  // 3. Recompute the series from the slots; complete the war at a majority. Idempotent.
  await db.execute(sql`
    UPDATE clan_wars w SET
      challenger_wins = s.cw,
      defender_wins = s.dw,
      status = CASE WHEN s.cw >= ${winsNeeded(war.seriesSize)} OR s.dw >= ${winsNeeded(war.seriesSize)} THEN 'completed' ELSE w.status END,
      winner_clan_id = CASE WHEN s.cw >= ${winsNeeded(war.seriesSize)} THEN w.challenger_clan_id
                            WHEN s.dw >= ${winsNeeded(war.seriesSize)} THEN w.defender_clan_id ELSE NULL END,
      completed_at = CASE WHEN s.cw >= ${winsNeeded(war.seriesSize)} OR s.dw >= ${winsNeeded(war.seriesSize)} THEN now() ELSE NULL END
    FROM (
      SELECT
        count(*) FILTER (WHERE p.status = 'completed' AND p.winner_clan_id = ${war.challengerClanId}::uuid)::int AS cw,
        count(*) FILTER (WHERE p.status = 'completed' AND p.winner_clan_id = ${war.defenderClanId}::uuid)::int AS dw
      FROM clan_war_pairings p WHERE p.war_id = ${warId}::uuid
    ) s
    WHERE w.id = ${warId}::uuid AND w.status = 'active'`);
}

/** Called after a match is saved, disputed or re-confirmed: settles every active war that pairs these two players. */
export async function settleClanWarsForMatch(matchId: string): Promise<void> {
  const [m] = await db
    .select({ a: rivalries.userAId, b: rivalries.userBId })
    .from(matches)
    .innerJoin(rivalries, eq(rivalries.id, matches.rivalryId))
    .where(eq(matches.id, matchId));
  if (!m) return;
  const wars = await db
    .selectDistinct({ id: clanWars.id })
    .from(clanWars)
    .innerJoin(clanWarPairings, eq(clanWarPairings.warId, clanWars.id))
    .where(
      and(
        eq(clanWars.status, "active"),
        sql`((${clanWarPairings.challengerPlayerId} = ${m.a} AND ${clanWarPairings.defenderPlayerId} = ${m.b}) OR (${clanWarPairings.challengerPlayerId} = ${m.b} AND ${clanWarPairings.defenderPlayerId} = ${m.a}))`,
      ),
    );
  for (const w of wars) await settleWarPairings(w.id);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type WarView = {
  id: string;
  status: string;
  seriesSize: number;
  challenger: { tag: string; name: string; wins: number };
  defender: { tag: string; name: string; wins: number };
  winnerTag: string | null;
  createdAt: string;
  pairings: { slot: number; challenger: string; defender: string; status: string; winner: string | null }[];
  /** What the viewer's clan may do with this war. */
  canAccept: boolean;
  canCancel: boolean;
};

/** Recent wars of one clan (newest first). Active wars are settled first so the scoreboard is current. */
export async function getClanWars(clanId: string, viewerRole: string | null, limit = 10): Promise<WarView[]> {
  const wars = await db
    .select()
    .from(clanWars)
    .where(sql`${clanWars.challengerClanId} = ${clanId} OR ${clanWars.defenderClanId} = ${clanId}`)
    .orderBy(desc(clanWars.createdAt))
    .limit(limit);
  for (const w of wars) if (w.status === "active") await settleWarPairings(w.id);
  if (!wars.length) return [];
  const fresh = await db.select().from(clanWars).where(inArray(clanWars.id, wars.map((w) => w.id))).orderBy(desc(clanWars.createdAt));

  const clanRows = await db
    .select({ id: clans.id, tag: clans.tag, name: clans.name })
    .from(clans)
    .where(inArray(clans.id, [...new Set(fresh.flatMap((w) => [w.challengerClanId, w.defenderClanId]))]));
  const clanById = new Map(clanRows.map((c) => [c.id, c]));
  const pairs = await db.select().from(clanWarPairings).where(inArray(clanWarPairings.warId, fresh.map((w) => w.id))).orderBy(clanWarPairings.slotNumber);
  const people = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(inArray(users.id, [...new Set(pairs.flatMap((p) => [p.challengerPlayerId, p.defenderPlayerId]))]));
  const name = new Map(people.map((p) => [p.id, p.username]));
  const officer = viewerRole === "leader" || viewerRole === "officer";

  return fresh.map((w) => {
    const c = clanById.get(w.challengerClanId);
    const d = clanById.get(w.defenderClanId);
    return {
      id: w.id,
      status: w.status,
      seriesSize: w.seriesSize,
      challenger: { tag: c?.tag ?? "?", name: c?.name ?? "?", wins: w.challengerWins },
      defender: { tag: d?.tag ?? "?", name: d?.name ?? "?", wins: w.defenderWins },
      winnerTag: w.winnerClanId ? clanById.get(w.winnerClanId)?.tag ?? null : null,
      createdAt: w.createdAt.toISOString(),
      pairings: pairs
        .filter((p) => p.warId === w.id)
        .map((p) => ({
          slot: p.slotNumber,
          challenger: name.get(p.challengerPlayerId) ?? "?",
          defender: name.get(p.defenderPlayerId) ?? "?",
          status: p.status,
          winner: p.winnerPlayerId ? name.get(p.winnerPlayerId) ?? null : null,
        })),
      canAccept: officer && w.status === "pending" && w.defenderClanId === clanId,
      canCancel: officer && w.status === "pending" && w.challengerClanId === clanId,
    };
  });
}
