// Bounded in-memory cache of validated screenshot extractions, keyed by the
// SHA-256 of the image bytes, so re-uploading the same file never calls
// Gemini again. Per server instance and best effort; nothing is persisted.

import { sha256Hex } from "@/lib/hash";
import { PIPELINE_VERSION } from "@/lib/ocr/local-extract";
import type { IngestResult } from "@/lib/ingestors/types";

type Ok = Extract<IngestResult, { ok: true }>;

export const EXTRACT_CACHE_MAX = 50;
export const EXTRACT_CACHE_TTL_MS = 60 * 60 * 1000;

const store = new Map<string, { at: number; value: Ok }>();

export { sha256Hex };

/**
 * Cache key = SHA-256 of the bytes + the pipeline version, so a new layout/OCR
 * revision never replays an extraction made by an older (possibly wrong) one.
 */
export function extractionCacheKey(bytes: Uint8Array, version: string = PIPELINE_VERSION): string {
  return `${sha256Hex(bytes)}:${version}`;
}

export function getCachedExtraction(hash: string, now = Date.now()): Ok | null {
  const hit = store.get(hash);
  if (!hit) return null;
  if (now - hit.at > EXTRACT_CACHE_TTL_MS) {
    store.delete(hash);
    return null;
  }
  // Refresh recency (Map keeps insertion order).
  store.delete(hash);
  store.set(hash, hit);
  return hit.value;
}

export function putCachedExtraction(hash: string, value: Ok, now = Date.now()): void {
  store.delete(hash);
  store.set(hash, { at: now, value });
  while (store.size > EXTRACT_CACHE_MAX) {
    const oldest = store.keys().next().value;
    if (oldest === undefined) break;
    store.delete(oldest);
  }
}

export function clearExtractionCache(): void {
  store.clear();
}
