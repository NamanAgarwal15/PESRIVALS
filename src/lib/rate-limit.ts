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
  matchExtract: { max: 10, windowMinutes: 60 },
  matchExtractDay: { max: 30, windowMinutes: 1440 },
  coachDay: { max: 5, windowMinutes: 1440 },
  coachUser: { max: 15, windowMinutes: 60 },
  coachIp: { max: 40, windowMinutes: 60 },
  pushSubscribe: { max: 20, windowMinutes: 60 },
  dispute: { max: 10, windowMinutes: 60 },
  matchExtractIp: { max: 60, windowMinutes: 60 },
  dmUser: { max: 20, windowMinutes: 5 },
  dmIp: { max: 60, windowMinutes: 5 },
  dmRead: { max: 240, windowMinutes: 10 },
  globalUser: { max: 12, windowMinutes: 2 },
  globalIp: { max: 40, windowMinutes: 2 },
  globalRead: { max: 300, windowMinutes: 10 },
  reportUser: { max: 10, windowMinutes: 60 },
  reportIp: { max: 30, windowMinutes: 60 },
  clanCreate: { max: 3, windowMinutes: 1440 },
  clanInvite: { max: 20, windowMinutes: 60 },
  clanManage: { max: 60, windowMinutes: 60 },
  clanChatUser: { max: 15, windowMinutes: 2 },
  clanChatIp: { max: 60, windowMinutes: 2 },
  clanChatRead: { max: 300, windowMinutes: 10 },
  warChallenge: { max: 6, windowMinutes: 60 },
  matchSave: { max: 15, windowMinutes: 60 },
  matchSaveRivalryDay: { max: 25, windowMinutes: 1440 },
  matchPush: { max: 1, windowMinutes: 10 },
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

// ---------------------------------------------------------------------------
// UTC-day quotas (the key carries the UTC date, so a new day is a fresh bucket)
// ---------------------------------------------------------------------------

export const utcDay = (d: Date = new Date()): string => d.toISOString().slice(0, 10);

/** Start of the next UTC day: when daily quotas reset. */
export function nextUtcMidnight(d: Date = new Date()): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

export const dailyKey = (name: string, userId: string, day: string = utcDay()) => `${name}-day:${userId}:${day}`;

/**
 * Atomically takes one unit of a quota only if one is left; a refused attempt is NOT counted,
 * so refundRateLimit gives back exactly what was reserved.
 */
export async function reserveQuota(key: string, max: number, windowMinutes: number): Promise<RateLimitResult> {
  const bump = await db.execute(sql`
    UPDATE rate_limits SET count = count + 1
    WHERE key = ${key} AND count < ${max}
      AND window_started_at >= now() - (${windowMinutes} * interval '1 minute')
    RETURNING count
  `);
  let rows = (bump as unknown as { rows?: { count: number }[] }).rows ?? [];
  if (!rows.length) {
    // No row yet, or its window expired: start a fresh window at 1. Does nothing if the quota is spent.
    const fresh = await db.execute(sql`
      INSERT INTO rate_limits (key, count, window_started_at) VALUES (${key}, 1, now())
      ON CONFLICT (key) DO UPDATE SET count = 1, window_started_at = now()
      WHERE rate_limits.window_started_at < now() - (${windowMinutes} * interval '1 minute')
      RETURNING count
    `);
    rows = (fresh as unknown as { rows?: { count: number }[] }).rows ?? [];
  }
  if (!rows.length) return { ok: false, remaining: 0 };
  return { ok: true, remaining: Math.max(0, max - Number(rows[0].count)) };
}

/** Reads a bucket without counting a hit. */
export async function peekRateLimit(key: string, max: number, windowMinutes: number): Promise<{ used: number; remaining: number }> {
  const result = await db.execute(sql`
    SELECT count FROM rate_limits
    WHERE key = ${key} AND window_started_at >= now() - (${windowMinutes} * interval '1 minute')
  `);
  const rows = (result as unknown as { rows?: { count: number }[] }).rows ?? [];
  const used = Number(rows[0]?.count ?? 0);
  return { used, remaining: Math.max(0, max - used) };
}

/** Gives one hit back (used when an AI call fails after its quota was reserved). */
export async function refundRateLimit(key: string): Promise<void> {
  await db.execute(sql`UPDATE rate_limits SET count = GREATEST(count - 1, 0) WHERE key = ${key}`);
}

/** Per-user hourly and per-rivalry daily ceilings on saving matches (stops stat/war farming and push spam). */
export async function consumeMatchSaveLimits(
  userId: string,
  rivalryId: unknown,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const user = await consumeRateLimit(`match-save:${userId}`, LIMITS.matchSave.max, LIMITS.matchSave.windowMinutes);
  if (!user.ok) return { ok: false, error: "You are saving matches very quickly. Try again in a bit." };
  if (typeof rivalryId === "string" && /^[0-9a-f-]{36}$/i.test(rivalryId)) {
    const day = await consumeRateLimit(
      `match-save-rv-day:${rivalryId}:${utcDay()}`,
      LIMITS.matchSaveRivalryDay.max,
      LIMITS.matchSaveRivalryDay.windowMinutes,
    );
    if (!day.ok) return { ok: false, error: "This rivalry has reached today's match limit. It resets at midnight UTC." };
  }
  return { ok: true };
}

/** True at most once per rivalry per 10 minutes: rapid saves share one push notification. */
export async function shouldPushMatch(rivalryId: string): Promise<boolean> {
  return (await consumeRateLimit(`match-push:${rivalryId}`, LIMITS.matchPush.max, LIMITS.matchPush.windowMinutes)).ok;
}

/** Deletes a user's buckets for the given names: hourly `name:userId` and daily `name-day:userId:*`. */
export async function clearUserRateLimits(userId: string, names: string[]): Promise<void> {
  for (const name of names) {
    await db.execute(sql`DELETE FROM rate_limits WHERE key = ${`${name}:${userId}`} OR key LIKE ${`${name}-day:${userId}:%`}`);
  }
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
