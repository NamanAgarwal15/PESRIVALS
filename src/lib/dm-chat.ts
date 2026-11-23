// 1v1 player chat. Framework-free (no next/* imports) so Vitest drives it directly.
//
// Security model:
//  - A thread is never addressed by an id from the client. It is the canonical
//    pair (session user, other player), so nobody can name someone else's thread.
//  - Every call re-checks both accounts in the database (exists, onboarded, not
//    suspended, not a placeholder).
//  - "Block Msgs Only (Keep Challenge Open)": a blocker stops receiving messages
//    from the blocked player. Only THIS file reads message_blocks; rivalry and
//    challenge code never does, so challenges stay fully open.
//  - Bodies are plain text: control and bidi/zero-width characters are removed
//    and the UI renders them as text nodes. No LLM touches chat.

import { and, desc, eq, gt, inArray, lt, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { chatReports, dmMessages, messageBlocks, users } from "@/db/schema";
import { checkChatText } from "@/lib/chat-filter";
import { MUTED_MESSAGE, isChatMuted } from "@/lib/chat-mute";
import { LIMITS, consumeRateLimit, peekRateLimit } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";
import { canonicalPair } from "@/lib/rivalry-helpers";

export const DM_MAX_LENGTH = 500;
export const DM_PAGE_SIZE = 50;
export const DM_RETENTION_DAYS = 30;
const DM_STRIKE = { max: 5, windowMinutes: 10 } as const;

export type DmErrorCode = "not_found" | "blocked" | "rate_limited" | "invalid" | "muted" | "filtered";
export type DmFail = { ok: false; code: DmErrorCode; error: string };
const fail = (code: DmErrorCode, error: string): DmFail => ({ ok: false, code, error });

const usernameSchema = z.string().regex(/^[a-z0-9_]{3,20}$/);

// Controls, zero-width, bidi overrides/isolates and the BOM. Newlines and tabs become spaces/newlines below.
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f​-‏‪-‮⁠-⁩﻿]/g;

