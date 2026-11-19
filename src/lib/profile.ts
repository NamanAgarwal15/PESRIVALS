// Logged-in profile changes (password / email) gated by an email OTP.
// Framework-free so it is unit-tested directly.
//
// Rule: if the account has an email, a code sent to that email verifies the
// change. Accounts with no email yet can add one directly.

import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { type OtpSender, defaultOtpSender, sendOtp, verifyOtp } from "@/lib/otp";

export type ChangeKind = "email" | "password";

export function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

async function loadUser(userId: string) {
  const [u] = await db
    .select({ id: users.id, email: users.email, suspended: users.suspended })
    .from(users)
    .where(eq(users.id, userId));
  return u && !u.suspended ? u : null;
}

export type StartResult =
  | { ok: true; needsCode: boolean; via?: string }
  | { ok: false; error: string };

/** Emails the verification code for a change (or reports that none is needed). */
export async function startProfileVerification(
  userId: string,
  _kind: ChangeKind,
  sender: OtpSender = defaultOtpSender,
): Promise<StartResult> {
  const u = await loadUser(userId);
  if (!u) return { ok: false, error: "Account not found." };
  if (!u.email) return { ok: true, needsCode: false };
  const res = await sendOtp(u.email, sender);
  if (!res.ok) {
    return {
      ok: false,
      error:
        res.code === "rate_limited"
          ? "Too many code requests. Try again in a few minutes."
          : "Could not send a code right now. Try again shortly.",
    };
  }
  return { ok: true, needsCode: true, via: `Code sent to ${maskEmail(u.email)}` };
}

export type VerifyResult = { ok: true } | { ok: false; error: string };

/** Verifies the emailed OTP for this user's change (no-op when no email exists). */
export async function verifyProfileChange(
  userId: string,
  _kind: ChangeKind,
  code: string,
): Promise<VerifyResult> {
  const u = await loadUser(userId);
  if (!u) return { ok: false, error: "Account not found." };
  if (!u.email) return { ok: true };
  const res = await verifyOtp(u.email, code.trim());
  if (!res.ok || res.userId !== userId) {
    return { ok: false, error: "That code is wrong or has expired. Request a new one." };
  }
  return { ok: true };
}

/** Writes a verified email or password-hash change. */
export async function applyProfileChange(
  userId: string,
  kind: ChangeKind,
  value: string,
): Promise<VerifyResult> {
  const set = kind === "email" ? { email: value } : { passwordHash: value };
  try {
    await db.update(users).set({ ...set, updatedAt: new Date() }).where(eq(users.id, userId));
  } catch {
    return { ok: false, error: "That email is already used by another account." };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Optional eFootball ID (display + copy; lets rivals add each other in-game)
// ---------------------------------------------------------------------------

export const EFOOTBALL_ID_MAX = 24;

/** Trimmed; letters, digits and hyphens; empty clears it. Returns null to clear. */
export function parseEfootballId(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "Enter your eFootball ID as text." };
  const v = raw.trim();
  if (v === "") return { ok: true, value: null };
  if (v.length > EFOOTBALL_ID_MAX || !/^[A-Za-z0-9-]+$/.test(v)) {
    return {
      ok: false,
      error: `Use up to ${EFOOTBALL_ID_MAX} letters, numbers or hyphens.`,
    };
  }
  return { ok: true, value: v };
}

export async function setEfootballId(userId: string, raw: string): Promise<VerifyResult & { value?: string | null }> {
  const parsed = parseEfootballId(raw);
  if (!parsed.ok) return parsed;
  await db
    .update(users)
    .set({ efootballId: parsed.value, updatedAt: new Date() })
    .where(eq(users.id, userId));
  return { ok: true, value: parsed.value };
}

/** Display name rule: trimmed, 2 to 50 characters. */
export function parseDisplayName(raw: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length < 2) return { ok: false, error: "Name must be at least 2 characters." };
  if (value.length > 50) return { ok: false, error: "Name must be at most 50 characters." };
  return { ok: true, value };
}

export async function setDisplayName(
  userId: string,
  raw: string,
): Promise<{ ok: true; value: string } | { ok: false; error: string }> {
  const parsed = parseDisplayName(raw);
  if (!parsed.ok) return parsed;
  const [row] = await db
    .update(users)
    .set({ displayName: parsed.value, updatedAt: new Date() })
    .where(and(eq(users.id, userId), eq(users.suspended, false)))
    .returning({ id: users.id });
  if (!row) return { ok: false, error: "Account not available." };
  return { ok: true, value: parsed.value };
}
