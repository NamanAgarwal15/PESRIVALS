// Match logic that talks to the database. Framework-free on purpose (no
// next/* imports) so it can be exercised directly by Vitest. Every function
// takes the acting user's id explicitly and checks rivalry membership itself.

import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { matches, rivalries, users } from "@/db/schema";
import { settleClanWarsForMatch } from "@/lib/clan-wars";
import { extractionCacheKey, getCachedExtraction, putCachedExtraction } from "@/lib/extract-cache";
import { assessConfidence } from "@/lib/confidence";
import { type IngestResult, VisionVlmIngestor } from "@/lib/ingestors";
import { verifyExtraction } from "@/lib/extract-signature";
import { type ExtractedSide, saveMatchInputSchema } from "@/lib/match-schema";
import { type MatchOutcome, type StatKey, STAT_KEYS, matchOutcome } from "@/lib/match-stats";
import { isUuid } from "@/lib/rivalry-helpers";

type MatchInsert = typeof matches.$inferInsert;

// Column name suffix for each stat: user_a_<stat> is userA<Suffix> in Drizzle.
const STAT_COLUMN_SUFFIX: Record<StatKey, string> = {
  possession: "Possession",
  shots: "Shots",
  shots_on_target: "ShotsOnTarget",
  fouls: "Fouls",
  offsides: "Offsides",
  corners: "Corners",
  free_kicks: "FreeKicks",
  passes: "Passes",
  successful_passes: "SuccessfulPasses",
  crosses: "Crosses",
  interceptions: "Interceptions",
  tackles: "Tackles",
  saves: "Saves",
};

/** All columns of one canonical slot (user_a_* or user_b_*) from one screenshot side. */
function slotColumns(slot: "A" | "B", side: ExtractedSide): Partial<MatchInsert> {
  const out: Record<string, string | number | null> = {
    [`user${slot}Team`]: side.team,
    [`user${slot}Goals`]: side.goals,
  };
  for (const key of STAT_KEYS) {
    out[`user${slot}${STAT_COLUMN_SUFFIX[key]}`] = side[key];
  }
  return out as Partial<MatchInsert>;
}

/** `readOnly` also admits an archived rivalry (opponent deleted/suspended): history stays visible, nothing can be written. */
async function findActiveRivalry(currentUserId: string, rivalryId: unknown, readOnly = false) {
  if (!isUuid(currentUserId) || !isUuid(rivalryId)) return null;
  const [row] = await db
    .select({
      id: rivalries.id,
      userAId: rivalries.userAId,
      userBId: rivalries.userBId,
    })
    .from(rivalries)
    .where(
      and(
        eq(rivalries.id, rivalryId),
        readOnly ? inArray(rivalries.status, ["active", "archived"]) : eq(rivalries.status, "active"),
        or(eq(rivalries.userAId, currentUserId), eq(rivalries.userBId, currentUserId)),
      ),
    );
  if (!row) return null;
  if (readOnly) return row;
  // Ghost-opponent guard: nothing is read or saved against a suspended or deleted opponent.
  const opponentId = row.userAId === currentUserId ? row.userBId : row.userAId;
  const [opp] = await db.select({ suspended: users.suspended }).from(users).where(eq(users.id, opponentId));
  if (!opp || opp.suspended) return null;
  return row;
}

function pgErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { code?: unknown; cause?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    current = e.cause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

export type ExtractForMemberResult =
  | IngestResult
  | { ok: false; code: "not_found"; error: string };

/** Runs the Gemini extraction, but only for a member of the active rivalry. */
export async function extractForMember(
  currentUserId: string,
  rivalryId: unknown,
  image: { bytes: Uint8Array },
): Promise<ExtractForMemberResult> {
  const rivalry = await findActiveRivalry(currentUserId, rivalryId);
  if (!rivalry) return { ok: false, code: "not_found", error: "Rivalry not found" };
  const hash = extractionCacheKey(image.bytes);
  const cached = getCachedExtraction(hash);
  if (cached) return cached;
  const result = await VisionVlmIngestor.ingest(image);
  if (result.ok) putCachedExtraction(hash, result);
  return result;
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export type SaveMatchResult =
  | { ok: true; matchId: string; matchNo: number; opponentId: string }
  | { ok: false; error: string };

const MATCH_NO_ATTEMPTS = 3;

/**
 * Saves an extracted match into a rivalry.
 *
 * The screenshot only knows LEFT and RIGHT. The database only knows user_a
 * and user_b (lower uuid = user_a). `mySide` says which screenshot side the
 * current user played, so:
 *   current user's slot  <- the side they picked
 *   opponent's slot      <- the other side
 */
export async function saveMatchForUser(
  currentUserId: string,
  input: unknown,
): Promise<SaveMatchResult> {
  const parsed = saveMatchInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "");
    if (field === "mySide") return { ok: false, error: "Choose which side you played" };
    if (field === "host") return { ok: false, error: "Choose who hosted the match" };
    if (field === "remark") return { ok: false, error: "Remark can be at most 200 characters" };
    if (field === "rivalryId") return { ok: false, error: "Rivalry not found" };
    return {
      ok: false,
      error: "The match details are not valid. Upload the screenshot again.",
    };
  }
  const { rivalryId, extracted, mySide, host, decidedOnPens, remark } = parsed.data;
  // Proof the numbers came from the reader for this user, rivalry and image. Anything else
  // (hand-edited, replayed on another rivalry, expired, unsigned) is saved as UNVERIFIED.
  const verified = verifyExtraction(parsed.data.signature, {
    rivalryId,
    userId: currentUserId,
    screenshotHash: parsed.data.screenshotHash,
    extracted,
  });
  // Yellow if the reader flagged anything (client-reported), our own checks do, or it is unverified.
  const needsReview =
    parsed.data.needsReview || assessConfidence(extracted).hasYellow || !verified;

  const rivalry = await findActiveRivalry(currentUserId, rivalryId);
  if (!rivalry) return { ok: false, error: "Rivalry not found" };

  const iAmUserA = rivalry.userAId === currentUserId;
  const opponentId = iAmUserA ? rivalry.userBId : rivalry.userAId;

  if (verified && parsed.data.screenshotHash) {
    // One screenshot is one match: the same image cannot be saved twice in a rivalry.
    const [dup] = await db
      .select({ id: matches.id })
      .from(matches)
      .where(and(eq(matches.rivalryId, rivalry.id), eq(matches.screenshotHash, parsed.data.screenshotHash), isNull(matches.deletedAt)))
      .limit(1);
    if (dup) return { ok: false, error: "That screenshot has already been saved as a match." };
  }

  const mine = extracted[mySide];
  const theirs = extracted[mySide === "left" ? "right" : "left"];

  const values = {
    rivalryId: rivalry.id,
    // Computed inside the INSERT; the unique constraint settles any race.
    matchNo: sql<number>`(SELECT COALESCE(MAX(m.match_no), 0) + 1 FROM matches m WHERE m.rivalry_id = ${rivalry.id})`,
    playedAt: new Date().toISOString().slice(0, 10), // today, UTC
    hostUserId: host === "home" ? currentUserId : opponentId,
    createdBy: currentUserId,
    source: "screenshot",
    status: "confirmed",
    needsReview,
    verified,
    screenshotHash: verified ? parsed.data.screenshotHash : null,
    decidedOnPens,
    remark,
    playstyleA: iAmUserA ? parsed.data.myPlaystyle : parsed.data.opponentPlaystyle,
    playstyleB: iAmUserA ? parsed.data.opponentPlaystyle : parsed.data.myPlaystyle,
    matchContext: parsed.data.matchContext,
    // Penalties are the existing decidedOnPens flag; the context column mirrors it.
    isPenalties: decidedOnPens,
    isExtraTime: parsed.data.isExtraTime,
    ...slotColumns(iAmUserA ? "A" : "B", mine),
    ...slotColumns(iAmUserA ? "B" : "A", theirs),
  } as MatchInsert;

  for (let attempt = 1; attempt <= MATCH_NO_ATTEMPTS; attempt++) {
    try {
      const [row] = await db
        .insert(matches)
        .values(values)
        .returning({ id: matches.id, matchNo: matches.matchNo });
      // Clan wars: settle any slot this confirmed match decides. Never allowed to break a save.
      await settleClanWarsForMatch(row.id).catch((err) => console.error(`[clan-wars] settle failed: ${err instanceof Error ? err.name : "unknown"}`));
      return { ok: true, matchId: row.id, matchNo: row.matchNo, opponentId };
    } catch (err) {
      const code = pgErrorCode(err);
      // 23505: both players saved at once and took the same match_no. Retry.
      if (code === "23505" && attempt < MATCH_NO_ATTEMPTS) continue;
      if (code === "23505") {
        return { ok: false, error: "Could not save the match. Please try again." };
      }
      // 23514: a CHECK constraint. Zod should have caught it already.
      if (code === "23514") {
        return {
          ok: false,
          error: "The match details are not valid. Upload the screenshot again.",
        };
      }
      throw err;
    }
  }
  return { ok: false, error: "Could not save the match. Please try again." };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** One match, oriented to the user who is looking at it. */
export type RivalryMatch = {
  id: string;
  matchNo: number;
  playedAt: string | null;
  myTeam: string;
  opponentTeam: string;
  myGoals: number;
  opponentGoals: number;
  decidedOnPens: boolean;
  outcome: MatchOutcome;
  /** "home" when the current user hosted, "away" when the opponent did. */
  venue: "home" | "away" | null;
  needsReview: boolean;
  status: "confirmed" | "pending" | "disputed";
  /** True when the current user uploaded the match. */
  createdByMe: boolean;
  /** The opponent confirmed it (or the dispute was withdrawn). */
  acknowledged: boolean;
  /** Disputed by the current user, so they may withdraw it. */
  disputedByMe: boolean;
  /** Disputed repeatedly: only an admin can decide. */
  frozen: boolean;
  remark: string | null;
};

/** Matches of an active rivalry, newest first. Empty for non-members. */
export async function getRivalryMatches(
  currentUserId: string,
  rivalryId: unknown,
  limit = 50,
): Promise<RivalryMatch[]> {
  const rivalry = await findActiveRivalry(currentUserId, rivalryId, true);
  if (!rivalry) return [];
  const iAmUserA = rivalry.userAId === currentUserId;

  const rows = await db
    .select({
      id: matches.id,
      matchNo: matches.matchNo,
      playedAt: matches.playedAt,
      hostUserId: matches.hostUserId,
      userATeam: matches.userATeam,
      userBTeam: matches.userBTeam,
      userAGoals: matches.userAGoals,
      userBGoals: matches.userBGoals,
      decidedOnPens: matches.decidedOnPens,
      needsReview: matches.needsReview,
      status: matches.status,
      createdBy: matches.createdBy,
      remark: matches.remark,
      acknowledgedAt: matches.acknowledgedAt,
      disputedBy: matches.disputedBy,
      adminReview: matches.adminReview,
    })
    .from(matches)
    .where(and(eq(matches.rivalryId, rivalry.id), isNull(matches.deletedAt)))
    .orderBy(desc(matches.matchNo))
    .limit(limit);

  return rows.map((row) => {
    const myGoals = iAmUserA ? row.userAGoals : row.userBGoals;
    const opponentGoals = iAmUserA ? row.userBGoals : row.userAGoals;
    return {
      id: row.id,
      matchNo: row.matchNo,
      playedAt: row.playedAt,
      myTeam: iAmUserA ? row.userATeam : row.userBTeam,
      opponentTeam: iAmUserA ? row.userBTeam : row.userATeam,
      myGoals,
      opponentGoals,
      decidedOnPens: row.decidedOnPens,
      needsReview: row.needsReview,
      status: row.status,
      createdByMe: row.createdBy === currentUserId,
      acknowledged: row.acknowledgedAt !== null,
      disputedByMe: row.disputedBy === currentUserId,
      frozen: row.adminReview,
      outcome: matchOutcome(myGoals, opponentGoals, row.decidedOnPens),
      venue: row.hostUserId === null ? null : row.hostUserId === currentUserId ? "home" : "away",
      remark: row.remark,
    };
  });
}

// ---------------------------------------------------------------------------
// Dispute / resolve
// ---------------------------------------------------------------------------

export type DisputeResult =
  | { ok: true; rivalryId: string; /** The other rivalry members, for notifications. */ notify: string[] }
  | { ok: false; error: string };

async function loadMatchForActor(actorId: string, isAdmin: boolean, matchId: unknown) {
  if (!isUuid(actorId) || !isUuid(matchId)) return null;
  const [row] = await db
    .select({
      id: matches.id,
      status: matches.status,
      rivalryId: matches.rivalryId,
      createdBy: matches.createdBy,
      disputeCount: matches.disputeCount,
      disputedBy: matches.disputedBy,
      adminReview: matches.adminReview,
      acknowledgedAt: matches.acknowledgedAt,
      userAId: rivalries.userAId,
      userBId: rivalries.userBId,
    })
    .from(matches)
    .innerJoin(rivalries, eq(matches.rivalryId, rivalries.id))
    .where(and(eq(matches.id, matchId), isNull(matches.deletedAt), eq(rivalries.status, "active")));
  if (!row) return null;
  if (!isAdmin && row.userAId !== actorId && row.userBId !== actorId) return null;
  return row;
}

/** After this many disputes the match is frozen for an admin: nobody else can clear it. */
export const MAX_DISPUTE_CYCLES = 3;

/**
 * The OTHER player (never the uploader) flags a confirmed match; it stops counting until resolved.
 * Admins may dispute any match. The third dispute freezes the match for admin review.
 */
export async function disputeMatch(
  actorId: string,
  isAdmin: boolean,
  matchId: unknown,
  reason?: string,
): Promise<DisputeResult> {
  const row = await loadMatchForActor(actorId, isAdmin, matchId);
  if (!row) return { ok: false, error: "Match not found" };
  if (row.status !== "confirmed") return { ok: false, error: "Only a confirmed match can be disputed" };
  if (!isAdmin && row.createdBy === actorId) {
    return { ok: false, error: "You uploaded this match. Only your opponent can dispute it." };
  }
  const note = typeof reason === "string" ? reason.trim().slice(0, 200) || null : null;
  await db
    .update(matches)
    .set({
      status: "disputed",
      needsReview: true,
      disputedBy: actorId,
      disputeCount: sql`${matches.disputeCount} + 1`,
      adminReview: sql`${matches.disputeCount} + 1 >= ${MAX_DISPUTE_CYCLES}`,
      acknowledgedAt: null,
      acknowledgedBy: null,
      ...(note ? { remark: note } : {}),
    })
    .where(and(eq(matches.id, row.id), eq(matches.status, "confirmed")));
  await settleClanWarsForMatch(row.id).catch((err) => console.error(`[clan-wars] settle failed: ${err instanceof Error ? err.name : "unknown"}`)); // reopens a clan-war slot this match had settled
  return {
    ok: true,
    rivalryId: row.rivalryId,
    notify: [row.userAId, row.userBId].filter((id) => id !== actorId),
  };
}

/**
 * Clears a dispute so the match counts again. Only the player who raised it (withdrawing it) or an
 * admin may do this; the uploader can never re-confirm their own disputed match, and a frozen match
 * (admin review) is admin-only.
 */
export async function resolveMatchDispute(
  actorId: string,
  isAdmin: boolean,
  matchId: unknown,
): Promise<DisputeResult> {
  const row = await loadMatchForActor(actorId, isAdmin, matchId);
  if (!row) return { ok: false, error: "Match not found" };
  if (row.status !== "disputed") return { ok: false, error: "This match is not disputed" };
  if (!isAdmin) {
    if (row.adminReview) return { ok: false, error: "This match has been disputed repeatedly and is waiting for an admin to decide." };
    if (row.disputedBy !== actorId) return { ok: false, error: "Only the player who disputed this match, or an admin, can clear the dispute." };
  }
  // The disputer withdrawing (or an admin ruling) is the other side's agreement: it counts as acknowledged.
  await db
    .update(matches)
    .set({ status: "confirmed", needsReview: false, adminReview: false, acknowledgedAt: new Date(), acknowledgedBy: actorId })
    .where(and(eq(matches.id, row.id), eq(matches.status, "disputed")));
  await settleClanWarsForMatch(row.id).catch((err) => console.error(`[clan-wars] settle failed: ${err instanceof Error ? err.name : "unknown"}`)); // a re-confirmed match can settle a clan-war slot
  return {
    ok: true,
    rivalryId: row.rivalryId,
    notify: [row.userAId, row.userBId].filter((id) => id !== actorId),
  };
}

/**
 * The opponent of the uploader says "yes, that is the result". It lets a clan-war slot settle
 * immediately instead of after the grace window. Idempotent.
 */
export async function acknowledgeMatch(actorId: string, matchId: unknown): Promise<DisputeResult> {
  const row = await loadMatchForActor(actorId, false, matchId);
  if (!row) return { ok: false, error: "Match not found" };
  if (row.status !== "confirmed") return { ok: false, error: "Only a confirmed match can be acknowledged" };
  if (row.createdBy === actorId) return { ok: false, error: "You uploaded this match. Your opponent confirms it." };
  await db
    .update(matches)
    .set({ acknowledgedAt: new Date(), acknowledgedBy: actorId })
    .where(and(eq(matches.id, row.id), eq(matches.status, "confirmed"), isNull(matches.acknowledgedAt)));
  await settleClanWarsForMatch(row.id).catch((err) => console.error(`[clan-wars] settle failed: ${err instanceof Error ? err.name : "unknown"}`));
  return { ok: true, rivalryId: row.rivalryId, notify: [row.createdBy].filter((id): id is string => !!id && id !== actorId) };
}
