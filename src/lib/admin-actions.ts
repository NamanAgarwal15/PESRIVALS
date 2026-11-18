"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import bcrypt from "bcryptjs";
import { auth } from "@/auth";
import {
  deleteMatch,
  isAdminUser,
  setAnnouncement,
  setLeaderboardVisibility,
  setRole,
  setSuspended,
  setTempPasswordHash,
} from "@/lib/admin";
import { BCRYPT_COST, passwordSchema } from "@/lib/auth-helpers";
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
  await requireAdmin();
  const userId = field(fd, "userId");
  const parsed = passwordSchema.safeParse(field(fd, "password"));
  if (!isUuid(userId) || !parsed.success) return;
  await setTempPasswordHash(userId, await bcrypt.hash(parsed.data, BCRYPT_COST));
  revalidatePath("/admin");
}

export async function adminToggleSuspendAction(fd: FormData): Promise<void> {
  const me = await requireAdmin();
  const userId = field(fd, "userId");
  if (!isUuid(userId) || userId === me) return; // never suspend yourself
  await setSuspended(userId, field(fd, "suspended") === "true");
  revalidatePath("/admin");
}

export async function adminToggleLeaderboardAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const userId = field(fd, "userId");
  if (!isUuid(userId)) return;
  await setLeaderboardVisibility(userId, field(fd, "visible") === "true");
  revalidatePath("/admin");
}

export async function adminSetRoleAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const userId = field(fd, "userId");
  if (!isUuid(userId)) return;
  await setRole(userId, field(fd, "role") === "admin" ? "admin" : "user");
  revalidatePath("/admin");
}

export async function adminDeleteMatchAction(fd: FormData): Promise<void> {
  await requireAdmin();
  const matchId = field(fd, "matchId");
  if (!isUuid(matchId)) return;
  await deleteMatch(matchId);
  revalidatePath("/admin");
}

export async function adminSetAnnouncementAction(fd: FormData): Promise<void> {
  await requireAdmin();
  await setAnnouncement(field(fd, "text"));
  revalidatePath("/admin");
  revalidatePath("/home");
}
