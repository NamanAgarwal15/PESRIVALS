// HMAC proof that a set of match numbers came out of the screenshot reader for THIS user,
// THIS rivalry and THIS image, recently. Framework-free, no network, no database.
//
// The browser gets the signature with the extraction and sends it back on save. Without a valid
// signature (numbers edited, another user's token, wrong rivalry, expired) the match is still saved
// but is marked unverified and needs review, and unverified matches never settle a clan-war slot.

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ExtractedMatch } from "@/lib/match-schema";
import { STAT_KEYS } from "@/lib/match-stats";

export const SIGNATURE_TTL_MS = 30 * 60 * 1000;

const secret = (): Buffer | null => {
  const raw = process.env.EXTRACT_SIGNING_SECRET || process.env.AUTH_SECRET;
  if (!raw) return null;
  // Derived key: the session secret itself is never used directly as an HMAC key.
  return createHmac("sha256", raw).update("pesrivals:extract-signature:v1").digest();
};

/** SHA-256 of the image bytes (hex). Stored with verified matches so one screenshot is one match. */
export const screenshotHashOf = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Every value that matters, in a fixed order, so the same numbers always sign the same way. */
function canonical(extracted: ExtractedMatch): string {
  const side = (s: ExtractedMatch["left"]) => [s.team, s.goals, ...STAT_KEYS.map((k) => s[k] ?? null)];
  return JSON.stringify([side(extracted.left), side(extracted.right)]);
}

function mac(key: Buffer, p: { rivalryId: string; userId: string; screenshotHash: string; exp: number; extracted: ExtractedMatch }): string {
  return createHmac("sha256", key)
    .update(["v1", p.rivalryId, p.userId, p.screenshotHash, String(p.exp), canonical(p.extracted)].join("|"))
    .digest("hex");
}

export function signExtraction(p: {
  rivalryId: string;
  userId: string;
  screenshotHash: string;
  extracted: ExtractedMatch;
  now?: number;
}): string | null {
  const key = secret();
  if (!key) return null;
  const exp = (p.now ?? Date.now()) + SIGNATURE_TTL_MS;
  return `${exp}.${mac(key, { ...p, exp })}`;
}

export function verifyExtraction(
  signature: unknown,
  p: { rivalryId: string; userId: string; screenshotHash: unknown; extracted: ExtractedMatch; now?: number },
): boolean {
  const key = secret();
  if (!key || typeof signature !== "string" || typeof p.screenshotHash !== "string") return false;
  const [expRaw, given] = signature.split(".");
  const exp = Number(expRaw);
  if (!Number.isSafeInteger(exp) || exp < (p.now ?? Date.now()) || !given || !/^[0-9a-f]{64}$/.test(given)) return false;
  const want = mac(key, { rivalryId: p.rivalryId, userId: p.userId, screenshotHash: p.screenshotHash, exp, extracted: p.extracted });
  return timingSafeEqual(Buffer.from(want, "hex"), Buffer.from(given, "hex"));
}
