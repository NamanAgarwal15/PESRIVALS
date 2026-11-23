import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { answerCoachTurn, checkCoachLimits, validateChatBody } from "@/lib/coach-chat";
import { clientIpFromHeaders } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

export const maxDuration = 30;

// POST { message, history?: [{role:"user"|"assistant", content}], rivalryId? }
// The client never supplies a user id, a system prompt, or any telemetry.
export async function POST(request: Request) {
  // Same-origin, signed in, and a non-suspended account (checked in the database).
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 16 * 1024) return json({ ok: false, error: "Request too large." }, 413);
    const checked = validateChatBody(await request.json().catch(() => null));
    if (!checked.ok) return json({ ok: false, error: checked.error }, 400);

    const limits = await checkCoachLimits(who.userId, clientIpFromHeaders(request.headers));
    if (!limits.ok) return json({ ok: false, error: "You have asked a lot of questions. Try again in a bit." }, 429);

    const answer = await answerCoachTurn(who.userId, checked.value);
    const q = answer.quota;
    return json({ ok: true, reply: answer.reply, source: answer.source, remainingToday: q.remaining, limit: q.limit, resetsAt: q.resetsAt, aiEnabled: q.aiEnabled }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "coach", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "The coach is unavailable right now." }, 503);
  }
}
