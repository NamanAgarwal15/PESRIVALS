// Security tests: password strength policy, password-reset tokens (hashing,
// expiry, single use), DB-backed rate limiting, and image magic-byte checks.
// Runs against the LOCAL TEST database and cleans up only its own rows.

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { passwordResetTokens, users } from "@/db/schema";
import { passwordSchema, signUpUser } from "@/lib/auth-helpers";
import { createPasswordResetToken, resetPasswordWithToken, sha256 } from "@/lib/password-reset";
import { clearRateLimit, consumeRateLimit } from "@/lib/rate-limit";
import { detectImageType } from "@/lib/image-bytes";

const RUN = randomBytes(4).toString("hex");
const createdUserIds = new Set<string>();
const rlKeys = new Set<string>();

async function makeUser(label: string) {
  const addr = `${RUN}.${label}@example.com`;
  const result = await signUpUser({
    username: `${RUN}_${label}`.slice(0, 20),
    displayName: "Security Test",
    password: "hunter2pass1",
    email: addr,
  });
  if (!result.ok) throw new Error(`signup failed: ${JSON.stringify(result.errors)}`);
  createdUserIds.add(result.user.id);
  return { user: result.user, email: addr };
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id)); // cascades reset tokens
  }
  for (const key of rlKeys) await clearRateLimit(key);
});

describe("password strength policy", () => {
  it("accepts 8+ characters with a letter and a number", () => {
    expect(passwordSchema.safeParse("correct-horse-1").success).toBe(true);
    expect(passwordSchema.safeParse("a1b2c3d4").success).toBe(true);
  });

  it("rejects short, letter-only, number-only and oversized passwords", () => {
    expect(passwordSchema.safeParse("ab1").success).toBe(false);
    expect(passwordSchema.safeParse("abcdefgh").success).toBe(false); // no number
    expect(passwordSchema.safeParse("12345678").success).toBe(false); // no letter
    expect(passwordSchema.safeParse("a1".repeat(100)).success).toBe(false); // > 128
  });
});

describe("password reset tokens", () => {
  it("stores only the SHA-256 hash, never the raw token", async () => {
    const { user, email } = await makeUser("hash");
    const result = await createPasswordResetToken(email, async () => "");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.token).toMatch(/^[0-9a-f]{64}$/);
    const [row] = await db
      .select({ tokenHash: passwordResetTokens.tokenHash })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.userId, user.id));
    expect(row.tokenHash).toBe(sha256(result.token));
    expect(row.tokenHash).not.toBe(result.token);
  });

  it("returns not_found for unknown identifiers without leaking anything", async () => {
    const result = await createPasswordResetToken(`${RUN}.nobody@example.com`, async () => "");
    expect(result).toEqual({ ok: false, code: "not_found" });
  });

  it("resets the password exactly once; reuse and wrong tokens fail", async () => {
    const { email } = await makeUser("reset");
    const result = await createPasswordResetToken(email, async () => "");
    if (!result.ok) throw new Error("token creation failed");
    const first = await resetPasswordWithToken(
      result.token,
      "$2b$12$fakehashvaluexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(first.ok).toBe(true);

    const second = await resetPasswordWithToken(
      result.token,
      "$2b$12$anotherfakehashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(second).toEqual({ ok: false, code: "invalid_token" });

    const wrong = await resetPasswordWithToken("0".repeat(64), "$2b$12$nope");
    expect(wrong).toEqual({ ok: false, code: "invalid_token" });
  });

  it("rejects expired tokens", async () => {
    const { email } = await makeUser("expired");
    const result = await createPasswordResetToken(email, async () => "");
    if (!result.ok) throw new Error("token creation failed");
    await db
      .update(passwordResetTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(passwordResetTokens.tokenHash, sha256(result.token)));
    const expired = await resetPasswordWithToken(
      result.token,
      "$2b$12$expiredfakehashxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    );
    expect(expired).toEqual({ ok: false, code: "invalid_token" });
  });
});

describe("db-backed rate limiting", () => {
  it("allows up to the limit and blocks after it", async () => {
    const key = `test:rl:${RUN}`;
    rlKeys.add(key);
    for (let i = 0; i < 3; i++) {
      expect((await consumeRateLimit(key, 3, 15)).ok).toBe(true);
    }
    expect((await consumeRateLimit(key, 3, 15)).ok).toBe(false);
    expect((await consumeRateLimit(`${key}:other`, 3, 15)).ok).toBe(true);
    rlKeys.add(`${key}:other`);
  });
});

describe("image magic-byte detection", () => {
  it("accepts real PNG, JPEG and WebP headers", () => {
    expect(
      detectImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    ).toBe("png");
    expect(detectImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(
      detectImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("webp");
  });

  it("rejects spoofed and non-image bytes", () => {
    expect(detectImageType(new Uint8Array([0x4d, 0x5a, 0x90, 0x00]))).toBeNull();
    expect(detectImageType(new TextEncoder().encode("<script>alert(1)</script>"))).toBeNull();
    expect(detectImageType(new Uint8Array([0xff]))).toBeNull();
    expect(detectImageType(new Uint8Array())).toBeNull();
  });
});
