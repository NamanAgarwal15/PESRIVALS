// Phase 7A: deterministic grid-crop + local OCR with invariant-gated Gemini fallback.
// Screenshots are synthetic (drawn from the OCR font into the normalised layout),
// so these tests exercise the pipeline, not real-game pixel fidelity.

import { readFileSync } from "node:fs";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearExtractionCache, extractionCacheKey, getCachedExtraction, putCachedExtraction } from "@/lib/extract-cache";
import { extractMatchFromScreenshot } from "@/lib/gemini-extract";
import { checkDimensions } from "@/lib/ocr/image-guard";
import { FONT_5X7 } from "@/lib/ocr/digit-ocr";
import { LANDSCAPE_LAYOUT, type Region } from "@/lib/ocr/layout";
import { checkInvariants } from "@/lib/ocr/invariants";
import { PIPELINE_VERSION, extractLocally } from "@/lib/ocr/local-extract";
import { STAT_KEYS } from "@/lib/match-stats";

const W = 1280;
const H = 720;

type Values = { goals: number } & Record<(typeof STAT_KEYS)[number], number>;
const GOOD: { left: Values; right: Values } = {
  left: { goals: 2, possession: 55, shots: 12, shots_on_target: 6, fouls: 3, offsides: 1, corners: 4, free_kicks: 5, passes: 310, successful_passes: 270, crosses: 7, interceptions: 8, tackles: 9, saves: 2 },
  right: { goals: 1, possession: 45, shots: 8, shots_on_target: 3, fouls: 4, offsides: 2, corners: 2, free_kicks: 6, passes: 250, successful_passes: 200, crosses: 5, interceptions: 6, tackles: 11, saves: 4 },
};

function drawText(buf: Uint8Array, r: Region, text: string) {
  const scale = 3;
  const gw = 5 * scale;
  const total = text.length * gw + (text.length - 1) * scale * 2;
  let x = Math.floor(r.x * W) + 6 + (0 * total);
  const y = Math.floor(r.y * H) + Math.floor((r.h * H - 7 * scale) / 2);
  for (const ch of text) {
    const rows = FONT_5X7[ch];
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (rows[ry][rx] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) buf[(y + ry * scale + dy) * W + x + rx * scale + dx] = 240;
      }
    }
    x += gw + scale * 2;
  }
}

async function screenshot(v = GOOD): Promise<Uint8Array> {
  const buf = new Uint8Array(W * H).fill(30);
  for (const side of ["left", "right"] as const) {
    drawText(buf, LANDSCAPE_LAYOUT.goals[side], String(v[side].goals));
    for (const k of STAT_KEYS) drawText(buf, LANDSCAPE_LAYOUT.stats[k][side], k === "possession" ? `${v[side][k]}%` : String(v[side][k]));
  }
  return new Uint8Array(await sharp(buf, { raw: { width: W, height: H, channels: 1 } }).png().toBuffer());
}

function geminiBody(side: Values, team: string) {
  return { team, ...side };
}
function mockGemini() {
  const payload = {
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      is_valid_efootball_stats_screen: true, rejection_reason: null,
      left: geminiBody(GOOD.left, "Reds"), right: geminiBody(GOOD.right, "Blues"), low_confidence_fields: [],
    }) }] } }],
  };
  const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response);
  vi.stubGlobal("fetch", spy);
  return spy;
}

