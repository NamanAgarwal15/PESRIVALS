import { z } from "zod";
import { LIMITS, consumeRateLimit } from "@/lib/rate-limit";
import { checkPushEndpoint, hasSubscription, isPushConfigured, saveSubscription } from "@/lib/push";
import { apiUser, noStoreJson as pushJson } from "@/lib/api-guard";
import { securityLog } from "@/lib/security-log";

const bodySchema = z.object({
  endpoint: z.string().max(2048),
  keys: z.object({ p256dh: z.string().min(10).max(256), auth: z.string().min(8).max(128) }),
});

// GET: is push available, the public VAPID key, and is this user subscribed?
export async function GET(request: Request) {
  const who = await apiUser(request, false);
  if ("error" in who) return who.error;
  try {
    return pushJson(
      {
        ok: true,
        configured: isPushConfigured(),
        publicKey: process.env.VAPID_PUBLIC_KEY?.trim() ?? null,
        subscribed: await hasSubscription(who.userId),
      },
      200,
    );
  } catch {
    return pushJson({ ok: false, error: "Unavailable" }, 503);
  }
}

export async function POST(request: Request) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const rl = await consumeRateLimit(`push-sub:${who.userId}`, LIMITS.pushSubscribe.max, LIMITS.pushSubscribe.windowMinutes);
    if (!rl.ok) {
      securityLog("rate_limited", { route: "push_subscribe", userId: who.userId });
      return pushJson({ ok: false, error: "Too many attempts. Try again later." }, 429);
    }
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return pushJson({ ok: false, error: "Invalid subscription." }, 400);

    const check = await checkPushEndpoint(parsed.data.endpoint);
    if (!check.ok) {
      securityLog("invalid_push_endpoint", { userId: who.userId, endpoint: parsed.data.endpoint, reason: check.reason });
      return pushJson({ ok: false, error: "Invalid subscription." }, 400);
    }
    // Always stored under the session user, never a client-supplied id.
    await saveSubscription(who.userId, parsed.data.endpoint, parsed.data.keys, request.headers.get("user-agent"));
    return pushJson({ ok: true }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "push_subscribe", error: err instanceof Error ? err.name : "unknown" }, "error");
    return pushJson({ ok: false, error: "Could not enable notifications." }, 503);
  }
}
