// Admin-only moderation of chat reports. Every entry point re-verifies in the
// database that the caller is an existing, non-suspended admin. Hide / unhide /
// resolve write to the append-only audit log. Framework-free.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { adminAuditLogs, chatReports, clanChatMessages, clanChatReports, clanWars, clans, dmMessages, globalChatMessages, users } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { recordAudit } from "@/lib/audit";
import { settleWarPairings } from "@/lib/clan-wars";
import { type MutePreset, muteUntil } from "@/lib/chat-mute";

export const REPORT_PAGE_SIZE = 20;
export const REPORT_STATUSES = ["open", "reviewed", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type AdminReportRow = {
  id: string;
  createdAt: Date;
  status: string;
  reason: string;
  kind: "global" | "dm" | "clan";
  reporter: string;
  reported: string;
  messageId: string | null;
  body: string | null;
  hidden: boolean;
};
export type AdminReportPage =
  | { ok: true; rows: AdminReportRow[]; page: number; hasMore: boolean; openCount: number }
  | { ok: false; error: string };

async function auditViewed(actorId: string) {
  const since = new Date(Date.now() - 5 * 60_000);
  const [recent] = await db
    .select({ id: adminAuditLogs.id })
    .from(adminAuditLogs)
    .where(and(eq(adminAuditLogs.actorUserId, actorId), eq(adminAuditLogs.action, "chat.reports_viewed"), gte(adminAuditLogs.createdAt, since)))
    .limit(1);
  if (!recent) await recordAudit(actorId, "chat.reports_viewed", "user", actorId);
}

export async function getChatReports(
  actorId: string,
  opts: { status?: ReportStatus | "all"; page?: number } = {},
): Promise<AdminReportPage> {
  if (!(await isAdminUser(actorId))) return { ok: false, error: "Forbidden" };
  const status = opts.status ?? "open";
  const page = Math.max(0, Math.min(20, Math.floor(opts.page ?? 0)));
  await auditViewed(actorId); // reports can quote private 1v1 and clan messages: opening the queue is recorded

  const take = (page + 1) * REPORT_PAGE_SIZE + 1; // each source is bounded; merged and paged below
  const reporter = alias(users, "reporter");
  const reported = alias(users, "reported");
  const main = await db
    .select({
      id: chatReports.id,
      createdAt: chatReports.createdAt,
      status: chatReports.status,
      reason: chatReports.reason,
      globalId: chatReports.globalMessageId,
      dmId: chatReports.dmMessageId,
      reporter: reporter.username,
      reported: reported.username,
      globalBody: globalChatMessages.body,
      globalHidden: globalChatMessages.hidden,
      dmBody: dmMessages.body,
    })
    .from(chatReports)
    .innerJoin(reporter, eq(reporter.id, chatReports.reporterId))
    .innerJoin(reported, eq(reported.id, chatReports.reportedUserId))
    .leftJoin(globalChatMessages, eq(globalChatMessages.id, chatReports.globalMessageId))
    .leftJoin(dmMessages, eq(dmMessages.id, chatReports.dmMessageId))
    .where(status === "all" ? undefined : eq(chatReports.status, status))
    .orderBy(desc(chatReports.createdAt))
    .limit(take);

  const cReporter = alias(users, "c_reporter");
  const cReported = alias(users, "c_reported");
  const clanRows = await db
    .select({
      id: clanChatReports.id,
      createdAt: clanChatReports.createdAt,
      status: clanChatReports.status,
      reason: clanChatReports.reason,
      messageId: clanChatReports.clanMessageId,
      reporter: cReporter.username,
      reported: cReported.username,
      body: clanChatMessages.body,
      hidden: clanChatMessages.hidden,
    })
    .from(clanChatReports)
    .innerJoin(cReporter, eq(cReporter.id, clanChatReports.reporterId))
    .innerJoin(cReported, eq(cReported.id, clanChatReports.reportedUserId))
    .innerJoin(clanChatMessages, eq(clanChatMessages.id, clanChatReports.clanMessageId))
    .where(status === "all" ? undefined : eq(clanChatReports.status, status))
    .orderBy(desc(clanChatReports.createdAt))
    .limit(take);

  const merged: AdminReportRow[] = [
    ...main.map((r): AdminReportRow => ({
      id: r.id,
      createdAt: r.createdAt,
      status: r.status,
      reason: r.reason,
      kind: r.globalId ? "global" : "dm",
      reporter: r.reporter,
      reported: r.reported,
      messageId: r.globalId,
      body: r.globalId ? r.globalBody : r.dmBody,
      hidden: Boolean(r.globalHidden),
    })),
    ...clanRows.map((r): AdminReportRow => ({
      id: r.id, createdAt: r.createdAt, status: r.status, reason: r.reason, kind: "clan",
      reporter: r.reporter, reported: r.reported, messageId: r.messageId, body: r.body, hidden: r.hidden,
    })),
  ].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

  const [{ n: a }] = await db.select({ n: sql<number>`count(*)::int` }).from(chatReports).where(eq(chatReports.status, "open"));
  const [{ n: b }] = await db.select({ n: sql<number>`count(*)::int` }).from(clanChatReports).where(eq(clanChatReports.status, "open"));
  const slice = merged.slice(page * REPORT_PAGE_SIZE, page * REPORT_PAGE_SIZE + REPORT_PAGE_SIZE + 1);
  return { ok: true, page, hasMore: slice.length > REPORT_PAGE_SIZE, openCount: a + b, rows: slice.slice(0, REPORT_PAGE_SIZE) };
}

export type ModerationResult = { ok: true } | { ok: false; error: string };

/** Hides or unhides a lobby message. Hiding also closes its open reports as "reviewed". */
export async function setGlobalMessageHidden(actorId: string, messageId: string, hidden: boolean): Promise<ModerationResult> {
  if (!(await isAdminUser(actorId))) return { ok: false, error: "Forbidden" };
  const [msg] = await db
    .update(globalChatMessages)
    .set({ hidden })
    .where(eq(globalChatMessages.id, messageId))
    .returning({ id: globalChatMessages.id, senderId: globalChatMessages.senderId });
  if (!msg) return { ok: false, error: "Message not found" };
  if (hidden) {
    await db
      .update(chatReports)
      .set({ status: "reviewed", reviewedBy: actorId, reviewedAt: new Date() })
      .where(and(eq(chatReports.globalMessageId, messageId), eq(chatReports.status, "open")));
  }
  await recordAudit(actorId, hidden ? "chat.hide_message" : "chat.unhide_message", "chat_message", messageId, { sender: msg.senderId });
  return { ok: true };
}

/** Marks a report reviewed or dismissed. */
export async function resolveChatReport(actorId: string, reportId: string, status: "reviewed" | "dismissed"): Promise<ModerationResult> {
  if (!(await isAdminUser(actorId))) return { ok: false, error: "Forbidden" };
  const set = { status, reviewedBy: actorId, reviewedAt: new Date() };
  let [row] = await db.update(chatReports).set(set).where(eq(chatReports.id, reportId)).returning({ id: chatReports.id });
  if (!row) [row] = await db.update(clanChatReports).set(set).where(eq(clanChatReports.id, reportId)).returning({ id: clanChatReports.id });
  if (!row) return { ok: false, error: "Report not found" };
  await recordAudit(actorId, status === "reviewed" ? "chat.report_reviewed" : "chat.report_dismissed", "chat_report", reportId);
  return { ok: true };
}

/** Hides or unhides a clan chat message. Hiding also closes its open reports as "reviewed". */
export async function setClanMessageHidden(actorId: string, messageId: string, hidden: boolean): Promise<ModerationResult> {
  if (!(await isAdminUser(actorId))) return { ok: false, error: "Forbidden" };
  const [msg] = await db
    .update(clanChatMessages)
    .set({ hidden })
    .where(eq(clanChatMessages.id, messageId))
    .returning({ id: clanChatMessages.id, senderId: clanChatMessages.senderId });
  if (!msg) return { ok: false, error: "Message not found" };
  if (hidden) {
    await db
      .update(clanChatReports)
      .set({ status: "reviewed", reviewedBy: actorId, reviewedAt: new Date() })
      .where(and(eq(clanChatReports.clanMessageId, messageId), eq(clanChatReports.status, "open")));
  }
  await recordAudit(actorId, hidden ? "chat.hide_clan_message" : "chat.unhide_clan_message", "chat_message", messageId, { sender: msg.senderId });
  return { ok: true };
}

const muteSchema = z.object({ userId: z.uuid(), preset: z.enum(["24h", "7d", "permanent", "unmute"]) });

/** Chat-only mute / unmute. Verified, non-suspended admins only; never for yourself; audited. */
export async function setChatMute(actorId: string, userId: unknown, preset: unknown): Promise<ModerationResult & { until?: Date | null }> {
  if (!(await isAdminUser(actorId))) return { ok: false, error: "Forbidden" };
  const parsed = muteSchema.safeParse({ userId, preset });
  if (!parsed.success) return { ok: false, error: "Invalid request" };
  if (parsed.data.userId === actorId) return { ok: false, error: "You cannot mute yourself" };
  const until = muteUntil(parsed.data.preset as MutePreset);
  const [row] = await db.update(users).set({ chatMutedUntil: until }).where(eq(users.id, parsed.data.userId)).returning({ id: users.id });
  if (!row) return { ok: false, error: "User not found" };
  await recordAudit(actorId, until ? "user.chat_mute" : "user.chat_unmute", "user", row.id, { preset: parsed.data.preset, until: until?.toISOString() ?? "" });
  return { ok: true, until };
}

export type AdminWarRow = { id: string; challengerTag: string; defenderTag: string; challengerWins: number; defenderWins: number; completedAt: Date | null };

/** Completed wars (newest first) that an admin may re-open. */
export async function getCompletedWars(actorId: string, limit = 10): Promise<AdminWarRow[]> {
  if (!(await isAdminUser(actorId))) return [];
  const c = alias(clans, "c");
  const d = alias(clans, "d");
  return db
    .select({ id: clanWars.id, challengerTag: c.tag, defenderTag: d.tag, challengerWins: clanWars.challengerWins, defenderWins: clanWars.defenderWins, completedAt: clanWars.completedAt })
    .from(clanWars)
    .innerJoin(c, eq(c.id, clanWars.challengerClanId))
    .innerJoin(d, eq(d.id, clanWars.defenderClanId))
    .where(eq(clanWars.status, "completed"))
    .orderBy(desc(clanWars.completedAt))
    .limit(Math.min(limit, 25));
}

/**
 * Re-opens a completed clan war (e.g. a deciding match was disputed or deleted after the
 * war finished): status back to active, winner and completion cleared, then the settle step
 * re-checks every slot against the matches as they are NOW and recomputes the score. If the
 * remaining confirmed matches still decide the series, the war completes again by itself.
 */
export async function reopenClanWar(actorId: string, warId: unknown, note?: unknown): Promise<ModerationResult & { status?: string }> {
  if (!(await isAdminUser(actorId))) return { ok: false, error: "Forbidden" };
  const id = z.uuid().safeParse(warId);
  if (!id.success) return { ok: false, error: "War not found" };
  const reopened = await db
    .update(clanWars)
    .set({ status: "active", winnerClanId: null, completedAt: null })
    .where(and(eq(clanWars.id, id.data), eq(clanWars.status, "completed")))
    .returning({ id: clanWars.id });
  if (!reopened.length) return { ok: false, error: "Only a completed war can be re-opened" };
  await settleWarPairings(id.data);
  const [after] = await db.select({ status: clanWars.status }).from(clanWars).where(eq(clanWars.id, id.data));
  const text = typeof note === "string" ? note.trim().slice(0, 200) : "";
  await recordAudit(actorId, "clan_war.reopen", "clan_war", id.data, { statusAfter: after?.status ?? "", note: text });
  return { ok: true, status: after?.status };
}
