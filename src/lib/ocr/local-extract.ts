// Deterministic grid-crop + local OCR for the standard Full Time screen.
// Everything here is local CPU work: no network, no Gemini tokens.
//
//   bytes -> header dimension caps -> sharp decode (pixel-limited, EXIF
//   rotated, metadata dropped) -> canonical width -> normalised grid crops
//   -> digit OCR -> schema + domain invariants -> ExtractedMatch
//
// Any problem returns { ok: false } with a reason, and the caller falls back to
// Gemini. The only hard refusal is a declared bitmap above the pixel caps.
//
// `sharp` is imported lazily so routes that never reach this code (and cold
// starts with the feature off) do not load the native binary.

import { assessConfidence, type ConfidenceReport } from "@/lib/confidence";
import { type ExtractedMatch, extractedMatchSchema } from "@/lib/match-schema";
import { STAT_KEYS } from "@/lib/match-stats";
import { type Gray, readInteger } from "@/lib/ocr/digit-ocr";
import { MAX_IMAGE_PIXELS, checkDimensions } from "@/lib/ocr/image-guard";
import { type Region, layoutFor } from "@/lib/ocr/layout";
import { checkInvariants } from "@/lib/ocr/invariants";

/**
 * Bump on ANY change to layout, OCR, thresholds or invariants. It is part of
 * the extraction cache key, so a revision never replays a stale misparse.
 */
export const PIPELINE_VERSION = "7a.1";

export const CANONICAL_WIDTH = 1280;
// Below this confidence the whole screenshot goes to Gemini.
const MIN_CELL_CONFIDENCE = 0.8;

export function localOcrEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LOCAL_OCR === "on";
}

export type LocalResult =
  | { ok: true; extracted: ExtractedMatch; confidence: ConfidenceReport }
  | { ok: false; reason: "oversized" | "tiny" | "decode_failed" | "no_layout" | "unreadable" | "invariants" | "schema" | "disabled" };

// Team names are text, which a digit reader cannot read. Neutral labels keep
// the existing "which side were you" step working; the user can still tell
// the sides apart by the Left / Right headings.
const TEAM = { left: "Left team", right: "Right team" } as const;

function crop(img: Gray, r: Region): Gray {
  const x0 = Math.max(0, Math.floor(r.x * img.width));
  const y0 = Math.max(0, Math.floor(r.y * img.height));
  const x1 = Math.min(img.width, Math.ceil((r.x + r.w) * img.width));
  const y1 = Math.min(img.height, Math.ceil((r.y + r.h) * img.height));
  const width = Math.max(0, x1 - x0);
  const height = Math.max(0, y1 - y0);
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    data.set(img.data.subarray((y0 + y) * img.width + x0, (y0 + y) * img.width + x0 + width), y * width);
  }
  return { data, width, height };
}

async function decodeGray(bytes: Uint8Array): Promise<Gray | null> {
  try {
    const sharp = (await import("sharp")).default;
    sharp.cache(false);
    const { data, info } = await sharp(bytes, {
      limitInputPixels: MAX_IMAGE_PIXELS, // second line of defence behind the header check
      failOn: "error",
      sequentialRead: true,
    })
      .rotate() // honour EXIF orientation, then the output carries no metadata at all
      .resize({ width: CANONICAL_WIDTH, withoutEnlargement: false })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(data), width: info.width, height: info.height };
  } catch {
    return null;
  }
}

export async function extractLocally(bytes: Uint8Array): Promise<LocalResult> {
  const dims = checkDimensions(bytes);
  if (!dims.ok) {
    if (dims.reason === "oversized") return { ok: false, reason: "oversized" };
    if (dims.reason === "tiny") return { ok: false, reason: "tiny" };
    return { ok: false, reason: "decode_failed" };
  }

  const layout = layoutFor(dims.width, dims.height);
  if (!layout) return { ok: false, reason: "no_layout" };

  const img = await decodeGray(bytes);
  if (!img) return { ok: false, reason: "decode_failed" };

  const sides = { left: {} as Record<string, unknown>, right: {} as Record<string, unknown> };
  for (const side of ["left", "right"] as const) {
    sides[side].team = TEAM[side];
    const goals = readInteger(crop(img, layout.goals[side]));
    if (!goals.ok || goals.confidence < MIN_CELL_CONFIDENCE) return { ok: false, reason: "unreadable" };
    sides[side].goals = goals.value;
    for (const key of STAT_KEYS) {
      const cell = readInteger(crop(img, layout.stats[key][side]));
      if (!cell.ok || cell.confidence < MIN_CELL_CONFIDENCE) return { ok: false, reason: "unreadable" };
      sides[side][key] = cell.value;
    }
  }

  const parsed = extractedMatchSchema.safeParse(sides);
  if (!parsed.success) return { ok: false, reason: "schema" };
  if (checkInvariants(parsed.data).length) return { ok: false, reason: "invariants" };

  return { ok: true, extracted: parsed.data, confidence: assessConfidence(parsed.data) };
}
