// Device fingerprint. The collector runs in the browser and sends ONLY a
// SHA-256 hex digest; raw canvas/WebGL data never leaves the device. Signals
// are hardware/rendering based (not IP), so a VPN does not change the hash.
// Client-safe: no Node imports here.

export const FINGERPRINT_RE = /^[0-9a-f]{64}$/;

/** Server-side normalizer: accepts a lowercase-able 64-char hex digest, else null. */
export function normalizeFingerprintHash(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return FINGERPRINT_RE.test(v) ? v : null;
}

export type FingerprintSignals = Record<string, string | number | null>;

/** Stable string for a set of signals (sorted keys), the input to the hash. */
export function canonicalizeSignals(signals: FingerprintSignals): string {
  return Object.keys(signals)
    .sort()
    .map((k) => `${k}=${signals[k] ?? ""}`)
    .join("|");
}

export async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function webglInfo(): { vendor: string; renderer: string } {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    const ext = gl?.getExtension("WEBGL_debug_renderer_info");
    if (gl && ext) {
      return {
        vendor: String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)),
        renderer: String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)),
      };
    }
  } catch {
    // ignore
  }
  return { vendor: "", renderer: "" };
}

async function canvasDigest(): Promise<string> {
  try {
    const c = document.createElement("canvas");
    c.width = 200;
    c.height = 50;
    const ctx = c.getContext("2d");
    if (!ctx) return "";
    ctx.textBaseline = "top";
    ctx.font = "16px Arial";
    ctx.fillStyle = "#f60";
    ctx.fillRect(10, 5, 80, 30);
    ctx.fillStyle = "#069";
    ctx.fillText("PESRIVALS fp 1.0", 4, 12);
    // Only a digest of the pixel data is kept, never the buffer.
    return await sha256Hex(c.toDataURL());
  } catch {
    return "";
  }
}

/** Collects the signals in the browser and returns their SHA-256 hex digest. */
export async function collectFingerprintHash(): Promise<string> {
  const gl = webglInfo();
  const nav = navigator as Navigator & { deviceMemory?: number };
  const signals: FingerprintSignals = {
    glVendor: gl.vendor,
    glRenderer: gl.renderer,
    canvas: await canvasDigest(),
    cores: nav.hardwareConcurrency ?? null,
    memory: nav.deviceMemory ?? null,
    touch: nav.maxTouchPoints ?? null,
    screen: `${screen.width}x${screen.height}`,
    dpr: window.devicePixelRatio,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    platform: nav.platform,
  };
  return sha256Hex(canonicalizeSignals(signals));
}
