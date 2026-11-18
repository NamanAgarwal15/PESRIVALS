// Password reset tokens: 32-byte crypto-random tokens, stored only as SHA-256
// hashes, single-use, expiring after 15 minutes. Framework-free (no next/*
// imports) so it can be exercised directly by Vitest.

import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";

export const RESET_TOKEN_MINUTES = 15;

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export type ResetRequestResult =
  | { ok: true; userId: string; email: string | null; token: string }
  | { ok: false; code: "not_found" };

export type ResetPasswordResult =
  | { ok: true; userId: string }
  | { ok: false; code: "invalid_token" | "weak_password" };

/**
 * Looks the user up by email and creates a fresh reset token.
 * The raw token is returned once for the reset link; only its SHA-256 hash
 * is persisted.
 */
export async function createPasswordResetToken(
  identifier: string,
  passwordHash: (pw: string) => Promise<string>,
): Promise<ResetRequestResult> {
  const email = identifier.trim().toLowerCase();
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.email, email));
  if (!user) return { ok: false, code: "not_found" };

  const token = randomBytes(32).toString("hex");
  await db.insert(passwordResetTokens).values({
    userId: user.id,
    tokenHash: sha256(token),
    expiresAt: new Date(Date.now() + RESET_TOKEN_MINUTES * 60 * 1000),
  });
  // Caller is expected to have hashed the CURRENT password separately; the
  // parameter keeps this module bcrypt-free and unit-testable.
  void passwordHash;
  return { ok: true, userId: user.id, email: user.email, token };
}

/**
 * Validates a raw reset token (hash match, not expired, not used) and sets
 * the new bcrypt password hash. Marks the token used exactly once.
 */
export async function resetPasswordWithToken(
  token: string,
  newPasswordHash: string,
): Promise<ResetPasswordResult> {
  const tokenHash = sha256(token);
  const [row] = await db
    .select({ id: passwordResetTokens.id, userId: passwordResetTokens.userId })
    .from(passwordResetTokens)
    .where(
      and(
        eq(passwordResetTokens.tokenHash, tokenHash),
        gt(passwordResetTokens.expiresAt, new Date()),
        isNull(passwordResetTokens.usedAt),
      ),
    );
  if (!row) return { ok: false, code: "invalid_token" };

  // Atomically claim the token first: the WHERE clause makes a second use a no-op.
  const claimed = await db
    .update(passwordResetTokens)
    .set({ usedAt: new Date() })
    .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)))
    .returning({ id: passwordResetTokens.id });
  if (!claimed.length) return { ok: false, code: "invalid_token" };

  await db
    .update(users)
    .set({ passwordHash: newPasswordHash, updatedAt: new Date() })
    .where(eq(users.id, row.userId));
  return { ok: true, userId: row.userId };
}
