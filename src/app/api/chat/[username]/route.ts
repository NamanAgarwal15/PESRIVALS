import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { getThread, sendMessage } from "@/lib/dm-chat";
import { LIMITS, clientIpFromHeaders, consumeRateLimit } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

const STATUS = { not_found: 404, blocked: 403, rate_limited: 429, invalid: 400 } as const;

// GET ?after=<iso>  -> newest messages of YOUR thread with :username (polling).
export async function GET(request: Request, context: RouteContext<"/api/chat/[username]">) {
  const who = await apiUser(request, false);
  if ("error" in who) return who.error;
  const rl = await consumeRateLimit(`dm-read:${who.userId}`, LIMITS.dmRead.max, LIMITS.dmRead.windowMinutes);
  if (!rl.ok) return json({ ok: false, error: "Too many refreshes. Wait a moment." }, 429);
  try {
    const { username } = await context.params;
    const after = new URL(request.url).searchParams.get("after")?.slice(0, 40);
    const res = await getThread(who.userId, decodeURIComponent(username), after);
    if (!res.ok) return json({ ok: false, error: res.error }, STATUS[res.code]);
    return json({ ok: true, thread: res.thread }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "chat_get", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Chat is unavailable right now." }, 503);
  }
}

// POST { body } -> sends a message to :username.
export async function POST(request: Request, context: RouteContext<"/api/chat/[username]">) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  if (!who.onboarded) return json({ ok: false, error: "Finish setting up your account first." }, 403);
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 8 * 1024) return json({ ok: false, error: "Request too large." }, 413);
    const payload = (await request.json().catch(() => null)) as { body?: unknown } | null;
    const { username } = await context.params;
    const res = await sendMessage(who.userId, decodeURIComponent(username), payload?.body, clientIpFromHeaders(request.headers));
    if (!res.ok) {
      if (res.code === "rate_limited") securityLog("rate_limited", { route: "chat", userId: who.userId });
      return json({ ok: false, error: res.error }, STATUS[res.code]);
    }
    return json({ ok: true, message: res.message }, 201);
  } catch (err) {
    securityLog("request_failed", { route: "chat_post", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not send that message." }, 503);
  }
}
