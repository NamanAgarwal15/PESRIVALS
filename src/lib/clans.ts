// Clans: creation, roster, invites, roles and the private clan chat.
// Framework-free (no next/* imports). No LLM anywhere: text goes through the
// deterministic chat-filter. Every function takes the acting user's id from the
// server session and re-derives permissions from the database, so nothing the
// client sends can claim a role or a clan.
//
// Invariants (also enforced by the schema):
//  - a player is in at most one clan (clan_members.user_id is UNIQUE)
//  - a clan has exactly one leader, who is also a clan_members row with role 'leader'
//  - roster cap CLAN_MAX_MEMBERS, checked atomically inside the INSERT

import { and, asc, desc, eq, gt, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { clanChatMessages, clanChatReports, clanInvites, clanMembers, clans, messageBlocks, users } from "@/db/schema";
import { checkChatText } from "@/lib/chat-filter";
import { MUTED_MESSAGE, isChatMuted } from "@/lib/chat-mute";
import { pgErrorCode } from "@/lib/pg-error";
import { LIMITS, consumeRateLimit, peekRateLimit } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

export const CLAN_MAX_MEMBERS = 25;
export const CLAN_MAX_PENDING_INVITES = 10;
export const CLAN_CHAT_PAGE = 50;
export const CLAN_CHAT_RETENTION_DAYS = 14;

export type ClanRole = "leader" | "officer" | "member";
export type ClanErrorCode = "not_found" | "forbidden" | "invalid" | "conflict" | "rate_limited" | "filtered" | "muted";
export type ClanFail = { ok: false; code: ClanErrorCode; error: string };
export const clanFail = (code: ClanErrorCode, error: string): ClanFail => ({ ok: false, code, error });

const isOfficer = (role: ClanRole | null | undefined) => role === "leader" || role === "officer";

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} '_-]{1,38}[\p{L}\p{N}]$/u;
export const tagSchema = z
  .string()
  .trim()
  .transform((v) => v.toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{2,6}$/));
const createSchema = z.object({
  name: z.string().trim().transform((v) => v.replace(/\s+/g, " ")).pipe(z.string().regex(NAME_RE, "Names are 3-40 letters, numbers, spaces, - _ or '.")),
  tag: tagSchema,
  description: z.string().trim().max(200).nullish().transform((v) => v || null),
});

/** Runs user-chosen clan text through the deterministic filter. Returns the cleaned text or a failure. */
function cleanText(raw: string, what: string): { ok: true; text: string } | ClanFail {
  const r = checkChatText(raw);
  if (r.ok) return { ok: true, text: r.text };
  if (r.reason === "duplicate") return { ok: true, text: raw.trim() };
  return clanFail("filtered", `${what}: ${r.message}`);
}

// ---------------------------------------------------------------------------
// Membership helpers
// ---------------------------------------------------------------------------

export type Membership = { clanId: string; tag: string; name: string; role: ClanRole };

export async function getMembership(userId: string): Promise<Membership | null> {
  const [row] = await db
    .select({ clanId: clans.id, tag: clans.tag, name: clans.name, role: clanMembers.role })
    .from(clanMembers)
    .innerJoin(clans, eq(clans.id, clanMembers.clanId))
    .where(eq(clanMembers.userId, userId));
  return row ? { ...row, role: row.role as ClanRole } : null;
}

/** The actor's membership, but only if it is in the clan with this tag. Anything else is "not found" (no IDOR signal). */
async function memberOf(actorId: string, tag: unknown): Promise<Membership | null> {
  const t = tagSchema.safeParse(tag);
  if (!t.success) return null;
  const m = await getMembership(actorId);
  return m && m.tag === t.data ? m : null;
}

async function activeUserByName(username: unknown) {
  if (typeof username !== "string") return null;
  const [u] = await db
    .select({ id: users.id, username: users.username, onboarded: users.onboarded, suspended: users.suspended, isPlaceholder: users.isPlaceholder })
    .from(users)
    .where(eq(users.username, username.toLowerCase().slice(0, 20)));
  return u && u.onboarded && !u.suspended && !u.isPlaceholder ? u : null;
}

