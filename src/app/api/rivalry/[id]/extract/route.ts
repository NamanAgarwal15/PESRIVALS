import { auth } from "@/auth";
import type { IngestFailureCode } from "@/lib/ingestors/types";
import { detectImageType } from "@/lib/image-bytes";
import { extractForMember } from "@/lib/match-helpers";
import { LIMITS, clientIpFromHeaders, consumeRateLimit } from "@/lib/rate-limit";

// 5 MB upload cap, enforced on the actual bytes (not just the declaration).
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Up to 6 Gemini attempts (3 models x 2 keys) inside a 50 second budget.
export const maxDuration = 60;

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const fail = (error: string, status: number) => json({ ok: false, error }, status);

const STATUS: Record<IngestFailureCode | "not_found", number> = {
  not_found: 404,
  invalid_image: 400,
  too_large: 413,
  not_stats_screen: 422,
  not_configured: 503,
  unavailable: 503,
  invalid_data: 400,
};

/**
 * Magic-byte check (see src/lib/image-bytes.ts, unit-tested there): a file is
 * only accepted when its actual header bytes look like PNG / JPEG / WebP.
 * Content-Type and file name are never trusted.
 */

// POST multipart/form-data with a `screenshot` file. The image is read into
// memory, sent to Gemini and dropped: it is never written to disk or the database.
export async function POST(
  request: Request,
  context: RouteContext<"/api/rivalry/[id]/extract">,
) {
  const session = await auth();
  if (!session?.user?.id) return fail("Log in to add a match.", 401);
  if (!session.user.onboarded) return fail("Finish setting up your account first.", 403);

  // Rate limit: max 20 uploads per hour per user.
  const rl = await consumeRateLimit(
    `extract:${session.user.id}`,
    LIMITS.matchExtract.max,
    LIMITS.matchExtract.windowMinutes,
  );
  if (!rl.ok) {
    return fail("Too many uploads. Try again in about an hour.", 429);
  }

  // Second bucket per client IP (trusted edge header first) against one IP using many accounts.
  const ip = clientIpFromHeaders(request.headers);
  if (ip) {
    const ipRl = await consumeRateLimit(
      `extract-ip:${ip}`,
      LIMITS.matchExtractIp.max,
      LIMITS.matchExtractIp.windowMinutes,
    );
    if (!ipRl.ok) return fail("Too many uploads from this network. Try again later.", 429);
  }

  // Multipart overhead is small; refuse clearly oversized bodies before reading them.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return fail("That image is too large to upload. Use a smaller screenshot.", 413);
  }

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("screenshot");
  } catch (err) {
    console.error(`[extract] could not parse upload: ${err instanceof Error ? err.name : "unknown"}`);
    return fail("Upload a PNG, JPG or WEBP screenshot.", 400);
  }
  if (!(file instanceof File)) return fail("Choose a screenshot to upload.", 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    return fail("That image is larger than 5 MB. Upload a smaller screenshot.", 413);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (detectImageType(bytes) === null) {
    // Not a real PNG/JPEG/WebP: refuse before Gemini ever sees it.
    return fail("That file is not a valid PNG, JPG or WEBP image.", 400);
  }

  const { id } = await context.params;
  try {
    const result = await extractForMember(session.user.id, id, { bytes });
    if (!result.ok) return fail(result.error, STATUS[result.code]);
    return json({ ok: true, extracted: result.extracted, confidence: result.confidence }, 200);
  } catch (err) {
    console.error(
      `[extract] unexpected failure: ${err instanceof Error ? `${err.name}: ${err.message}` : "unknown"}`,
    );
    // Never leak stack traces or provider details to the client.
    return fail("Could not read that screenshot. Try again.", 503);
  }
}

