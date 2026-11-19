import { checkDeviceAnomalies, recordDeviceSession } from "@/lib/anti-sybil";
import { normalizeFingerprintHash } from "@/lib/fingerprint";
import { apiUser, noStoreJson as pushJson } from "@/lib/api-guard";
import { clientIpFromHeaders, consumeRateLimit } from "@/lib/rate-limit";
import { securityLog } from "@/lib/security-log";

// Silent device check-in. Never blocks the user: failures return a quiet 2xx/5xx
// and the client ignores them.
export async function POST(request: Request) {
  const who = await apiUser(request, true);
  if ("error" in who) return who.error;
  try {
    const rl = await consumeRateLimit(`fp:${who.userId}`, 30, 60);
    if (!rl.ok) return pushJson({ ok: true }, 200);
    const body = (await request.json().catch(() => null)) as { fingerprintHash?: unknown } | null;
    const hash = normalizeFingerprintHash(body?.fingerprintHash);
    if (!hash) return pushJson({ ok: false }, 400);
    await recordDeviceSession(who.userId, hash, clientIpFromHeaders(request.headers), request.headers.get("user-agent"));
    await checkDeviceAnomalies(who.userId);
    return pushJson({ ok: true }, 200);
  } catch (err) {
    securityLog("request_failed", { route: "fingerprint", error: err instanceof Error ? err.name : "unknown" }, "error");
    return pushJson({ ok: false }, 503);
  }
}
