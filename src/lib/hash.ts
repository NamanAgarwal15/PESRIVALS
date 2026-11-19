// One SHA-256 helper for server code (client fingerprinting uses Web Crypto in fingerprint.ts).
import { createHash } from "node:crypto";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}
