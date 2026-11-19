// Shared guards for the /api/push routes. Fail closed, no stack traces.
import { auth } from "@/auth";
import { securityLog } from "@/lib/security-log";

export const pushJson = (body: unknown, status: number) =>
  Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

/** Same-origin check for state-changing requests (CSRF defence in depth). */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).host === (request.headers.get("host") ?? new URL(request.url).host);
  } catch {
    return false;
  }
}

export async function pushUser(request: Request, mutating: boolean) {
  if (mutating && !sameOrigin(request)) {
    securityLog("request_failed", { route: "push", reason: "cross_origin" });
    return { error: pushJson({ ok: false, error: "Forbidden" }, 403) } as const;
  }
  const session = await auth();
  if (!session?.user?.id) return { error: pushJson({ ok: false, error: "Log in first." }, 401) } as const;
  return { userId: session.user.id } as const;
}