export function cleanMessage(raw: string): string {
  return raw
    .normalize("NFC")
    .replace(UNSAFE_CHARS, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export const messageBodySchema = z
  .string()
  .max(DM_MAX_LENGTH * 4) // cheap pre-check before cleaning
  .transform(cleanMessage)
  .pipe(z.string().min(1, "Write a message first.").max(DM_MAX_LENGTH, `Keep messages under ${DM_MAX_LENGTH} characters.`));

type Peer = { id: string; username: string; displayName: string };

/** The other player, only if they can be chatted with at all. Same answer for "missing" and "suspended". */
export async function resolvePeer(meId: string, username: unknown): Promise<Peer | null> {
  const parsed = usernameSchema.safeParse(typeof username === "string" ? username.toLowerCase() : "");
  if (!parsed.success) return null;
  const rows = await db
    .select({
      id: users.id, username: users.username, displayName: users.displayName,
      onboarded: users.onboarded, suspended: users.suspended, isPlaceholder: users.isPlaceholder,
    })
    .from(users)
    .where(inArray(users.username, [parsed.data]));
  const peer = rows[0];
  if (!peer || peer.id === meId || peer.suspended || !peer.onboarded || peer.isPlaceholder) return null;
  return { id: peer.id, username: peer.username, displayName: peer.displayName };
}

async function blockState(meId: string, peerId: string) {
  const rows = await db
    .select({ blockerId: messageBlocks.blockerId })
    .from(messageBlocks)
    .where(
      sql`(${messageBlocks.blockerId} = ${meId} AND ${messageBlocks.blockedId} = ${peerId})
       OR (${messageBlocks.blockerId} = ${peerId} AND ${messageBlocks.blockedId} = ${meId})`,
    );
  return {
    iBlockedThem: rows.some((r) => r.blockerId === meId),
    theyBlockedMe: rows.some((r) => r.blockerId === peerId),
  };
}

export type DmMessage = { id: string; mine: boolean; body: string; createdAt: string };
export type DmThread = {
  peer: Peer;
  messages: DmMessage[];
  iBlockedThem: boolean;
  theyBlockedMe: boolean;
};

/** Newest `DM_PAGE_SIZE` messages (oldest first). `after` returns only newer ones for polling. */
export async function getThread(
  meId: string,
  username: unknown,
  after?: unknown,
): Promise<{ ok: true; thread: DmThread } | DmFail> {
  const peer = await resolvePeer(meId, username);
  if (!peer) return fail("not_found", "Player not found.");
  const [a, b] = canonicalPair(meId, peer.id);
  const state = await blockState(meId, peer.id);

  const afterDate = typeof after === "string" && after ? new Date(after) : null;
  const rows = await db
    .select({ id: dmMessages.id, senderId: dmMessages.senderId, body: dmMessages.body, createdAt: dmMessages.createdAt })
    .from(dmMessages)
    .where(
      and(
        eq(dmMessages.userAId, a),
        eq(dmMessages.userBId, b),
        afterDate && !Number.isNaN(afterDate.getTime()) ? gt(dmMessages.createdAt, afterDate) : undefined,
        // Blocker never sees the blocked player's messages (past or future).
        state.iBlockedThem ? eq(dmMessages.senderId, meId) : undefined,
      ),
    )
    .orderBy(desc(dmMessages.createdAt))
    .limit(DM_PAGE_SIZE);

  return {
    ok: true,
    thread: {
      peer,
      ...state,
      messages: rows.reverse().map((r) => ({
        id: r.id,
        mine: r.senderId === meId,
        body: r.body,
        createdAt: r.createdAt.toISOString(),
      })),
    },
  };
}

export async function sendMessage(
  meId: string,
  username: unknown,
  body: unknown,
  ip: string | null = null,
): Promise<{ ok: true; message: DmMessage } | DmFail> {
  const text = messageBodySchema.safeParse(body);
  if (!text.success) return fail("invalid", text.error.issues[0]?.message ?? "Invalid message.");

  const peer = await resolvePeer(meId, username);
  if (!peer) return fail("not_found", "Player not found.");
  if (await isChatMuted(meId)) return fail("muted", MUTED_MESSAGE);

  // Cool-off after repeated filtered attempts (free to check).
  const strikes = await peekRateLimit(`dm-strike:${meId}`, DM_STRIKE.max, DM_STRIKE.windowMinutes);
  if (strikes.used >= DM_STRIKE.max) return fail("rate_limited", "Too many blocked messages. Take a short break and try again.");

  // Refused sends and bad bodies cost nothing; real attempts are counted per user and per IP.
  const user = await consumeRateLimit(`dm:${meId}`, LIMITS.dmUser.max, LIMITS.dmUser.windowMinutes);
  const net = ip ? await consumeRateLimit(`dm-ip:${ip}`, LIMITS.dmIp.max, LIMITS.dmIp.windowMinutes) : { ok: true };
  if (!user.ok || !net.ok) return fail("rate_limited", "You are sending messages too fast. Slow down for a few minutes.");

  // Same deterministic filter as the lobby (links, abuse, floods, duplicates), with the DM length limit.
  // The stored text keeps line breaks; the filter only judges it.
  const [a0, b0] = canonicalPair(meId, peer.id);
  const recent = await db
    .select({ body: dmMessages.body })
    .from(dmMessages)
    .where(and(eq(dmMessages.userAId, a0), eq(dmMessages.userBId, b0), eq(dmMessages.senderId, meId), gt(dmMessages.createdAt, new Date(Date.now() - 120_000))))
    .orderBy(desc(dmMessages.createdAt))
    .limit(5);
  const verdict = checkChatText(text.data, recent.map((r) => r.body), DM_MAX_LENGTH);
  if (!verdict.ok) {
    if (verdict.reason !== "empty" && verdict.reason !== "too_long") {
      await consumeRateLimit(`dm-strike:${meId}`, DM_STRIKE.max, DM_STRIKE.windowMinutes);
      securityLog("chat_denied", { userId: meId, reason: verdict.reason, scope: "dm" });
    }
    return fail(verdict.reason === "empty" || verdict.reason === "too_long" ? "invalid" : "filtered", verdict.message);
  }

  const state = await blockState(meId, peer.id);
  if (state.theyBlockedMe) return fail("blocked", "This player is not accepting messages. You can still challenge them.");
  if (state.iBlockedThem) return fail("blocked", "You blocked messages from this player. Unblock them to chat.");

  const [a, b] = canonicalPair(meId, peer.id);
  const [row] = await db
    .insert(dmMessages)
    .values({ userAId: a, userBId: b, senderId: meId, body: text.data })
    .returning({ id: dmMessages.id, body: dmMessages.body, createdAt: dmMessages.createdAt });
  return { ok: true, message: { id: row.id, mine: true, body: row.body, createdAt: row.createdAt.toISOString() } };
}

/** Blocks or unblocks messages from `username`. Never touches rivalries or challenges. */
export async function setMessageBlock(
  meId: string,
  username: unknown,
  blocked: boolean,
): Promise<{ ok: true; blocked: boolean } | DmFail> {
  const peer = await resolvePeer(meId, username);
  if (!peer) return fail("not_found", "Player not found.");
  if (blocked) {
    await db.insert(messageBlocks).values({ blockerId: meId, blockedId: peer.id }).onConflictDoNothing();
  } else {
    await db.delete(messageBlocks).where(and(eq(messageBlocks.blockerId, meId), eq(messageBlocks.blockedId, peer.id)));
  }
  return { ok: true, blocked };
}

/** Deletes 1v1 messages older than the retention window, except ones an open report still points at. */
export async function pruneDmMessages(): Promise<void> {
  await db.delete(dmMessages).where(
    and(
      lt(dmMessages.createdAt, new Date(Date.now() - DM_RETENTION_DAYS * 86_400_000)),
      notExists(
        db
          .select({ one: sql`1` })
          .from(chatReports)
          .where(and(eq(chatReports.dmMessageId, dmMessages.id), eq(chatReports.status, "open"))),
      ),
    ),
  );
}

/** ~2% of sends run the cleanup, so no cron is needed. */
export async function maybePruneDmMessages(random: number = Math.random()): Promise<void> {
  if (random >= 0.02) return;
  try {
    await pruneDmMessages();
  } catch (err) {
    securityLog("request_failed", { route: "dm_prune", error: err instanceof Error ? err.name : "unknown" }, "error");
  }
}
