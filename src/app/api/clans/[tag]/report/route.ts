import { apiUser, noStoreJson as json } from "@/lib/api-guard";
import { CLAN_STATUS, readJson } from "@/lib/clan-api";
import { reportClanMessage } from "@/lib/global-chat";
import { clientIpFromHeaders } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

const STATUS = { ...CLAN_STATUS, filtered: 422 } as const;

// POST { messageId, reason } -> reports a message in YOUR clan's private chat for admin review.
export async function POST(request: Request, context: RouteContext<"/api/clans/[tag]/report">) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const { tag } = await context.params;
    const res = await reportClanMessage(who.userId, tag, await readJson(request, 2048), clientIpFromHeaders(request.headers));
    if (!res.ok) return json({ ok: false, error: res.error }, STATUS[res.code]);
    return json({ ok: true }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "clan_report", error: err instanceof Error ? err.name : "unknown" }, "error");
    return json({ ok: false, error: "Could not send that report." }, 503);
  }
}
