import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { reportGlobalMessage } from "@/lib/global-chat";
import { clientIpFromHeaders } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

const STATUS = { not_found: 404, rate_limited: 429, invalid: 400, filtered: 422, muted: 403 } as const;

// POST { messageId, reason } -> reports a lobby message for admin review.
export async function POST(request: Request) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 2 * 1024) return json({ ok: false, error: "Request too large." }, 413);
    const res = await reportGlobalMessage(who.userId, await request.json().catch(() => null), clientIpFromHeaders(request.headers));
    if (!res.ok) return json({ ok: false, error: res.error }, STATUS[res.code]);
    return json({ ok: true }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "global_report", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not send that report." }, 503);
  }
}
