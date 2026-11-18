// One-time 6-digit login/recovery codes: SHA-256 hashed, 10 minute expiry,
// max 3 verification attempts, single use, max 3 sends per 15 minutes.
// Framework-free (no next/* imports) so it is unit-tested directly.

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
  | {
      ok: true;
      userId: string;
      code: string;
      delivered: "email" | "sms" | "email_fallback";
    }
  | { ok: false; code: "not_found" | "suspended" | "rate_limited" | "send_failed" };

export type OtpVerifyResult =
  | { ok: true; userId: string }
  | { ok: false; code: "not_found" | "expired" | "too_many_attempts" | "wrong_code" };

/** Delivery hook, injected so tests never hit a real gateway. */
export type OtpSender = (
  otp: string,
  channel: "email" | "phone",
  identifier: string,
  fallbackEmail: string | null,
) => Promise<"email" | "sms" | "email_fallback" | "failed">;

/** Default delivery: Resend for email, Fast2SMS for phone (email fallback). */
export const defaultOtpSender: OtpSender = async (otp, channel, identifier, fallbackEmail) => {
  const emailBody = `Your PESRIVALS login code is ${otp}. It expires in 10 minutes.`;
  if (channel === "email") {
    if (!process.env.RESEND_API_KEY) return "failed";
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.RESET_EMAIL_FROM ?? "PESRIVALS <onboarding@resend.dev>",
      to: identifier,
      subject: "Your PESRIVALS login code",
      text: emailBody,
    });
    return "email";
  }
  // Phone: Fast2SMS when configured, otherwise the recovery email.
  if (process.env.FAST2SMS_API_KEY) {
    const res = await fetch("https://www.fast2sms.com/dev/bulkV2", {
      method: "POST",
      headers: {
        authorization: process.env.FAST2SMS_API_KEY,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        route: "otp",
        variables_values: otp,
        numbers: identifier.replace(/[^0-9]/g, "").slice(-10),
      }),
    });
    if (res.ok) return "sms";
  }
  if (fallbackEmail && process.env.RESEND_API_KEY) {
    const { Resend } = await import("resend");
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.RESET_EMAIL_FROM ?? "PESRIVALS <onboarding@resend.dev>",
      to: fallbackEmail,
      subject: "Your PESRIVALS phone login code",
      text: `${emailBody} (Sent to your registered recovery email because SMS delivery is not configured yet.)`,
    });
    return "email_fallback";
  }
  return "failed";
};

/**
 * Creates and delivers a 6-digit OTP for the email/phone identifier.
 * Only the SHA-256 hash is stored; sends are rate-limited to 3 per 15 min.
 */
export async function sendOtp(
  identifier: string,
  sender: OtpSender = defaultOtpSender,
): Promise<OtpSendResult> {
  const id = identifier.trim().toLowerCase();
  const [user] = await db
    .select({ id: users.id, email: users.email, suspended: users.suspended })
    .from(users)
    .where(
      id.includes("@")
        ? eq(users.email, id)
        : eq(users.phone, identifier.replace(/[\s()-]/g, "")),
    );
  if (!user) return { ok: false, code: "not_found" };
  if (user.suspended) return { ok: false, code: "suspended" };

  const rl = await consumeRateLimit(
    `otp:${user.id}`,
    LIMITS.forgotPassword.max,
    LIMITS.forgotPassword.windowMinutes,
  );
  if (!rl.ok) return { ok: false, code: "rate_limited" };

  const channel: "email" | "phone" = id.includes("@") ? "email" : "phone";
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(otpCodes).values({
    userId: user.id,
    channel,
    identifier: channel === "email" ? id : identifier.replace(/[\s()-]/g, ""),
    codeHash: sha256Hex(code),
    expiresAt: new Date(Date.now() + OTP_MINUTES * 60 * 1000),
  });

  const delivered = await sender(code, channel, id, user.email);
  if (delivered === "failed") return { ok: false, code: "send_failed" };
  return { ok: true, userId: user.id, code, delivered };
}

/**
 * Verifies a 6-digit code for an identifier. Wrong codes consume one of the
 * 3 attempts; correct codes mark the OTP used exactly once.
 */
export async function verifyOtp(identifier: string, code: string): Promise<OtpVerifyResult> {
  const id = identifier.trim().toLowerCase();
  const lookup = id.includes("@") ? id : identifier.replace(/[\s()-]/g, "");
  const [row] = await db
    .select()
    .from(otpCodes)
    .where(and(eq(otpCodes.identifier, lookup), isNull(otpCodes.usedAt)))
    .orderBy(desc(otpCodes.createdAt))
    .limit(1);
  if (!row) return { ok: false, code: "not_found" };

  if (row.expiresAt.getTime() <= Date.now()) {
    return { ok: false, code: "expired" };
  }
  if (row.attempts >= OTP_MAX_ATTEMPTS) {
    return { ok: false, code: "too_many_attempts" };
  }
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
