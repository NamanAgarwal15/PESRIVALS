// Global lobby chat, reporting and pruning. Framework-free (Vitest drives it directly).
// Moderation is 100% deterministic (chat-filter.ts): no LLM and no AI quota involved.
//
//  - Callers are authenticated and non-suspended (apiUser) before reaching here.
//  - Refused (filtered) messages are never stored.
//  - Phase 7B message_blocks are respected: if A blocked messages from B, B's lobby
//    messages are hidden from A. Challenges are not touched.

import { and, desc, eq, gt, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { chatReports, clanChatMessages, clanChatReports, dmMessages, globalChatMessages, messageBlocks, users } from "@/db/schema";
import { checkChatText } from "@/lib/chat-filter";
import { MUTED_MESSAGE, isChatMuted } from "@/lib/chat-mute";
import { getMembership } from "@/lib/clans";
import { resolvePeer } from "@/lib/dm-chat";
import { LIMITS, consumeRateLimit, peekRateLimit } from "@/lib/rate-limit";
import { canonicalPair } from "@/lib/rivalry-helpers";
import { securityLog } from "@/lib/security-log";

export const GLOBAL_PAGE_SIZE = 50;
export const GLOBAL_RETENTION_HOURS = 72;
export const REPORT_REASONS = ["spam", "harassment", "hate", "links", "other"] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];

export type GlobalErrorCode = "not_found" | "rate_limited" | "invalid" | "filtered" | "muted";
export type GlobalFail = { ok: false; code: GlobalErrorCode; error: string };
const fail = (code: GlobalErrorCode, error: string): GlobalFail => ({ ok: false, code, error });

export type GlobalMessage = {
  id: string;
  mine: boolean;
  username: string;
  displayName: string;
  body: string;
  createdAt: string;
};

const retentionCutoff = () => new Date(Date.now() - GLOBAL_RETENTION_HOURS * 3_600_000);

/** Newest `GLOBAL_PAGE_SIZE` visible messages, oldest first. Hidden, expired, suspended-sender and blocked-by-me rows are excluded. */
export async function getGlobalMessages(meId: string): Promise<GlobalMessage[]> {
  const rows = await db
    .select({
      id: globalChatMessages.id,
      senderId: globalChatMessages.senderId,
      body: globalChatMessages.body,
      createdAt: globalChatMessages.createdAt,
      username: users.username,
      displayName: users.displayName,
    })
    .from(globalChatMessages)
    .innerJoin(users, eq(users.id, globalChatMessages.senderId))
    .where(
      and(
        eq(globalChatMessages.hidden, false),
        eq(users.suspended, false),
        gt(globalChatMessages.createdAt, retentionCutoff()),
        notExists(
          db
            .select({ one: sql`1` })
            .from(messageBlocks)
            .where(and(eq(messageBlocks.blockerId, meId), eq(messageBlocks.blockedId, globalChatMessages.senderId))),
        ),
      ),
    )
    .orderBy(desc(globalChatMessages.createdAt))
    .limit(GLOBAL_PAGE_SIZE);
  return rows.reverse().map((r) => ({
    id: r.id,
    mine: r.senderId === meId,
    username: r.username,
    displayName: r.displayName,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
  }));
}

const STRIKE = { max: 5, windowMinutes: 10 } as const;