beforeEach(() => {
  vi.stubEnv("GEMINI_API_KEY_1", "test-key-1-not-real");
  vi.stubEnv("LOCAL_OCR", "on");
  clearExtractionCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("local grid-crop OCR", () => {
  it("reads an invariant-passing screenshot with zero Gemini calls", async () => {
    const spy = mockGemini();
    const png = await screenshot();
    const local = await extractLocally(png);
    expect(local.ok).toBe(true);
    if (local.ok) {
      expect(local.extracted.left).toMatchObject({ goals: 2, possession: 55, shots: 12, passes: 310, saves: 2 });
      expect(local.extracted.right).toMatchObject({ goals: 1, possession: 45, tackles: 11 });
      expect(local.confidence.hasYellow).toBe(false);
    }
    const r = await extractMatchFromScreenshot({ bytes: png });
    expect(r.ok && r.via).toBe("local");
    expect(spy).not.toHaveBeenCalled();
  });

  it("is off by default: Gemini is used when LOCAL_OCR is not on", async () => {
    vi.stubEnv("LOCAL_OCR", "");
    const spy = mockGemini();
    const r = await extractMatchFromScreenshot({ bytes: await screenshot() });
    expect(r.ok && r.via).toBe("gemini");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back to Gemini when a domain invariant fails (possession 55 + 25)", async () => {
    const bad = { left: GOOD.left, right: { ...GOOD.right, possession: 25 } };
    const png = await screenshot(bad);
    expect((await extractLocally(png))).toEqual({ ok: false, reason: "invariants" });
    const spy = mockGemini();
    const r = await extractMatchFromScreenshot({ bytes: png });
    expect(r.ok && r.via).toBe("gemini");
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("falls back on unreadable cells (blank screen) and unmapped aspect ratios", async () => {
    const blank = new Uint8Array(await sharp({ create: { width: W, height: H, channels: 3, background: "#222" } }).png().toBuffer());
    expect(await extractLocally(blank)).toEqual({ ok: false, reason: "unreadable" });
    const portrait = new Uint8Array(await sharp({ create: { width: 720, height: 1280, channels: 3, background: "#222" } }).png().toBuffer());
    expect(await extractLocally(portrait)).toEqual({ ok: false, reason: "no_layout" });
    const spy = mockGemini();
    expect((await extractMatchFromScreenshot({ bytes: blank })).ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("refuses a decompression bomb from the header alone, without calling Gemini", async () => {
    // Valid PNG signature + IHDR declaring 60000 x 60000 pixels, then nothing.
    const bomb = new Uint8Array(33);
    bomb.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(bomb.buffer).setUint32(16, 60000);
    new DataView(bomb.buffer).setUint32(20, 60000);
    expect(checkDimensions(bomb)).toEqual({ ok: false, reason: "oversized" });
    const spy = mockGemini();
    const r = await extractMatchFromScreenshot({ bytes: bomb });
    expect(r).toMatchObject({ ok: false, code: "too_large" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats malformed images as a local miss, never a crash", async () => {
    const png = await screenshot();
    const truncated = png.slice(0, 200);
    const local = await extractLocally(truncated);
    expect(local.ok).toBe(false);
    expect(await extractLocally(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4, 5, 6, 7, 8]))).toMatchObject({ ok: false });
  });

  it("strips metadata: the decode path never re-encodes or keeps EXIF", () => {
    const src = readFileSync("src/lib/ocr/local-extract.ts", "utf8");
    expect(src).toContain(".rotate()");
    expect(src).toContain(".raw()");
    expect(src).not.toContain("withMetadata");
    expect(src).toContain("limitInputPixels");
  });
});

describe("invariants", () => {
  const side = GOOD.left;
  const full = (o: Partial<Values>) => ({ team: "x", ...side, ...o });
  it("accepts a consistent match and rejects each violation", () => {
    const mk = (l: Partial<Values>, r: Partial<Values>) => checkInvariants({ left: full(l), right: { ...full(GOOD.right), ...r } } as never);
    expect(mk({}, {})).toEqual([]);
    expect(mk({ shots_on_target: 99 }, {})).not.toEqual([]);
    expect(mk({ goals: 9 }, {})).not.toEqual([]); // goals > shots on target
    expect(mk({ successful_passes: 999 }, {})).not.toEqual([]);
    expect(mk({ possession: 70 }, {})).not.toEqual([]);
  });
});

describe("quota and cache", () => {
  it("charges extraction quota once per request: the pipeline never touches rate limits", () => {
    for (const f of ["src/lib/ocr/local-extract.ts", "src/lib/gemini-extract.ts", "src/lib/ocr/digit-ocr.ts"]) {
      expect(readFileSync(f, "utf8")).not.toContain("rate-limit");
    }
    const route = readFileSync("src/app/api/rivalry/[id]/extract/route.ts", "utf8");
    expect(route.match(/consumeRateLimit\(\s*`extract:/g)).toHaveLength(1);
    expect(route.match(/dailyKey\("extract"/g)).toHaveLength(1);
  });

  it("a fallback request uses one Gemini call path for one quota unit", async () => {
    const spy = mockGemini();
    const blank = new Uint8Array(await sharp({ create: { width: W, height: H, channels: 3, background: "#222" } }).png().toBuffer());
    await extractMatchFromScreenshot({ bytes: blank });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("cache keys are bytes + pipelineVersion, so a new version never replays an old parse", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(extractionCacheKey(bytes)).toBe(extractionCacheKey(bytes, PIPELINE_VERSION));
    expect(extractionCacheKey(bytes, "7a.1")).not.toBe(extractionCacheKey(bytes, "7a.2"));
    const value = { ok: true as const, extracted: {} as never, confidence: {} as never };
    putCachedExtraction(extractionCacheKey(bytes, "old"), value);
    expect(getCachedExtraction(extractionCacheKey(bytes, "old"))).not.toBeNull();
    expect(getCachedExtraction(extractionCacheKey(bytes, "new"))).toBeNull();
  });
});
