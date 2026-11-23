// Tiny local digit / percent recogniser. Pure TypeScript, no native code, no
// network, no model download. It works on one small greyscale crop at a time:
//   1. Otsu threshold, ink = the minority colour (works on light-on-dark and
//      dark-on-light UI text alike),
//   2. column-projection segmentation into glyphs,
//   3. each glyph is cropped to its bounding box, area-resampled to 10x14 and
//      compared with templates built from a 5x7 bitmap font.
// A read is only returned when every glyph matches clearly (small distance AND
// a margin over the runner-up); otherwise the cell is "unreadable" and the
// pipeline hands the whole screenshot to Gemini. Wrong-but-confident reads are
// the real risk, so the thresholds err on the side of refusing.

export type Gray = { data: Uint8Array; width: number; height: number };

export type CellRead =
  | { ok: true; value: number; confidence: number }
  | { ok: false; reason: "empty" | "unreadable" };

const GW = 10;
const GH = 14;
const MAX_DISTANCE = 0.2;
const MIN_MARGIN = 0.05;
const MAX_GLYPHS = 4;

const FONT: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "%": ["11001", "11010", "00010", "00100", "01000", "01011", "10011"],
};

/** The 5x7 font as rows of 0/1, exposed so tests can draw synthetic screenshots. */
export const FONT_5X7 = FONT;

// Area-average resample of an ink grid (0..1) to GW x GH.
function resample(ink: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(GW * GH);
  for (let oy = 0; oy < GH; oy++) {
    const y0 = (oy * h) / GH;
    const y1 = ((oy + 1) * h) / GH;
    for (let ox = 0; ox < GW; ox++) {
      const x0 = (ox * w) / GW;
      const x1 = ((ox + 1) * w) / GW;
      let sum = 0;
      let area = 0;
      for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          sum += ink[y * w + x] * wx * wy;
          area += wx * wy;
        }
      }
      out[oy * GW + ox] = area > 0 ? sum / area : 0;
    }
  }
  return out;
}

const TEMPLATES: { ch: string; grid: Float32Array }[] = Object.entries(FONT).map(([ch, rows]) => {
  // Crop to the ink bounding box exactly like a scanned glyph, so narrow
  // glyphs such as "1" are compared at the same aspect.
  const cols = [...Array(5).keys()].filter((x) => rows.some((r) => r[x] === "1"));
  const x0 = Math.min(...cols);
  const w = Math.max(...cols) - x0 + 1;
  const ink = new Float32Array(w * 7);
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) ink[y * w + x] = row[x0 + x] === "1" ? 1 : 0;
  });
  return { ch, grid: resample(ink, w, 7) };
});

function otsu(data: Uint8Array): number {
  const hist = new Array<number>(256).fill(0);
  for (const v of data) hist[v]++;
  const total = data.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let threshold = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) {
      best = between;
      threshold = t;
    }
  }
  return threshold;
}

/** Binary ink map (1 = glyph pixel), or null when the crop has no usable contrast. */
function inkMap(crop: Gray): Uint8Array | null {
  let min = 255;
  let max = 0;
  for (const v of crop.data) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (max - min < 40) return null; // flat region: nothing to read
  const t = otsu(crop.data);
  const ink = new Uint8Array(crop.data.length);
  let bright = 0;
  for (let i = 0; i < ink.length; i++) {
    if (crop.data[i] > t) {
      ink[i] = 1;
      bright++;
    }
  }
  // Ink is the minority colour.
  if (bright > ink.length / 2) for (let i = 0; i < ink.length; i++) ink[i] ^= 1;
  return ink;
}

function classify(grid: Float32Array): { ch: string; distance: number; margin: number } {
  let best = { ch: "?", d: Infinity };
  let second = Infinity;
  for (const t of TEMPLATES) {
    let d = 0;
    for (let i = 0; i < grid.length; i++) d += Math.abs(grid[i] - t.grid[i]);
    d /= grid.length;
    if (d < best.d) {
      second = best.d;
      best = { ch: t.ch, d };
    } else if (d < second) second = d;
  }
  return { ch: best.ch, distance: best.d, margin: second - best.d };
}

/** Reads a non-negative integer (a trailing "%" is allowed and ignored). */
export function readInteger(crop: Gray): CellRead {
  const ink = inkMap(crop);
  if (!ink) return { ok: false, reason: "empty" };
  const { width: w, height: h } = crop;

  const colInk = new Uint16Array(w);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) colInk[x] += ink[y * w + x];

  // Runs of inked columns; a 1-column hole never splits a glyph.
  const runs: [number, number][] = [];
  let start = -1;
  let gap = 0;
  for (let x = 0; x < w; x++) {
    if (colInk[x] > 0) {
      if (start < 0) start = x;
      gap = 0;
    } else if (start >= 0 && ++gap > 1) {
      runs.push([start, x - gap]);
      start = -1;
      gap = 0;
    }
  }
  if (start >= 0) runs.push([start, w - 1 - gap]);
  if (!runs.length) return { ok: false, reason: "empty" };
  if (runs.length > MAX_GLYPHS) return { ok: false, reason: "unreadable" };

  let digits = "";
  let worst = 0;
  for (const [x0, x1] of runs) {
    const gw = x1 - x0 + 1;
    let y0 = h;
    let y1 = -1;
    for (let y = 0; y < h; y++) {
      for (let x = x0; x <= x1; x++) {
        if (ink[y * w + x]) {
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
          break;
        }
      }
    }
    const gh = y1 - y0 + 1;
    // Specks and hairlines are noise, not digits.
    if (gh < h * 0.35 || gw < 2) return { ok: false, reason: "unreadable" };
    const cell = new Float32Array(gw * gh);
    for (let y = 0; y < gh; y++) for (let x = 0; x < gw; x++) cell[y * gw + x] = ink[(y0 + y) * w + x0 + x];
    const hit = classify(resample(cell, gw, gh));
    if (hit.distance > MAX_DISTANCE || hit.margin < MIN_MARGIN) return { ok: false, reason: "unreadable" };
    worst = Math.max(worst, hit.distance);
    if (hit.ch !== "%") digits += hit.ch;
  }
  if (!digits || digits.length > 4) return { ok: false, reason: "unreadable" };
  return { ok: true, value: Number(digits), confidence: 1 - worst };
}
