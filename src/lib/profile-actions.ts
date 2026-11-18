"use server";

import { redirect } from "next/navigation";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { auth, unstable_update } from "@/auth";
import { db } from "@/db";
import { users } from "@/db/schema";
import { BCRYPT_COST, passwordSchema } from "@/lib/auth-helpers";
import {
  type ChangeKind,
  applyProfileChange,
  startProfileVerification,
  verifyProfileChange,
} from "@/lib/profile";

export type ProfileState = { ok: boolean; message?: string; error?: string; needsCode?: boolean };

const text = (fd: FormData, k: string) => {
  const v = fd.get(k);
  return typeof v === "string" ? v : "";
};
const kinds = ["email", "password"] as const;

async function requireUserId(): Promise<string> {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");
  return session.user.id;
}

/** Step 1: send the verification code (or say none is needed). */
export async function requestProfileOtpAction(kind: ChangeKind): Promise<ProfileState> {
  const userId = await requireUserId();
  if (!kinds.includes(kind)) return { ok: false, error: "Unknown change." };
  const r = await startProfileVerification(userId, kind);
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, needsCode: r.needsCode, message: r.via };
}

/** Step 2: verify the code (or current password) and commit the change. */
export async function commitProfileChangeAction(
  kind: ChangeKind,
  formData: FormData,
): Promise<ProfileState> {
  const userId = await requireUserId();
  if (!kinds.includes(kind)) return { ok: false, error: "Unknown change." };

  // Normalize + validate the new value first, so a bad value never burns a code.
  let value = "";
  if (kind === "email") {
    value = text(formData, "value").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return { ok: false, error: "Enter a valid email address." };
  } else {
    const parsed = passwordSchema.safeParse(text(formData, "value"));
    if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Weak password." };
    value = await bcrypt.hash(parsed.data, BCRYPT_COST);
  }

  // Password change may be authorised by the current password instead of a code.
  const current = text(formData, "currentPassword");
  let verified = false;
  if (kind === "password" && current) {
    const [row] = await db.select({ h: users.passwordHash }).from(users).where(eq(users.id, userId));
    verified = Boolean(row?.h) && (await bcrypt.compare(current, row!.h!));
    if (!verified) return { ok: false, error: "Current password is incorrect." };
  }
  if (!verified) {
    const v = await verifyProfileChange(userId, kind, text(formData, "code"));
    if (!v.ok) return { ok: false, error: v.error };
  }

  const done = await applyProfileChange(userId, kind, value);
  if (!done.ok) return { ok: false, error: done.error };
  await unstable_update({});
  return { ok: true, message: `${kind === "password" ? "Password" : "Email"} updated.` };
}
