// Admin-only moderation of chat reports. Every entry point re-verifies in the
// database that the caller is an existing, non-suspended admin. Hide / unhide /
// resolve write to the append-only audit log. Framework-free.

import { and, desc, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { adminAuditLogs, chatReports, dmMessages, globalChatMessages, users } from "@/db/schema";
import { isAdminUser } from "@/lib/admin";
import { recordAudit } from "@/lib/audit";

export const REPORT_PAGE_SIZE = 20;
export const REPORT_STATUSES = ["open", "reviewed", "dismissed"] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

export type AdminReportRow = {
  id: string;
  createdAt: Date;
  status: string;
  reason: string;
  kind: "global" | "dm";
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
  const page = Math.max(0, Math.min(10_000, Math.floor(opts.page ?? 0)));
  await auditViewed(actorId); // reports can quote private 1v1 messages: opening the queue is recorded

  const reporter = alias(users, "reporter");
  const reported = alias(users, "reported");
  const rows = await db
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
    .limit(REPORT_PAGE_SIZE + 1)
    .offset(page * REPORT_PAGE_SIZE);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(chatReports).where(eq(chatReports.status, "open"));

  return {
    ok: true,
    page,
    hasMore: rows.length > REPORT_PAGE_SIZE,
    openCount: n,
    rows: rows.slice(0, REPORT_PAGE_SIZE).map((r) => ({
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
  };
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
  const [row] = await db
    .update(chatReports)
    .set({ status, reviewedBy: actorId, reviewedAt: new Date() })
    .where(eq(chatReports.id, reportId))
    .returning({ id: chatReports.id });
  if (!row) return { ok: false, error: "Report not found" };
  await recordAudit(actorId, status === "reviewed" ? "chat.report_reviewed" : "chat.report_dismissed", "chat_report", reportId);
  return { ok: true };
}
