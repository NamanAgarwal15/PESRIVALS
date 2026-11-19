// DB-backed fixed-window rate limiter. Framework-free (no next/* imports) so
// it can be exercised directly by Vitest. Every function takes an explicit
// key like "signup:ip:1.2.3.4" and enforces a max count per window.

import { sql } from "drizzle-orm";
import { db } from "@/db";

export type RateLimitResult = { ok: boolean; remaining: number };

export const LIMITS = {
  signup: { max: 5, windowMinutes: 15 },
  forgotPassword: { max: 3, windowMinutes: 15 },
  rivalryInvite: { max: 20, windowMinutes: 60 },
  matchExtract: { max: 20, windowMinutes: 60 },
  coachUser: { max: 15, windowMinutes: 60 },
  coachIp: { max: 40, windowMinutes: 60 },
  pushSubscribe: { max: 20, windowMinutes: 60 },
  dispute: { max: 10, windowMinutes: 60 },
  matchExtractIp: { max: 60, windowMinutes: 60 },
} as const;

/**
 * Counts one hit against `key` inside the fixed window. Returns ok=false once
 * the limit is reached (further hits are not counted).
 */
export async function consumeRateLimit(
  key: string,
  max: number,
  windowMinutes: number,
): Promise<RateLimitResult> {
  const result = await db.execute(sql`
    INSERT INTO rate_limits (key, count, window_started_at)
    VALUES (${key}, 1, now())
    ON CONFLICT (key) DO UPDATE SET
      count = CASE
        WHEN rate_limits.window_started_at < now() - (${windowMinutes} * interval '1 minute')
        THEN 1
        ELSE rate_limits.count + 1
      END,
      window_started_at = CASE
        WHEN rate_limits.window_started_at < now() - (${windowMinutes} * interval '1 minute')
        THEN now()
        ELSE rate_limits.window_started_at
      END
    RETURNING count
  `);
  const rows = (result as unknown as { rows?: { count: number }[] }).rows ?? [];
  const count = Number(rows[0]?.count ?? 1);
  return { ok: count <= max, remaining: Math.max(0, max - count) };
}

/** Removes a rate-limit row (used by tests to clean up after themselves). */
export async function clearRateLimit(key: string): Promise<void> {
  await db.execute(sql`DELETE FROM rate_limits WHERE key = ${key}`);
}

/**
 * Client IP from request headers, most trustworthy first: the platform-set
 * x-vercel-forwarded-for, then x-real-ip, then the left-most x-forwarded-for
 * entry (client-appendable, so last resort). Null when none is present.
 */
export function clientIpFromHeaders(headers: Pick<Headers, "get">): string | null {
  const clean = (v: string | null) => {
    const first = v?.split(",")[0]?.trim();
    return first ? first.slice(0, 64) : null;
  };
  return (
    clean(headers.get("x-vercel-forwarded-for")) ??
    clean(headers.get("x-real-ip")) ??
    clean(headers.get("x-forwarded-for"))
  );
}
