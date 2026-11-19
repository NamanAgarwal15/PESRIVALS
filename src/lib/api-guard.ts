// Shared guard and response helper for the JSON API routes. Fails closed with
// short generic messages: no stack traces, SQL or provider details.

import { auth } from "@/auth";
import { refreshSessionUser } from "@/lib/auth-helpers";
import { sameOrigin } from "@/lib/request-origin";
import { securityLog } from "@/lib/security-log";

export const noStoreJson = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/**
 * Same-origin (for mutations), signed in, and an account that still exists and is
 * not suspended (checked in the database, not just the 60 s session window).
 */
export async function apiUser(request: Request, mutating: boolean) {
  if (mutating && !sameOrigin(request)) {
    securityLog("request_failed", { route: "api", reason: "cross_origin" });
    return { error: noStoreJson({ ok: false, error: "Forbidden" }, 403) } as const;
  }
  const session = await auth();
  if (!session?.user?.id) return { error: noStoreJson({ ok: false, error: "Log in first." }, 401) } as const;
  const fresh = await refreshSessionUser(session.user.id);
  if (!fresh) return { error: noStoreJson({ ok: false, error: "Forbidden" }, 403) } as const;
  return { userId: session.user.id, onboarded: Boolean(session.user.onboarded) } as const;
}
