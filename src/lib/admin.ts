// Admin data layer (RBAC is enforced by the callers in admin-actions.ts and
// the /admin page). Framework-free so it is unit-tested directly.

import { count, eq, gte, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { matches, rivalries, siteSettings, users } from "@/db/schema";

export const ANNOUNCEMENT_KEY = "announcement";

/** True only for an existing, non-suspended admin (checked against the DB, not the JWT). */
export async function isAdminUser(userId: string | undefined | null): Promise<boolean> {
  if (!userId) return false;
  const [row] = await db
    .select({ role: users.role, suspended: users.suspended })
    .from(users)
    .where(eq(users.id, userId));
  return row?.role === "admin" && !row.suspended;
}

export async function getPlatformStats() {
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const [[u], [r], [m], [m7]] = await Promise.all([
    db.select({ n: count() }).from(users),
    db.select({ n: count() }).from(rivalries).where(eq(rivalries.status, "active")),
    db.select({ n: count() }).from(matches),
    db.select({ n: count() }).from(matches).where(gte(matches.createdAt, weekAgo)),
  ]);
  return { users: u.n, activeRivalries: r.n, matches: m.n, matchesLast7Days: m7.n };
}

export async function listUsers(search = "") {
  const q = search.trim().replace(/^@/, "");
  const like = "%" + q.replace(/[%_\\]/g, (c) => "\\" + c) + "%";
  return db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      role: users.role,
      suspended: users.suspended,
      publicLeaderboard: users.publicLeaderboard,
      matchCount: sql<number>`(select count(*)::int from matches m join rivalries r on r.id = m.rivalry_id where r.user_a_id = "users"."id" or r.user_b_id = "users"."id")`,
    })
    .from(users)
    .where(
      q
        ? or(
            ilike(users.username, like),
            ilike(users.displayName, like),
            ilike(users.email, like),
          )
        : undefined,
    )
    .orderBy(users.username)
    .limit(200);
}

export async function listRecentMatches(limit = 25) {
  return db.execute(sql`
    SELECT m.id, m.match_no AS "matchNo", m.created_at AS "createdAt",
           m.user_a_goals AS "aGoals", m.user_b_goals AS "bGoals",
           m.user_a_team AS "aTeam", m.user_b_team AS "bTeam",
           ua.username AS "aUser", ub.username AS "bUser"
    FROM matches m
    JOIN rivalries r ON r.id = m.rivalry_id
    JOIN users ua ON ua.id = r.user_a_id
    JOIN users ub ON ub.id = r.user_b_id
    ORDER BY m.created_at DESC
    LIMIT ${limit}
  `);
}

export async function setSuspended(userId: string, suspended: boolean) {
  await db.update(users).set({ suspended, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function setLeaderboardVisibility(userId: string, visible: boolean) {
  await db
    .update(users)
    .set({ publicLeaderboard: visible, updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function setTempPasswordHash(userId: string, passwordHash: string) {
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, userId));
}

export type RoleResult = { ok: true } | { ok: false; error: string };

/** Grants/revokes admin. Never lets the last remaining admin be demoted. */
export async function setRole(userId: string, role: "user" | "admin"): Promise<RoleResult> {
  if (role === "user") {
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    if (admins.length <= 1 && admins.some((a) => a.id === userId)) {
      return { ok: false, error: "Cannot demote the last remaining admin." };
    }
  }
  await db.update(users).set({ role, updatedAt: new Date() }).where(eq(users.id, userId));
  return { ok: true };
}

export async function deleteMatch(matchId: string) {
  await db.delete(matches).where(eq(matches.id, matchId));
}

export async function getAnnouncement(): Promise<string | null> {
  const [row] = await db
    .select({ value: siteSettings.value })
    .from(siteSettings)
    .where(eq(siteSettings.key, ANNOUNCEMENT_KEY));
  const v = row?.value?.trim();
  return v ? v : null;
}

/** Empty text disables the banner. */
export async function setAnnouncement(text: string) {
  const value = text.trim().slice(0, 280);
  await db
    .insert(siteSettings)
    .values({ key: ANNOUNCEMENT_KEY, value })
    .onConflictDoUpdate({ target: siteSettings.key, set: { value, updatedAt: new Date() } });
}
