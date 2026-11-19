import { auth } from "@/auth";
import { refreshSessionUser } from "@/lib/auth-helpers";
import {
  REFUSAL, aiConfigured, buildCoachContext, checkCoachLimits, deterministicCoachReply,
  generateCoachReply, looksLikeInjection, validateChatBody,
} from "@/lib/coach-chat";
import { sameOrigin } from "@/lib/push-route";
import { clientIpFromHeaders } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

export const maxDuration = 30;

const json = (body: unknown, status: number) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

// POST { message, history?: [{role:"user"|"assistant", content}], rivalryId? }
// The client never supplies a user id, a system prompt, or any telemetry.
export async function POST(request: Request) {
  if (!sameOrigin(request)) return json({ ok: false, error: "Forbidden" }, 403);
  const session = await auth();
  if (!session?.user?.id) return json({ ok: false, error: "Log in first." }, 401);
  try {
    // Active, non-suspended account, checked against the database.
    if (!(await refreshSessionUser(session.user.id))) return json({ ok: false, error: "Forbidden" }, 403);

    if (Number(request.headers.get("content-length") ?? 0) > 16 * 1024) return json({ ok: false, error: "Request too large." }, 413);
    const checked = validateChatBody(await request.json().catch(() => null));
    if (!checked.ok) return json({ ok: false, error: checked.error }, 400);

    const limits = await checkCoachLimits(session.user.id, clientIpFromHeaders(request.headers));
    if (!limits.ok) return json({ ok: false, error: "You have asked a lot of questions. Try again in a bit." }, 429);

    if (looksLikeInjection(checked.value.message)) {
      securityLog("coach_injection_blocked", { userId: session.user.id });
      return json({ ok: true, reply: REFUSAL, source: "guard" }, 200);
    }

    const { lab, context } = await buildCoachContext(session.user.id, checked.value.rivalryId);
    const ai = aiConfigured() && lab.played > 0 ? await generateCoachReply(checked.value, context) : null;
    return json(ai ? { ok: true, reply: ai, source: "ai" } : { ok: true, reply: deterministicCoachReply(lab, checked.value.message), source: "deterministic" }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "coach", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "The coach is unavailable right now." }, 503);
  }
}
