import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { reportDmMessage } from "@/lib/global-chat";
import { clientIpFromHeaders } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

const STATUS = { not_found: 404, rate_limited: 429, invalid: 400, filtered: 422 } as const;

// POST { messageId, reason } -> reports a message the other player sent you in your 1v1 thread.
export async function POST(request: Request, context: RouteContext<"/api/chat/[username]/report">) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 2 * 1024) return json({ ok: false, error: "Request too large." }, 413);
    const { username } = await context.params;
    const res = await reportDmMessage(who.userId, decodeURIComponent(username), await request.json().catch(() => null), clientIpFromHeaders(request.headers));
    if (!res.ok) return json({ ok: false, error: res.error }, STATUS[res.code]);
    return json({ ok: true }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "dm_report", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not send that report." }, 503);
  }
}
