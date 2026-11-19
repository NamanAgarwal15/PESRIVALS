// Anti-sybil anomaly detector. It only RAISES FLAGS for admin review: it never
// blocks, bans or hides anything automatically. Framework-free.

import { sha256Hex } from "@/lib/hash";
import { and, eq, gte, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { deviceSessions, matches, rivalries, sybilFlags } from "@/db/schema";
import { securityLog } from "@/lib/security-log";

export const SELF_RIVALRY_WINDOW_H = 24;
export const ACCOUNT_FARM_WINDOW_D = 7;
export const ACCOUNT_FARM_MIN_USERS = 3;
export const FARM_MATCHES = 5;
export const FARM_WINDOW_MIN = 60;
export const FARM_MIN_AVG_MARGIN = 4;

export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  const salt = process.env.AUTH_SECRET ?? "dev-salt";
  return sha256Hex(`${salt}:${ip}`);
}

/** Upserts the (user, device) row. Returns nothing; never throws to callers that wrap it. */
export async function recordDeviceSession(
  userId: string,
  fingerprintHash: string,
  ip: string | null,
  userAgent: string | null,
): Promise<void> {
  await db
    .insert(deviceSessions)
    .values({ userId, fingerprintHash, ipHash: hashIp(ip), userAgent: userAgent?.slice(0, 255) ?? null })
    .onConflictDoUpdate({
      target: [deviceSessions.userId, deviceSessions.fingerprintHash],
      set: {
        seenCount: sql`${deviceSessions.seenCount} + 1`,
        lastSeenAt: new Date(),
        ipHash: hashIp(ip),
        userAgent: userAgent?.slice(0, 255) ?? null,
      },
    });
}

type NewFlag = {
  flagType: "self_rivalry_collision" | "account_farm" | "score_farming";
  severity: "high" | "medium";
  primaryUserId: string;
  relatedUserId?: string | null;
  rivalryId?: string | null;
  fingerprintHash?: string | null;
  reason: string;
};

/** Inserts the flag unless an identical OPEN one already exists. Returns true when created. */
export async function raiseFlag(flag: NewFlag): Promise<boolean> {
  const existing = await db
    .select({ id: sybilFlags.id })
    .from(sybilFlags)
    .where(
      and(
        eq(sybilFlags.status, "open"),
        eq(sybilFlags.flagType, flag.flagType),
        eq(sybilFlags.primaryUserId, flag.primaryUserId),
        sql`${sybilFlags.relatedUserId} IS NOT DISTINCT FROM ${flag.relatedUserId ?? null}`,
        sql`${sybilFlags.rivalryId} IS NOT DISTINCT FROM ${flag.rivalryId ?? null}`,
        sql`${sybilFlags.fingerprintHash} IS NOT DISTINCT FROM ${flag.fingerprintHash ?? null}`,
      ),
    )
    .limit(1);
  if (existing.length) return false;
  await db.insert(sybilFlags).values({
    flagType: flag.flagType,
    severity: flag.severity,
    primaryUserId: flag.primaryUserId,
    relatedUserId: flag.relatedUserId ?? null,
    rivalryId: flag.rivalryId ?? null,
    fingerprintHash: flag.fingerprintHash ?? null,
    reason: flag.reason,
  });
  securityLog("sybil_flag", { flagType: flag.flagType, severity: flag.severity, userId: flag.primaryUserId });
  return true;
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000);

