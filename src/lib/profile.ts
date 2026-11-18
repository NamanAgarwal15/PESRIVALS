// Logged-in profile changes (password / email / phone) gated by OTP.
// Framework-free so it is unit-tested directly.
//
// Rule: with BOTH channels set, changing one requires an OTP on the OTHER
// channel. With only one channel, that channel verifies the change (no
// logout). With none, the change is allowed directly.

import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { type OtpSender, defaultOtpSender, sendOtp, verifyOtp } from "@/lib/otp";

export type ChangeKind = "email" | "phone" | "password";
export type VerifyTarget = { channel: "email" | "phone"; identifier: string };

export function pickVerificationTarget(
  user: { email: string | null; phone: string | null },
  kind: ChangeKind,
): VerifyTarget | null {
  const email = user.email ? { channel: "email" as const, identifier: user.email } : null;
  const phone = user.phone ? { channel: "phone" as const, identifier: user.phone } : null;
  if (kind === "email") return phone ?? email;
  if (kind === "phone") return email ?? phone;
  return email ?? phone; // password: either channel
}

export function maskIdentifier(t: VerifyTarget): string {
  if (t.channel === "phone") return `phone ending ${t.identifier.slice(-3)}`;
  const [name, domain] = t.identifier.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

async function loadUser(userId: string) {
  const [u] = await db
    .select({ id: users.id, email: users.email, phone: users.phone, suspended: users.suspended })
    .from(users)
    .where(eq(users.id, userId));
  return u && !u.suspended ? u : null;
}

export type StartResult =
  | { ok: true; needsCode: boolean; via?: string }
  | { ok: false; error: string };

/** Sends the verification OTP for a change (or reports that none is needed). */
export async function startProfileVerification(
  userId: string,
  kind: ChangeKind,
  sender: OtpSender = defaultOtpSender,
): Promise<StartResult> {
  const u = await loadUser(userId);
  if (!u) return { ok: false, error: "Account not found." };
  const target = pickVerificationTarget(u, kind);
  if (!target) return { ok: true, needsCode: false };
  const res = await sendOtp(target.identifier, sender);
  if (!res.ok) {
    return {
      ok: false,
      error:
        res.code === "rate_limited"
          ? "Too many code requests. Try again in a few minutes."
          : "Could not send a code right now. Try again shortly.",
    };
  }
  const via =
    res.delivered === "email_fallback"
      ? "OTP sent to your registered recovery email"
      : `Code sent to your ${maskIdentifier(target)}`;
  return { ok: true, needsCode: true, via };
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/** Verifies the OTP for this user's change (no-op when no channel exists). */
export async function verifyProfileChange(
  userId: string,
  kind: ChangeKind,
  code: string,
): Promise<VerifyResult> {
  const u = await loadUser(userId);
  if (!u) return { ok: false, error: "Account not found." };
  const target = pickVerificationTarget(u, kind);
  if (!target) return { ok: true };
  const res = await verifyOtp(target.identifier, code.trim());
  if (!res.ok || res.userId !== userId) {
    return { ok: false, error: "That code is wrong or has expired. Request a new one." };
  }
  return { ok: true };
}

/** Writes a verified email/phone/password-hash change. */
export async function applyProfileChange(
  userId: string,
  kind: ChangeKind,
  value: string,
): Promise<VerifyResult> {
  const set =
    kind === "email" ? { email: value } : kind === "phone" ? { phone: value } : { passwordHash: value };
  try {
    await db.update(users).set({ ...set, updatedAt: new Date() }).where(eq(users.id, userId));
  } catch {
    return { ok: false, error: "That email or phone is already used by another account." };
  }
  return { ok: true };
}
