// Append-only admin audit log. This module only ever INSERTs and SELECTs;
// there is deliberately no update or delete helper.

import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { adminAuditLogs, users } from "@/db/schema";
import { redact } from "@/lib/security-log";

export type AuditAction =
  | "user.suspend"
  | "user.unsuspend"
  | "user.set_role"
  | "user.set_temp_password"
  | "user.leaderboard_visibility"
  | "match.soft_delete"
  | "match.resolve_dispute"
  | "sybil.dismiss"
  | "sybil.suspend_user"
  | "user.reset_quota"
  | "coach.chats_viewed"
  | "chat.reports_viewed"
  | "chat.hide_message"
  | "chat.unhide_message"
  | "chat.report_reviewed"
  | "chat.report_dismissed";

export async function recordAudit(
  actorUserId: string,
  action: AuditAction,
  targetType: "user" | "match" | "sybil_flag" | "chat_message" | "chat_report",
  targetId: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  // Never store secrets: metadata goes through the same redactor as the security log.
  await db.insert(adminAuditLogs).values({
    actorUserId,
    action,
    targetType,
    targetId: targetId.slice(0, 64),
    metadata: redact(metadata),
  });
}

export async function listAuditLogs(limit = 50) {
  return db
    .select({
      id: adminAuditLogs.id,
      action: adminAuditLogs.action,
      targetType: adminAuditLogs.targetType,
      targetId: adminAuditLogs.targetId,
      metadata: adminAuditLogs.metadata,
      createdAt: adminAuditLogs.createdAt,
      actor: users.username,
    })
    .from(adminAuditLogs)
    .leftJoin(users, eq(users.id, adminAuditLogs.actorUserId))
    .orderBy(desc(adminAuditLogs.createdAt))
    .limit(limit);
}
