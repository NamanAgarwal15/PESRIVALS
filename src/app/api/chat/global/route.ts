import { after } from "next/server";
import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { getGlobalMessages, maybePruneGlobalChat, sendGlobalMessage } from "@/lib/global-chat";
import { LIMITS, clientIpFromHeaders, consumeRateLimit } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

const STATUS = { not_found: 404, rate_limited: 429, invalid: 400, filtered: 422, muted: 403 } as const;

// GET -> the newest 50 lobby messages visible to you (your own message blocks applied).
export async function GET(request: Request) {
  const who = await apiUser(request, false);
  if ("error" in who) return who.error;
  const rl = await consumeRateLimit(`gc-read:${who.userId}`, LIMITS.globalRead.max, LIMITS.globalRead.windowMinutes);
  if (!rl.ok) return json({ ok: false, error: "Too many refreshes. Wait a moment." }, 429);
  try {
    return json({ ok: true, messages: await getGlobalMessages(who.userId) }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "global_get", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "The lobby is unavailable right now." }, 503);
  }
}

// POST { body } -> posts to the lobby after the deterministic filter. Refused messages are not stored.
export async function POST(request: Request) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  if (!who.onboarded) return json({ ok: false, error: "Finish setting up your account first." }, 403);
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 4 * 1024) return json({ ok: false, error: "Request too large." }, 413);
    const payload = (await request.json().catch(() => null)) as { body?: unknown } | null;
    const res = await sendGlobalMessage(who.userId, payload?.body, clientIpFromHeaders(request.headers));
    if (!res.ok) {
      if (res.code === "rate_limited") securityLog("rate_limited", { route: "global_chat", userId: who.userId });
      return json({ ok: false, error: res.error }, STATUS[res.code]);
    }
    after(() => maybePruneGlobalChat());
    return json({ ok: true, message: res.message }, 201);
  } catch (err) {
    securityLog("request_failed", { route: "global_post", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not send that message." }, 503);
  }
}
