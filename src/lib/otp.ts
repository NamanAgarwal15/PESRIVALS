// One-time 6-digit email codes for login: SHA-256 hashed, 10 minute expiry,
// max 3 verification attempts, single use, max 3 sends per 15 minutes.
// Email only (Resend). Framework-free (no next/* imports) so it is unit-tested directly.

import { createHash, randomInt } from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { otpCodes, users } from "@/db/schema";
import { consumeRateLimit, LIMITS } from "@/lib/rate-limit";

export const OTP_MINUTES = 10;
export const OTP_MAX_ATTEMPTS = 3;

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type OtpSendResult =
  | { ok: true; userId: string; code: string; delivered: "email" }
  | { ok: false; code: "not_found" | "suspended" | "rate_limited" | "send_failed" };

export type OtpVerifyResult =
  | { ok: true; userId: string }
  | { ok: false; code: "not_found" | "expired" | "too_many_attempts" | "wrong_code" };

/** Delivery hook, injected so tests never hit a real mail API. */
export type OtpSender = (otp: string, email: string) => Promise<"email" | "failed">;

/** Default delivery: email through Resend (RESEND_API_KEY). */
export const defaultOtpSender: OtpSender = async (otp, email) => {
  if (!process.env.RESEND_API_KEY) return "failed";
  const { Resend } = await import("resend");
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { error } = await resend.emails.send({
    from: process.env.RESET_EMAIL_FROM ?? "PESRIVALS <onboarding@resend.dev>",
    to: email,
    subject: "Your PESRIVALS login code",
    text: `Your PESRIVALS code is ${otp}. It expires in ${OTP_MINUTES} minutes. If you did not request it, ignore this email.`,
  });
  return error ? "failed" : "email";
};

/**
 * Creates and emails a 6-digit OTP for the account with this email.
 * Only the SHA-256 hash is stored; sends are rate-limited to 3 per 15 min.
 */
export async function sendOtp(
  email: string,
  sender: OtpSender = defaultOtpSender,
): Promise<OtpSendResult> {
  const id = email.trim().toLowerCase();
  const [user] = await db
    .select({ id: users.id, suspended: users.suspended })
    .from(users)
    .where(eq(users.email, id));
  if (!user) return { ok: false, code: "not_found" };
  if (user.suspended) return { ok: false, code: "suspended" };

  const rl = await consumeRateLimit(
    `otp:${user.id}`,
    LIMITS.forgotPassword.max,
    LIMITS.forgotPassword.windowMinutes,
  );
  if (!rl.ok) return { ok: false, code: "rate_limited" };

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(otpCodes).values({
    userId: user.id,
    channel: "email",
    identifier: id,
    codeHash: sha256Hex(code),
    expiresAt: new Date(Date.now() + OTP_MINUTES * 60 * 1000),
  });

  const delivered = await sender(code, id);
  if (delivered === "failed") return { ok: false, code: "send_failed" };
  return { ok: true, userId: user.id, code, delivered };
}

/**
 * Verifies a 6-digit code for an email. Wrong codes consume one of the
 * 3 attempts; correct codes mark the OTP used exactly once.
 */
export async function verifyOtp(email: string, code: string): Promise<OtpVerifyResult> {
  const id = email.trim().toLowerCase();
  const [row] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.identifier, id), isNull(otpCodes.usedAt)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!row) return { ok: false, code: "not_found" };

  if (row.expiresAt.getTime() <= Date.now()) return { ok: false, code: "expired" };
  if (row.attempts >= OTP_MAX_ATTEMPTS) return { ok: false, code: "too_many_attempts" };
  if (row.codeHash !== sha256Hex(code)) {
    const attempts = row.attempts + 1;
    await db.update(otpCodes).set({ attempts }).where(eq(otpCodes.id, row.id));
    return { ok: false, code: attempts >= OTP_MAX_ATTEMPTS ? "too_many_attempts" : "wrong_code" };
  }

  // Atomically claim the code: a second verify with the same row is a no-op.
  const claimed = await db
    .update(otpCodes)
    .set({ usedAt: new Date() })
    .where(and(eq(otpCodes.id, row.id), isNull(otpCodes.usedAt)))
    .returning({ id: otpCodes.id });
  if (!claimed.length) return { ok: false, code: "not_found" };
  return { ok: true, userId: row.userId };
}
