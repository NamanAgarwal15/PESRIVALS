// Header-only image dimension reader plus hard caps. Runs BEFORE any decoder
// touches the bytes, so a tiny file that declares a huge bitmap (decompression
// bomb) is refused without allocating anything. Pure and framework-free.
// OWASP A08:2025 (data integrity), A10:2025 (unbounded resource use).

export const MAX_IMAGE_SIDE = 4096;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MIN_IMAGE_SIDE = 240;

export type Dimensions = { width: number; height: number };

export type DimensionCheck =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: "unreadable" | "oversized" | "tiny" };

const u32be = (b: Uint8Array, i: number) =>
  ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u16be = (b: Uint8Array, i: number) => (b[i] << 8) | b[i + 1];
const u24le = (b: Uint8Array, i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const ascii = (b: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...b.subarray(from, to));

function pngSize(b: Uint8Array): Dimensions | null {
  if (b.length < 24 || ascii(b, 12, 16) !== "IHDR") return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b: Uint8Array): Dimensions | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    // Stand-alone markers carry no length.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      i += 2;
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    const len = u16be(b, i + 2);
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Uint8Array): Dimensions | null {
  if (b.length < 30) return null;
  const kind = ascii(b, 12, 16);
  if (kind === "VP8 ") {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  if (kind === "VP8L") {
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8X") {
    return { width: u24le(b, 24) + 1, height: u24le(b, 27) + 1 };
  }
  return null;
}

export function readDimensions(bytes: Uint8Array): Dimensions | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return pngSize(bytes);
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegSize(bytes);
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return webpSize(bytes);
  }
  return null;
}

export function checkDimensions(bytes: Uint8Array): DimensionCheck {
  const dims = readDimensions(bytes);
  if (!dims || dims.width < 1 || dims.height < 1) return { ok: false, reason: "unreadable" };
  if (
    dims.width > MAX_IMAGE_SIDE ||
    dims.height > MAX_IMAGE_SIDE ||
    dims.width * dims.height > MAX_IMAGE_PIXELS
  ) {
    return { ok: false, reason: "oversized" };
  }
  if (dims.width < MIN_IMAGE_SIDE || dims.height < MIN_IMAGE_SIDE) return { ok: false, reason: "tiny" };
  return { ok: true, ...dims };
}
