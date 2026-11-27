// Global leaderboard: AGGREGATED career stats for every active (non-suspended)
// player. The public_leaderboard flag does NOT hide anyone from this board; it
// only governs peer profile visibility. Never exposes individual rivalry scores,
// head-to-head matchups, or emails.
// Framework-free so it is unit-testable.

import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { matches, rivalries, users } from "@/db/schema";
import { computeSummary, type Summary } from "@/lib/rivalry-analytics";
import { toAnalyticsMatch } from "@/lib/career-stats";

export type LeaderboardRow = {
  rank: number;
  userId: string;
  username: string;
  displayName: string;
  summary: Summary;
  avgPossession: number | null;
  passAccuracy: number | null;
};

/** A confirmed match row tagged with its rivalry's two users (not yet oriented to a viewer). */
export type ActiveMatchRow = typeof matches.$inferSelect & { userAId: string; userBId: string };

// Safety ceilings so one request can never load an unbounded table into memory.
// Far above today's volume; if they are ever hit, move the aggregation into SQL.
export const LEADERBOARD_MAX_MATCHES = 100_000;
export const LEADERBOARD_MAX_USERS = 20_000;

/** Every confirmed match of every active rivalry, tagged with the rivalry's two users. */
export async function loadActiveMatches(): Promise<ActiveMatchRow[]> {
  // matches have no direct user columns: orientation comes from the rivalry.
  const joined = await db
    .select({ match: matches, userAId: rivalries.userAId, userBId: rivalries.userBId })
    .from(matches)
    .innerJoin(rivalries, eq(matches.rivalryId, rivalries.id))
    .where(
      and(
        eq(matches.status, "confirmed"),
        eq(rivalries.status, "active"),
        isNull(matches.deletedAt),
        // Matches against a suspended or deleted opponent never count (ghost-opponent farming).
        sql`NOT EXISTS (SELECT 1 FROM users gu WHERE gu.suspended AND (gu.id = ${rivalries.userAId} OR gu.id = ${rivalries.userBId}))`,
      ),
    )
    .limit(LEADERBOARD_MAX_MATCHES);
  return joined.map((j) => ({ ...j.match, userAId: j.userAId, userBId: j.userBId }));
}

/** Aggregated career numbers for one user across ALL of their rivalries. */
export function summarizeCareer(userId: string, allMatches: ActiveMatchRow[]) {
  const oriented = allMatches
    .filter((m) => m.userAId === userId || m.userBId === userId)
    .map((m) => toAnalyticsMatch(m, userId, m.userAId === userId));
  const summary = computeSummary(oriented);
  const possession = oriented.filter((m) => m.my.possession !== null);
  const passes = oriented.filter(
    (m) => m.my.passes !== null && m.my.passes > 0 && m.my.successful_passes !== null,
  );
  return {
    summary,
    avgPossession: possession.length
      ? possession.reduce((s, m) => s + (m.my.possession ?? 0), 0) / possession.length
      : null,
    passAccuracy: passes.length
      ? (passes.reduce((s, m) => s + (m.my.successful_passes ?? 0), 0) /
          passes.reduce((s, m) => s + (m.my.passes ?? 0), 0)) *
        100
      : null,
  };
}

/**
 * Ranks every eligible player by win % (then wins) using aggregated career
 * totals across ALL of their rivalries combined.
 */
export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  const eligible = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.suspended, false))
    .limit(LEADERBOARD_MAX_USERS);
  const allMatches = await loadActiveMatches();

  const rows: Omit<LeaderboardRow, "rank">[] = eligible.map((u) => ({
    userId: u.id,
    username: u.username,
    displayName: u.displayName,
    ...summarizeCareer(u.id, allMatches),
  }));

  return rows
    .filter((r) => r.summary.played > 0)
    .sort((a, b) => b.summary.winPct - a.summary.winPct || b.summary.wins - a.summary.wins)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