export async function sendGlobalMessage(
  meId: string,
  body: unknown,
  ip: string | null = null,
): Promise<{ ok: true; message: GlobalMessage } | GlobalFail> {
  if (await isChatMuted(meId)) return fail("muted", MUTED_MESSAGE);
  // Cool-off after repeated filtered attempts (checked first, costs nothing).
  const strikes = await peekRateLimit(`gc-strike:${meId}`, STRIKE.max, STRIKE.windowMinutes);
  if (strikes.used >= STRIKE.max) return fail("rate_limited", "Too many blocked messages. Take a short break and try again.");

  const user = await consumeRateLimit(`gc:${meId}`, LIMITS.globalUser.max, LIMITS.globalUser.windowMinutes);
  const net = ip ? await consumeRateLimit(`gc-ip:${ip}`, LIMITS.globalIp.max, LIMITS.globalIp.windowMinutes) : { ok: true };
  if (!user.ok || !net.ok) return fail("rate_limited", "You are sending messages too fast. Slow down for a minute.");

  const recent = await db
    .select({ body: globalChatMessages.body })
    .from(globalChatMessages)
    .where(and(eq(globalChatMessages.senderId, meId), gt(globalChatMessages.createdAt, new Date(Date.now() - 120_000))))
    .orderBy(desc(globalChatMessages.createdAt))
    .limit(5);

  const verdict = checkChatText(body, recent.map((r) => r.body));
  if (!verdict.ok) {
    if (verdict.reason !== "empty" && verdict.reason !== "too_long") {
      await consumeRateLimit(`gc-strike:${meId}`, STRIKE.max, STRIKE.windowMinutes);
      securityLog("chat_denied", { userId: meId, reason: verdict.reason });
    }
    return fail(verdict.reason === "empty" || verdict.reason === "too_long" ? "invalid" : "filtered", verdict.message);
  }

  const [row] = await db
    .insert(globalChatMessages)
    .values({ senderId: meId, body: verdict.text })
    .returning({ id: globalChatMessages.id, body: globalChatMessages.body, createdAt: globalChatMessages.createdAt });
  const [me] = await db.select({ username: users.username, displayName: users.displayName }).from(users).where(eq(users.id, meId));
  return {
    ok: true,
    message: { id: row.id, mine: true, username: me?.username ?? "", displayName: me?.displayName ?? "", body: row.body, createdAt: row.createdAt.toISOString() },
  };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const reportSchema = z.object({ messageId: z.uuid(), reason: z.enum(REPORT_REASONS) });

async function reportLimits(meId: string, ip: string | null): Promise<GlobalFail | null> {
  const user = await consumeRateLimit(`report:${meId}`, LIMITS.reportUser.max, LIMITS.reportUser.windowMinutes);
  const net = ip ? await consumeRateLimit(`report-ip:${ip}`, LIMITS.reportIp.max, LIMITS.reportIp.windowMinutes) : { ok: true };
  return user.ok && net.ok ? null : fail("rate_limited", "You have sent a lot of reports. Try again later.");
}

/** Reports a lobby message. Idempotent (one report per reporter per message). */
export async function reportGlobalMessage(meId: string, input: unknown, ip: string | null = null): Promise<{ ok: true } | GlobalFail> {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return fail("invalid", "Choose a reason for the report.");
  const limited = await reportLimits(meId, ip);
  if (limited) return limited;

  const [msg] = await db
    .select({ id: globalChatMessages.id, senderId: globalChatMessages.senderId })
    .from(globalChatMessages)
    .where(eq(globalChatMessages.id, parsed.data.messageId));
  if (!msg) return fail("not_found", "Message not found.");
  if (msg.senderId === meId) return fail("invalid", "You cannot report your own message.");

  await db
    .insert(chatReports)
    .values({ reporterId: meId, reportedUserId: msg.senderId, globalMessageId: msg.id, reason: parsed.data.reason })
    .onConflictDoNothing();
  return { ok: true };
}

/** Reports a message the OTHER player sent you in your 1v1 thread. */
export async function reportDmMessage(meId: string, username: unknown, input: unknown, ip: string | null = null): Promise<{ ok: true } | GlobalFail> {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return fail("invalid", "Choose a reason for the report.");
  const peer = await resolvePeer(meId, username);
  if (!peer) return fail("not_found", "Message not found.");
  const limited = await reportLimits(meId, ip);
  if (limited) return limited;

  const [a, b] = canonicalPair(meId, peer.id);
  const [msg] = await db
    .select({ id: dmMessages.id })
    .from(dmMessages)
    .where(and(eq(dmMessages.id, parsed.data.messageId), eq(dmMessages.userAId, a), eq(dmMessages.userBId, b), eq(dmMessages.senderId, peer.id)));
  if (!msg) return fail("not_found", "Message not found.");

  await db
    .insert(chatReports)
    .values({ reporterId: meId, reportedUserId: peer.id, dmMessageId: msg.id, reason: parsed.data.reason })
    .onConflictDoNothing();
  return { ok: true };
}

/** Reports a message in YOUR OWN clan's private chat. Anyone outside the clan gets "not found". */
export async function reportClanMessage(meId: string, tag: unknown, input: unknown, ip: string | null = null): Promise<{ ok: true } | GlobalFail> {
  const parsed = reportSchema.safeParse(input);
  if (!parsed.success) return fail("invalid", "Choose a reason for the report.");
  const mine = await getMembership(meId);
  if (!mine || typeof tag !== "string" || mine.tag !== tag.toUpperCase().slice(0, 6)) return fail("not_found", "Message not found.");
  const limited = await reportLimits(meId, ip);
  if (limited) return limited;

  const [msg] = await db
    .select({ id: clanChatMessages.id, senderId: clanChatMessages.senderId })
    .from(clanChatMessages)
    .where(and(eq(clanChatMessages.id, parsed.data.messageId), eq(clanChatMessages.clanId, mine.clanId)));
  if (!msg) return fail("not_found", "Message not found.");
  if (msg.senderId === meId) return fail("invalid", "You cannot report your own message.");
  await db
    .insert(clanChatReports)
    .values({ reporterId: meId, reportedUserId: msg.senderId, clanMessageId: msg.id, reason: parsed.data.reason })
    .onConflictDoNothing();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pruning
// ---------------------------------------------------------------------------

/** Deletes expired lobby rows, except ones an open report still points at. */
export async function pruneGlobalChat(): Promise<void> {
  await db.delete(globalChatMessages).where(
    and(
      lt(globalChatMessages.createdAt, retentionCutoff()),
      notExists(
        db
          .select({ one: sql`1` })
          .from(chatReports)
          .where(and(eq(chatReports.globalMessageId, globalChatMessages.id), eq(chatReports.status, "open"))),
      ),
    ),
  );
}

/** ~2% of sends trigger cleanup, so there is no cron to set up. */
export async function maybePruneGlobalChat(random: number = Math.random()): Promise<void> {
  if (random >= 0.02) return;
  try {
    await pruneGlobalChat();
  } catch (err) {
    securityLog("request_failed", { route: "global_chat_prune", error: err instanceof Error ? err.name : "unknown" }, "error");
  }
}
