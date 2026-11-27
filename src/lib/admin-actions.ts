"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import {
  deleteMatch,
  isAdminUser,
  resolveSybilFlag,
  setAnnouncement,
  setLeaderboardVisibility,
  setRole,
  setSuspended,
  setTempPasswordHash,
} from "@/lib/admin";
import { QUOTA_BUCKETS, resetUserQuota } from "@/lib/admin-coach";
import { resolveMatchDispute } from "@/lib/match-helpers";
import { reopenClanWar, resolveChatReport, setChatMute, setClanMessageHidden, setGlobalMessageHidden } from "@/lib/admin-chat";
import { z } from "zod";
import { BCRYPT_COST, passwordSchema } from "@/lib/auth-helpers";
import { recordAudit } from "@/lib/audit";
import { refreshLeaderboard } from "@/lib/leaderboard-cache";
import { isUuid } from "@/lib/rivalry-helpers";

/** RBAC gate: re-checks the role in the DB on every action. Non-admins get a 404. */
async function requireAdmin(): Promise<string> {
  const session = await auth();
  const id = session?.user?.id;
  if (!id || !(await isAdminUser(id))) notFound();
  return id;
}

const field = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};

export async function adminSetPasswordAction(fd: FormData): Promise<void> {
  const userId = field(fd, "userId");
  const adminId = await requireAdmin();
  const parsed = passwordSchema.safeParse(field(fd, "password"));
  if (!isUuid(userId) || !parsed.success) return;
  await setTempPasswordHash(userId, await bcrypt.hash(parsed.data, BCRYPT_COST));
  await recordAudit(adminId, "user.set_temp_password", "user", userId);
  revalidatePath("/admin");
}

export async function adminToggleSuspendAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const userId = field(fd, "userId");
  if (!isUuid(userId) || userId === me) return; // never suspend yourself
  const suspend = field(fd, "suspended") === "true";
  await setSuspended(userId, suspend);
  await recordAudit(me, suspend ? "user.suspend" : "user.unsuspend", "user", userId);
  revalidatePath("/admin");
  refreshLeaderboard();
}

export async function adminToggleLeaderboardAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const userId = field(fd, "userId");
  if (!isUuid(userId)) return;
  const visible = field(fd, "visible") === "true";
  await setLeaderboardVisibility(userId, visible);
  await recordAudit(me, "user.leaderboard_visibility", "user", userId, { visible });
  revalidatePath("/admin");
  refreshLeaderboard();
}

export async function adminSetRoleAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const userId = field(fd, "userId");
  if (!isUuid(userId)) return;
  const role = field(fd, "role") === "admin" ? "admin" : "user";
  const res = await setRole(userId, role);
  if (res.ok) await recordAudit(me, "user.set_role", "user", userId, { role });
  revalidatePath("/admin");
}

export async function adminDeleteMatchAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const matchId = field(fd, "matchId");
  if (!isUuid(matchId)) return;
  if (await deleteMatch(matchId, me)) await recordAudit(me, "match.soft_delete", "match", matchId);
  revalidatePath("/admin");
  refreshLeaderboard();
}

/** Admin ruling on a disputed (or frozen) match: confirm it so it counts again. Audited. Void = adminDeleteMatchAction. */
export async function adminResolveDisputeAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const matchId = field(fd, "matchId");
  if (!isUuid(matchId)) return;
  const res = await resolveMatchDispute(me, true, matchId);
  if (res.ok) await recordAudit(me, "match.resolve_dispute", "match", matchId);
  revalidatePath("/admin");
  refreshLeaderboard();
}

export async function adminSetAnnouncementAction(fd: FormData): Promise<void> {
  await requireAdmin();
  await setAnnouncement(field(fd, "text"));
  revalidatePath("/admin");
  revalidatePath("/home");
}

/** Dismiss a flag (no action) or action it by suspending the primary user. Never automatic. */
export async function adminResolveSybilFlagAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const flagId = field(fd, "flagId");
  if (!isUuid(flagId)) return;
  const suspend = field(fd, "decision") === "suspend";
  const flag = await resolveSybilFlag(flagId, me, suspend ? "actioned" : "dismissed");
  if (!flag) return;
  if (suspend && flag.primaryUserId !== me) {
    await setSuspended(flag.primaryUserId, true);
    await recordAudit(me, "sybil.suspend_user", "sybil_flag", flagId, { userId: flag.primaryUserId });
    refreshLeaderboard();
  } else {
    await recordAudit(me, "sybil.dismiss", "sybil_flag", flagId);
  }
  revalidatePath("/admin");
}

const quotaSchema = z.object({ userId: z.uuid(), bucket: z.enum(QUOTA_BUCKETS) });

/** Reset a user's AI/extraction quota buckets (coach, extract, briefing or all). Admin only, audited. */
export async function resetUserQuotaAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const parsed = quotaSchema.safeParse({ userId: field(fd, "userId"), bucket: field(fd, "bucket") });
  if (!parsed.success) return;
  await resetUserQuota(me, parsed.data.userId, parsed.data.bucket);
  revalidatePath("/admin");
}


export async function adminHideChatMessageAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const messageId = field(fd, "messageId");
  if (!isUuid(messageId)) return;
  const hidden = field(fd, "hidden") === "true";
  if (field(fd, "kind") === "clan") await setClanMessageHidden(me, messageId, hidden);
  else await setGlobalMessageHidden(me, messageId, hidden);
  revalidatePath("/admin");
}

export async function adminResolveChatReportAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const reportId = field(fd, "reportId");
  const status = field(fd, "status");
  if (!isUuid(reportId) || (status !== "reviewed" && status !== "dismissed")) return;
  await resolveChatReport(me, reportId, status);
  revalidatePath("/admin");
}

export async function adminSetChatMuteAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  await setChatMute(me, field(fd, "userId"), field(fd, "preset")); // validated with Zod inside
  revalidatePath("/admin");
}

export async function adminReopenClanWarAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  await reopenClanWar(me, field(fd, "warId"), field(fd, "note"));
  revalidatePath("/admin");
  revalidatePath("/clans", "layout");
}
