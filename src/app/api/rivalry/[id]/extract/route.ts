import { auth } from "@/auth";
import type { ExtractFailureCode } from "@/lib/gemini-extract";
import { extractForMember } from "@/lib/match-helpers";
import { SCREENSHOT_MAX_BYTES } from "@/lib/match-stats";

// Up to 6 Gemini attempts (3 models x 2 keys) inside a 50 second budget.
export const maxDuration = 60;

const json = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

const fail = (error: string, status: number) => json({ ok: false, error }, status);

const STATUS: Record<ExtractFailureCode | "not_found", number> = {
  not_found: 404,
  invalid_image: 400,
  too_large: 413,
  not_stats_screen: 422,
  not_configured: 503,
  unavailable: 503,
};

// POST multipart/form-data with a `screenshot` file. The image is read into
// memory, sent to Gemini and dropped: it is never written to disk or the database.
export async function POST(
  request: Request,
  context: RouteContext<"/api/rivalry/[id]/extract">,
) {
  const session = await auth();
  if (!session?.user?.id) return fail("Log in to add a match.", 401);
  if (!session.user.onboarded) return fail("Finish setting up your account first.", 403);

  // Multipart overhead is small; refuse clearly oversized bodies before reading them.
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > SCREENSHOT_MAX_BYTES + 64 * 1024) {
    return fail("That image is larger than 8 MB. Upload a smaller screenshot.", 413);
  }

  let file: FormDataEntryValue | null;
  try {
    file = (await request.formData()).get("screenshot");
  } catch {
    return fail("Upload a PNG, JPG or WEBP screenshot.", 400);
  }
  if (!(file instanceof File)) return fail("Choose a screenshot to upload.", 400);
  if (file.size > SCREENSHOT_MAX_BYTES) {
    return fail("That image is larger than 8 MB. Upload a smaller screenshot.", 413);
  }

  const { id } = await context.params;
  const result = await extractForMember(session.user.id, id, {
    bytes: new Uint8Array(await file.arrayBuffer()),
  });

  if (!result.ok) return fail(result.error, STATUS[result.code]);
  return json({ ok: true, extracted: result.extracted }, 200);
}
