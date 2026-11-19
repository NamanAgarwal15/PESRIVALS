// Browser-only helpers for the upload panel: image shrinking and "last host" memory.

export type Host = "home" | "away";

// Vercel rejects request bodies over 4.5 MB (before our route runs), so every
// phone-sized screenshot is re-encoded in the browser: max 1600px, JPEG 0.85.
const DOWNSCALE_ABOVE_BYTES = 1 * 1024 * 1024;
const DOWNSCALE_MAX_EDGE = 1600;
export const UPLOAD_LIMIT_BYTES = 4 * 1024 * 1024;

// Remembers the last host (Me / Rival) per rivalry for the rest of the day, so
// back-to-back games default automatically. Best effort: storage may be blocked.
const hostKey = (rivalryId: string) => `pesrivals:lastHost:${rivalryId}`;
const today = () => new Date().toLocaleDateString("en-CA");

export function readRememberedHost(rivalryId: string): Host | null {
  try {
    const raw = JSON.parse(localStorage.getItem(hostKey(rivalryId)) ?? "null") as { host?: string; date?: string } | null;
    if (raw?.date === today() && (raw.host === "home" || raw.host === "away")) return raw.host;
  } catch {
    // ignore
  }
  return null;
}

export function rememberHost(rivalryId: string, host: Host) {
  try {
    localStorage.setItem(hostKey(rivalryId), JSON.stringify({ host, date: today() }));
  } catch {
    // ignore
  }
}

export async function shrinkIfLarge(file: File): Promise<File> {
  if (file.size <= DOWNSCALE_ABOVE_BYTES) return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, DOWNSCALE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (blob && blob.size < file.size) {
      return new File([blob], "screenshot.jpg", { type: "image/jpeg" });
    }
  } catch {
    // Fall through and upload the original.
  }
  return file;
}
