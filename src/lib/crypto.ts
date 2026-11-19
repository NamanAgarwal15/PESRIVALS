// AES-256-GCM for small secrets at rest (Web Push keys). Framework-free.
// Format: "v1:<iv>:<tag>:<ciphertext>" (base64url). PUSH_ENCRYPTION_KEY is 32
// bytes as base64 or 64 hex characters.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function loadKey(): Buffer {
  const raw = process.env.PUSH_ENCRYPTION_KEY?.trim();
  if (!raw) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("PUSH_ENCRYPTION_KEY is not set");
    }
    // Local development and tests only: a fixed derived key, never used in production.
    return createHash("sha256").update("pesrivals-dev-only-push-key").digest();
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("PUSH_ENCRYPTION_KEY must decode to 32 bytes");
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, loadKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(":");
}

/** Throws on a wrong key, tampering or a malformed value. */
export function decryptSecret(payload: string): string {
  const [version, iv, tag, ct] = payload.split(":");
  if (version !== "v1" || !iv || !tag || !ct) throw new Error("Malformed encrypted value");
  const decipher = createDecipheriv(ALGO, loadKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}
