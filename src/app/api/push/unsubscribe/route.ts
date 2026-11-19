import { removeSubscription } from "@/lib/push";
import { apiUser, noStoreJson as pushJson } from "@/lib/api-guard";
import { securityLog } from "@/lib/security-log";

export async function POST(request: Request) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const body = (await request.json().catch(() => null)) as { endpoint?: unknown } | null;
    if (typeof body?.endpoint !== "string" || body.endpoint.length > 2048) {
      return pushJson({ ok: false, error: "Invalid request." }, 400);
    }
    // Scoped to the session user: you can only remove your own subscription.
    await removeSubscription(who.userId, body.endpoint);
    return pushJson({ ok: true }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "push_unsubscribe", error: err instanceof Error ? err.name : "unknown" }, "error");
    return pushJson({ ok: false, error: "Could not disable notifications." }, 503);
  }
}
