// Admin-only oversight of the AI features: reset a user's daily quota buckets
// and read every persisted Rivalry Coach exchange. Every entry point re-verifies
// that the caller is an existing, non-suspended admin in the database, so a
// stale or forged session can never reach this data. Framework-free.

import { and, desc, eq, gte, ilike, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { adminAuditLogs, coachChatLogs, rivalries, userInsights, users } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { recordAudit } from "@/lib/audit";
import { clearUserRateLimits, utcDay } from "@/lib/rate-limit";

export const QUOTA_BUCKETS = ["all", "coach", "extract", "briefing"] as const;
export type QuotaBucket = (typeof QUOTA_BUCKETS)[number];

export type ResetResult = { ok: true; cleared: string[] } | { ok: false; error: string };

export async function resetUserQuota(actorId: string, targetUserId: string, bucket: QuotaBucket): Promise<ResetResult> {
  if (!(await isAdminUser(actorId))) return { ok: false, error: "Forbidden" };
  const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, targetUserId));
  if (!target) return { ok: false, error: "User not found" };

  const cleared: string[] = [];
  if (bucket === "all" || bucket === "coach") {
    await clearUserRateLimits(targetUserId, ["coach"]);
    cleared.push("coach");
  }
  if (bucket === "all" || bucket === "extract") {
    await clearUserRateLimits(targetUserId, ["extract"]);
    cleared.push("extract");
  }
  if (bucket === "all" || bucket === "briefing") {
    // Removing today's AI briefings frees the 1-per-UTC-day allowance (and the stored copy).
    await db
      .delete(userInsights)
      .where(and(eq(userInsights.userId, targetUserId), eq(userInsights.source, "ai"), gte(userInsights.createdAt, new Date(`${utcDay()}T00:00:00.000Z`))));
    cleared.push("briefing");
  }
  await recordAudit(actorId, "user.reset_quota", "user", targetUserId, { bucket, cleared: cleared.join(",") });
  return { ok: true, cleared };
}

export const CHAT_PAGE_SIZE = 20;

export type AdminChatRow = {
  id: string;
  createdAt: Date;
  userId: string;
  username: string;
  displayName: string;
  rivalryId: string | null;
  scope: string;
  userMessage: string;
  assistantReply: string;
  source: string;
  flagged: boolean;
  flagReason: string | null;
};

export type AdminChatPage =
  | { ok: true; rows: AdminChatRow[]; total: number; page: number; pageSize: number; hasMore: boolean }
  | { ok: false; error: string };

const escapeLike = (v: string) => v.replace(/[%_\\]/g, (c) => "\\" + c);

/** Records that an admin opened the chat reader, at most once every 5 minutes per admin. */
async function auditInspection(actorId: string, meta: Record<string, unknown>) {
  const since = new Date(Date.now() - 5 * 60_000);
  const [recent] = await db
    .select({ id: adminAuditLogs.id })
    .from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.actorUserId, actorId), eq(adminAuditLogs.action, "coach.chats_viewed"), gte(adminAuditLogs.createdAt, since)))
    .limit(1);
  if (!recent) await recordAudit(actorId, "coach.chats_viewed", "user", actorId, meta);
}

/** All persisted coach chats (newest first), optionally flagged-only and/or for one user. */
export async function getAdminCoachChatLogs(
  actorId: string,
  opts: { flaggedOnly?: boolean; username?: string; page?: number } = {},
): Promise<AdminChatPage> {
  if (!(await isAdminUser(actorId))) return { ok: false, error: "Forbidden" };
  const page = Math.max(0, Math.min(10_000, Math.floor(Number(opts.page) || 0)));
  const username = (opts.username ?? "").trim().replace(/^@/, "").slice(0, 40);

  const ua = alias(users, "ua");
  const ub = alias(users, "ub");
  const conditions = [
    opts.flaggedOnly ? eq(coachChatLogs.flagged, true) : undefined,
    username ? ilike(users.username, "%" + escapeLike(username) + "%") : undefined,
  ].filter((c): c is NonNullable<typeof c> => c !== undefined);
  const where = conditions.length ? and(...conditions) : undefined;

  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(coachChatLogs)
    .innerJoin(users, eq(users.id, coachChatLogs.userId))
    .where(where);

  const rows = await db
    .select({
      id: coachChatLogs.id,
      createdAt: coachChatLogs.createdAt,
      userId: users.id,
      username: users.username,
      displayName: users.displayName,
      rivalryId: coachChatLogs.rivalryId,
      aName: ua.username,
      bName: ub.username,
      userMessage: coachChatLogs.userMessage,
      assistantReply: coachChatLogs.assistantReply,
      source: coachChatLogs.source,
      flagged: coachChatLogs.flagged,
      flagReason: coachChatLogs.flagReason,
    })
    .from(coachChatLogs)
    .innerJoin(users, eq(users.id, coachChatLogs.userId))
    .leftJoin(rivalries, eq(rivalries.id, coachChatLogs.rivalryId))
    .leftJoin(ua, eq(ua.id, rivalries.userAId))
    .leftJoin(ub, eq(ub.id, rivalries.userBId))
    .where(where)
    .orderBy(desc(coachChatLogs.createdAt))
    .limit(CHAT_PAGE_SIZE)
    .offset(page * CHAT_PAGE_SIZE);

  await auditInspection(actorId, { flaggedOnly: Boolean(opts.flaggedOnly), username: username || null, page });
  return {
    ok: true,
    page,
    pageSize: CHAT_PAGE_SIZE,
    total: n,
    hasMore: (page + 1) * CHAT_PAGE_SIZE < n,
    rows: rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      userId: r.userId,
      username: r.username,
      displayName: r.displayName,
      rivalryId: r.rivalryId,
      scope: r.rivalryId ? `@${r.aName ?? "?"} vs @${r.bName ?? "?"}` : "All rivalries",
      userMessage: r.userMessage,
      assistantReply: r.assistantReply,
      source: r.source,
      flagged: r.flagged,
      flagReason: r.flagReason,
    })),
  };
}