/** Runs the device-based detectors for one user. Returns how many NEW flags were raised. */
export async function checkDeviceAnomalies(userId: string): Promise<number> {
  let created = 0;
  const mine = await db.select().from(deviceSessions).where(eq(deviceSessions.userId, userId));
  for (const mineRow of mine) {
    const hash = mineRow.fingerprintHash;

    // Account farm: >= 3 distinct accounts on one device in 7 days.
    const farm = await db
      .select({ userId: deviceSessions.userId })
      .from(deviceSessions)
      .where(and(eq(deviceSessions.fingerprintHash, hash), gte(deviceSessions.lastSeenAt, hoursAgo(ACCOUNT_FARM_WINDOW_D * 24))));
    const distinct = new Set(farm.map((r) => r.userId));
    if (distinct.size >= ACCOUNT_FARM_MIN_USERS) {
      if (
        await raiseFlag({
          flagType: "account_farm",
          severity: "medium",
          primaryUserId: userId,
          fingerprintHash: hash,
          reason: `${distinct.size} accounts used the same device within ${ACCOUNT_FARM_WINDOW_D} days.`,
        })
      ) created++;
    }

    // Self-rivalry: two accounts in an active rivalry share a device within 24 h.
    if (mineRow.lastSeenAt >= hoursAgo(SELF_RIVALRY_WINDOW_H)) {
      const others = await db
        .select({ userId: deviceSessions.userId })
        .from(deviceSessions)
        .where(
          and(
            eq(deviceSessions.fingerprintHash, hash),
            ne(deviceSessions.userId, userId),
            gte(deviceSessions.lastSeenAt, hoursAgo(SELF_RIVALRY_WINDOW_H)),
          ),
        );
      const otherIds = [...new Set(others.map((o) => o.userId))];
      if (otherIds.length) {
        const rivs = await db
          .select()
          .from(rivalries)
          .where(
            and(
              eq(rivalries.status, "active"),
              or(
                and(eq(rivalries.userAId, userId), inArray(rivalries.userBId, otherIds)),
                and(eq(rivalries.userBId, userId), inArray(rivalries.userAId, otherIds)),
              ),
            ),
          );
        for (const r of rivs) {
          const related = r.userAId === userId ? r.userBId : r.userAId;
          if (
            await raiseFlag({
              flagType: "self_rivalry_collision",
              severity: "high",
              primaryUserId: userId,
              relatedUserId: related,
              rivalryId: r.id,
              fingerprintHash: hash,
              reason: "Both players in this rivalry used the same device within 24 hours.",
            })
          ) created++;
        }
      }
    }
  }
  return created;
}

/** Score-farming cadence for one rivalry: shared device + >= 5 matches in an hour, avg margin >= 4. */
export async function checkScoreFarming(rivalryId: string): Promise<number> {
  const [r] = await db.select().from(rivalries).where(eq(rivalries.id, rivalryId));
  if (!r) return 0;
  const recent = await db
    .select({ a: matches.userAGoals, b: matches.userBGoals })
    .from(matches)
    .where(
      and(
        eq(matches.rivalryId, rivalryId),
        isNull(matches.deletedAt),
        gte(matches.createdAt, new Date(Date.now() - FARM_WINDOW_MIN * 60_000)),
      ),
    );
  if (recent.length < FARM_MATCHES) return 0;
  const avgMargin = recent.reduce((s, m) => s + Math.abs(m.a - m.b), 0) / recent.length;
  if (avgMargin < FARM_MIN_AVG_MARGIN) return 0;

  const hashesOf = async (id: string) =>
    new Set(
      (await db.select({ h: deviceSessions.fingerprintHash }).from(deviceSessions).where(eq(deviceSessions.userId, id))).map(
        (x) => x.h,
      ),
    );
  const [ha, hb] = await Promise.all([hashesOf(r.userAId), hashesOf(r.userBId)]);
  const sharedHash = [...ha].find((h) => hb.has(h));
  if (!sharedHash) return 0;
  const shared = { hash: sharedHash };
  const raised = await raiseFlag({
    flagType: "score_farming",
    severity: "high",
    primaryUserId: r.userAId,
    relatedUserId: r.userBId,
    rivalryId,
    fingerprintHash: shared.hash,
    reason: `${recent.length} matches in ${FARM_WINDOW_MIN} minutes on a shared device, average margin ${avgMargin.toFixed(1)}.`,
  });
  return raised ? 1 : 0;
}