// ---------------------------------------------------------------------------
// Create / directory / hub
// ---------------------------------------------------------------------------

export async function createClan(actorId: string, input: unknown): Promise<{ ok: true; tag: string } | ClanFail> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) return clanFail("invalid", parsed.error.issues[0]?.message ?? "Check the clan name and tag.");
  if (await getMembership(actorId)) return clanFail("conflict", "Leave your current clan first.");

  const limited = await consumeRateLimit(`clan-create:${actorId}`, LIMITS.clanCreate.max, LIMITS.clanCreate.windowMinutes);
  if (!limited.ok) return clanFail("rate_limited", "You have created a lot of clans today. Try again tomorrow.");

  const name = cleanText(parsed.data.name, "Clan name");
  if (!name.ok) return name;
  const tag = cleanText(parsed.data.tag.split("").join(" "), "Clan tag"); // spaced so "S H I T" style tags are caught too
  if (!tag.ok) return tag;
  const desc = parsed.data.description ? cleanText(parsed.data.description, "Description") : { ok: true as const, text: null };
  if (!desc.ok) return desc;

  const clanId = crypto.randomUUID();
  try {
    // Atomic: the clan and its leader membership exist together or not at all.
    await db.batch([
      db.insert(clans).values({ id: clanId, name: name.text, tag: parsed.data.tag, description: desc.text, leaderId: actorId }),
      db.insert(clanMembers).values({ clanId, userId: actorId, role: "leader" }),
    ]);
  } catch (err) {
    if (pgErrorCode(err) === "23505") return clanFail("conflict", "That clan name or tag is already taken.");
    throw err;
  }
  return { ok: true, tag: parsed.data.tag };
}

export type ClanSummary = { tag: string; name: string; description: string | null; members: number };

export async function listClans(query?: unknown): Promise<ClanSummary[]> {
  const q = typeof query === "string" ? query.trim().slice(0, 40).replace(/[%_\\]/g, (c) => `\\${c}`) : "";
  const rows = await db
    .select({
      tag: clans.tag, name: clans.name, description: clans.description,
      members: sql<number>`(SELECT count(*)::int FROM clan_members m WHERE m.clan_id = ${clans.id})`,
    })
    .from(clans)
    .where(q ? sql`(${clans.name} ILIKE ${`%${q}%`} OR ${clans.tag} ILIKE ${`%${q}%`})` : undefined)
    .orderBy(desc(sql`(SELECT count(*) FROM clan_members m WHERE m.clan_id = ${clans.id})`), asc(clans.name))
    .limit(30);
  return rows;
}

export type ClanHub = {
  clan: { id: string; tag: string; name: string; description: string | null };
  myRole: ClanRole | null;
  members: { username: string; displayName: string; role: ClanRole; joinedAt: string }[];
  invites: { username: string }[]; // officers only
};

export async function getClanHub(viewerId: string, tag: unknown): Promise<ClanHub | null> {
  const t = tagSchema.safeParse(tag);
  if (!t.success) return null;
  const [clan] = await db.select({ id: clans.id, tag: clans.tag, name: clans.name, description: clans.description }).from(clans).where(eq(clans.tag, t.data));
  if (!clan) return null;
  const rows = await db
    .select({ userId: clanMembers.userId, role: clanMembers.role, joinedAt: clanMembers.joinedAt, username: users.username, displayName: users.displayName })
    .from(clanMembers)
    .innerJoin(users, eq(users.id, clanMembers.userId))
    .where(eq(clanMembers.clanId, clan.id))
    .orderBy(asc(clanMembers.joinedAt))
    .limit(CLAN_MAX_MEMBERS);
  const mine = rows.find((r) => r.userId === viewerId);
  const myRole = (mine?.role as ClanRole | undefined) ?? null;
  let invites: { username: string }[] = [];
  if (isOfficer(myRole)) {
    invites = await db
      .select({ username: users.username })
      .from(clanInvites)
      .innerJoin(users, eq(users.id, clanInvites.userId))
      .where(and(eq(clanInvites.clanId, clan.id), eq(clanInvites.status, "pending")))
      .limit(CLAN_MAX_PENDING_INVITES);
  }
  return {
    clan,
    myRole,
    invites,
    members: rows.map((r) => ({
      username: r.username, displayName: r.displayName, role: r.role as ClanRole, joinedAt: r.joinedAt.toISOString(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

export async function inviteToClan(actorId: string, tag: unknown, username: unknown): Promise<{ ok: true } | ClanFail> {
  const me = await memberOf(actorId, tag);
  if (!me) return clanFail("not_found", "Clan not found.");
  if (!isOfficer(me.role)) return clanFail("forbidden", "Only the leader or an officer can invite players.");

  const limited = await consumeRateLimit(`clan-invite:${actorId}`, LIMITS.clanInvite.max, LIMITS.clanInvite.windowMinutes);
  if (!limited.ok) return clanFail("rate_limited", "You have sent a lot of invites. Try again later.");

  const target = await activeUserByName(username);
  if (!target) return clanFail("not_found", "Player not found.");
  if (await getMembership(target.id)) return clanFail("conflict", "That player is already in a clan.");

  const [{ members }] = await db.select({ members: sql<number>`count(*)::int` }).from(clanMembers).where(eq(clanMembers.clanId, me.clanId));
  const [{ pending }] = await db.select({ pending: sql<number>`count(*)::int` }).from(clanInvites).where(and(eq(clanInvites.clanId, me.clanId), eq(clanInvites.status, "pending")));
  if (members >= CLAN_MAX_MEMBERS) return clanFail("conflict", "Your clan roster is full.");
  if (pending >= CLAN_MAX_PENDING_INVITES) return clanFail("conflict", "Too many invites are waiting. Wait for answers or cancel some.");
  const [theirs] = await db.select({ n: sql<number>`count(*)::int` }).from(clanInvites).where(and(eq(clanInvites.userId, target.id), eq(clanInvites.status, "pending")));
  if (theirs.n >= 20) return clanFail("conflict", "That player has too many open invites.");

  try {
    await db.insert(clanInvites).values({ clanId: me.clanId, userId: target.id, invitedBy: actorId });
  } catch (err) {
    if (pgErrorCode(err) === "23505") return clanFail("conflict", "That player is already invited.");
    throw err;
  }
  return { ok: true };
}

export type MyInvite = { id: string; clanTag: string; clanName: string };

export async function listMyInvites(userId: string): Promise<MyInvite[]> {
  return db
    .select({ id: clanInvites.id, clanTag: clans.tag, clanName: clans.name })
    .from(clanInvites)
    .innerJoin(clans, eq(clans.id, clanInvites.clanId))
    .where(and(eq(clanInvites.userId, userId), eq(clanInvites.status, "pending")))
    .orderBy(desc(clanInvites.createdAt))
    .limit(20);
}

/** Only the invited player can answer. Accepting joins atomically unless the roster is full. */
export async function respondToInvite(actorId: string, inviteId: unknown, accept: boolean): Promise<{ ok: true; tag?: string } | ClanFail> {
  const id = z.uuid().safeParse(inviteId);
  if (!id.success) return clanFail("not_found", "Invite not found.");
  const [invite] = await db
    .select({ id: clanInvites.id, clanId: clanInvites.clanId, tag: clans.tag })
    .from(clanInvites)
    .innerJoin(clans, eq(clans.id, clanInvites.clanId))
    .where(and(eq(clanInvites.id, id.data), eq(clanInvites.userId, actorId), eq(clanInvites.status, "pending")));
  if (!invite) return clanFail("not_found", "Invite not found.");

  if (!accept) {
    await db.update(clanInvites).set({ status: "declined" }).where(eq(clanInvites.id, invite.id));
    return { ok: true };
  }
  if (await getMembership(actorId)) return clanFail("conflict", "Leave your current clan first.");
  try {
    // The cap is checked inside the INSERT so two simultaneous accepts cannot both squeeze past it.
    const res = await db.execute(sql`
      INSERT INTO clan_members (clan_id, user_id, role)
      SELECT ${invite.clanId}::uuid, ${actorId}::uuid, 'member'
      WHERE (SELECT count(*) FROM clan_members WHERE clan_id = ${invite.clanId}::uuid) < ${CLAN_MAX_MEMBERS}
      RETURNING user_id`);
    const rows = (res as unknown as { rows?: unknown[] }).rows ?? [];
    if (!rows.length) return clanFail("conflict", "That clan is full.");
  } catch (err) {
    if (pgErrorCode(err) === "23505") return clanFail("conflict", "Leave your current clan first.");
    throw err;
  }
  await db.update(clanInvites).set({ status: "accepted" }).where(eq(clanInvites.id, invite.id));
  // Any other open invites for this player are now moot.
  await db.update(clanInvites).set({ status: "declined" }).where(and(eq(clanInvites.userId, actorId), eq(clanInvites.status, "pending")));
  return { ok: true, tag: invite.tag };
}

// ---------------------------------------------------------------------------
// Roster management
// ---------------------------------------------------------------------------

async function rosterEntry(clanId: string, username: unknown) {
  if (typeof username !== "string") return null;
  const [row] = await db
    .select({ userId: clanMembers.userId, role: clanMembers.role })
    .from(clanMembers)
    .innerJoin(users, eq(users.id, clanMembers.userId))
    .where(and(eq(clanMembers.clanId, clanId), eq(users.username, username.toLowerCase().slice(0, 20))));
  return row ? { userId: row.userId, role: row.role as ClanRole } : null;
}

/** Leader kicks anyone but themself; an officer kicks plain members only. */
export async function kickMember(actorId: string, tag: unknown, username: unknown): Promise<{ ok: true } | ClanFail> {
  const me = await memberOf(actorId, tag);
  if (!me) return clanFail("not_found", "Clan not found.");
  if (!isOfficer(me.role)) return clanFail("forbidden", "Only the leader or an officer can remove players.");
  const target = await rosterEntry(me.clanId, username);
  if (!target) return clanFail("not_found", "Player not found in your clan.");
  if (target.userId === actorId) return clanFail("invalid", "Use Leave clan instead.");
  if (target.role === "leader" || (me.role === "officer" && target.role !== "member")) return clanFail("forbidden", "You cannot remove that player.");
  await db.delete(clanMembers).where(and(eq(clanMembers.clanId, me.clanId), eq(clanMembers.userId, target.userId)));
  return { ok: true };
}

/** Leader only: promote a member to officer or demote an officer. */
export async function setMemberRole(actorId: string, tag: unknown, username: unknown, role: unknown): Promise<{ ok: true } | ClanFail> {
  const me = await memberOf(actorId, tag);
  if (!me) return clanFail("not_found", "Clan not found.");
  if (me.role !== "leader") return clanFail("forbidden", "Only the leader can change roles.");
  const next = z.enum(["officer", "member"]).safeParse(role);
  if (!next.success) return clanFail("invalid", "Choose officer or member.");
  const target = await rosterEntry(me.clanId, username);
  if (!target || target.role === "leader") return clanFail("not_found", "Player not found in your clan.");
  await db.update(clanMembers).set({ role: next.data }).where(and(eq(clanMembers.clanId, me.clanId), eq(clanMembers.userId, target.userId)));
  return { ok: true };
}

/** Leader hands the clan to another member; the old leader becomes an officer. Atomic. */
export async function transferLeadership(actorId: string, tag: unknown, username: unknown): Promise<{ ok: true } | ClanFail> {
  const me = await memberOf(actorId, tag);
  if (!me) return clanFail("not_found", "Clan not found.");
  if (me.role !== "leader") return clanFail("forbidden", "Only the leader can transfer leadership.");
  const target = await rosterEntry(me.clanId, username);
  if (!target || target.userId === actorId) return clanFail("not_found", "Player not found in your clan.");
  await db.batch([
    db.update(clanMembers).set({ role: "officer" }).where(and(eq(clanMembers.clanId, me.clanId), eq(clanMembers.userId, actorId))),
    db.update(clanMembers).set({ role: "leader" }).where(and(eq(clanMembers.clanId, me.clanId), eq(clanMembers.userId, target.userId))),
    db.update(clans).set({ leaderId: target.userId }).where(eq(clans.id, me.clanId)),
  ]);
  return { ok: true };
}

/** Leaves the clan. A leader must hand over first, unless they are the only member (then the clan is disbanded). */
export async function leaveClan(actorId: string): Promise<{ ok: true } | ClanFail> {
  const me = await getMembership(actorId);
  if (!me) return clanFail("not_found", "You are not in a clan.");
  if (me.role === "leader") {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(clanMembers).where(eq(clanMembers.clanId, me.clanId));
    if (n > 1) return clanFail("conflict", "Transfer leadership before leaving.");
    await db.delete(clans).where(eq(clans.id, me.clanId));
    return { ok: true };
  }
  await db.delete(clanMembers).where(and(eq(clanMembers.clanId, me.clanId), eq(clanMembers.userId, actorId)));
  return { ok: true };
}

export async function disbandClan(actorId: string, tag: unknown): Promise<{ ok: true } | ClanFail> {
  const me = await memberOf(actorId, tag);
  if (!me) return clanFail("not_found", "Clan not found.");
  if (me.role !== "leader") return clanFail("forbidden", "Only the leader can disband the clan.");
  await db.delete(clans).where(eq(clans.id, me.clanId)); // cascades to members, invites, chat, wars
  return { ok: true };
}

/** Account deletion: step out of any clan, handing leadership to the longest-serving member (or disbanding if alone). */
export async function removeUserFromClan(userId: string): Promise<void> {
  const me = await getMembership(userId);
  if (!me) return;
  if (me.role === "leader") {
    const [next] = await db
      .select({ userId: clanMembers.userId })
      .from(clanMembers)
      .where(and(eq(clanMembers.clanId, me.clanId), sql`${clanMembers.userId} <> ${userId}`))
      .orderBy(sql`(${clanMembers.role} = 'officer') DESC`, asc(clanMembers.joinedAt))
      .limit(1);
    if (!next) {
      await db.delete(clans).where(eq(clans.id, me.clanId));
      return;
    }
    await db.batch([
      db.update(clanMembers).set({ role: "leader" }).where(and(eq(clanMembers.clanId, me.clanId), eq(clanMembers.userId, next.userId))),
      db.update(clans).set({ leaderId: next.userId }).where(eq(clans.id, me.clanId)),
      db.delete(clanMembers).where(and(eq(clanMembers.clanId, me.clanId), eq(clanMembers.userId, userId))),
    ]);
    return;
  }
  await db.delete(clanMembers).where(eq(clanMembers.userId, userId));
}

// ---------------------------------------------------------------------------
// Private clan chat (members only)
// ---------------------------------------------------------------------------

export type ClanMessage = { id: string; mine: boolean; username: string; displayName: string; body: string; createdAt: string };

export async function getClanMessages(actorId: string, tag: unknown): Promise<{ ok: true; messages: ClanMessage[] } | ClanFail> {
  const me = await memberOf(actorId, tag);
  if (!me) return clanFail("not_found", "Clan not found."); // non-members learn nothing
  const rows = await db
    .select({
      id: clanChatMessages.id, senderId: clanChatMessages.senderId, body: clanChatMessages.body, createdAt: clanChatMessages.createdAt,
      username: users.username, displayName: users.displayName,
    })
    .from(clanChatMessages)
    .innerJoin(users, eq(users.id, clanChatMessages.senderId))
    .where(
      and(
        eq(clanChatMessages.clanId, me.clanId),
        eq(clanChatMessages.hidden, false),
        gt(clanChatMessages.createdAt, new Date(Date.now() - CLAN_CHAT_RETENTION_DAYS * 86_400_000)),
        // Phase 7B: messages from someone you blocked stay hidden here too. Challenges are unaffected.
        notExists(
          db.select({ one: sql`1` }).from(messageBlocks).where(and(eq(messageBlocks.blockerId, actorId), eq(messageBlocks.blockedId, clanChatMessages.senderId))),
        ),
      ),
    )
    .orderBy(desc(clanChatMessages.createdAt))
    .limit(CLAN_CHAT_PAGE);
  return {
    ok: true,
    messages: rows.reverse().map((r) => ({
      id: r.id, mine: r.senderId === actorId, username: r.username, displayName: r.displayName, body: r.body, createdAt: r.createdAt.toISOString(),
    })),
  };
}

const CLAN_STRIKE = { max: 5, windowMinutes: 10 } as const;

export async function sendClanMessage(actorId: string, tag: unknown, body: unknown, ip: string | null = null): Promise<{ ok: true; message: ClanMessage } | ClanFail> {
  const me = await memberOf(actorId, tag);
  if (!me) return clanFail("not_found", "Clan not found.");
  if (await isChatMuted(actorId)) return clanFail("muted", MUTED_MESSAGE);

  const strikes = await peekRateLimit(`clan-strike:${actorId}`, CLAN_STRIKE.max, CLAN_STRIKE.windowMinutes);
  if (strikes.used >= CLAN_STRIKE.max) return clanFail("rate_limited", "Too many blocked messages. Take a short break and try again.");
  const user = await consumeRateLimit(`clan-chat:${actorId}`, LIMITS.clanChatUser.max, LIMITS.clanChatUser.windowMinutes);
  const net = ip ? await consumeRateLimit(`clan-chat-ip:${ip}`, LIMITS.clanChatIp.max, LIMITS.clanChatIp.windowMinutes) : { ok: true };
  if (!user.ok || !net.ok) return clanFail("rate_limited", "You are sending messages too fast. Slow down for a minute.");

  const recent = await db
    .select({ body: clanChatMessages.body })
    .from(clanChatMessages)
    .where(and(eq(clanChatMessages.senderId, actorId), gt(clanChatMessages.createdAt, new Date(Date.now() - 120_000))))
    .orderBy(desc(clanChatMessages.createdAt))
    .limit(5);
  const verdict = checkChatText(body, recent.map((r) => r.body));
  if (!verdict.ok) {
    if (verdict.reason !== "empty" && verdict.reason !== "too_long") {
      await consumeRateLimit(`clan-strike:${actorId}`, CLAN_STRIKE.max, CLAN_STRIKE.windowMinutes);
      securityLog("chat_denied", { userId: actorId, reason: verdict.reason, scope: "clan" });
    }
    return clanFail(verdict.reason === "empty" || verdict.reason === "too_long" ? "invalid" : "filtered", verdict.message);
  }
  const [row] = await db
    .insert(clanChatMessages)
    .values({ clanId: me.clanId, senderId: actorId, body: verdict.text })
    .returning({ id: clanChatMessages.id, body: clanChatMessages.body, createdAt: clanChatMessages.createdAt });
  const [u] = await db.select({ username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, actorId));
  return { ok: true, message: { id: row.id, mine: true, username: u?.username ?? "", displayName: u?.displayName ?? "", body: row.body, createdAt: row.createdAt.toISOString() } };
}

export async function pruneClanChat(): Promise<void> {
  await db.delete(clanChatMessages).where(
    and(
      lt(clanChatMessages.createdAt, new Date(Date.now() - CLAN_CHAT_RETENTION_DAYS * 86_400_000)),
      // Messages under an open report are kept for the admin queue.
      notExists(
        db.select({ one: sql`1` }).from(clanChatReports).where(and(eq(clanChatReports.clanMessageId, clanChatMessages.id), eq(clanChatReports.status, "open"))),
      ),
    ),
  );
}

export async function maybePruneClanChat(random: number = Math.random()): Promise<void> {
  if (random >= 0.02) return;
  try {
    await pruneClanChat();
  } catch (err) {
    securityLog("request_failed", { route: "clan_chat_prune", error: err instanceof Error ? err.name : "unknown" }, "error");
  }
}

