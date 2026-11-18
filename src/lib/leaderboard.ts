// Global leaderboard: AGGREGATED career stats for every active (non-suspended)
// player. The public_leaderboard flag does NOT hide anyone from this board; it
// only governs peer profile visibility. Never exposes individual rivalry scores,
// head-to-head matchups, emails or phone numbers.
// Framework-free so it is unit-testable.

import { and, eq } from "drizzle-orm";
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

/**
 * Ranks every eligible player by win % (then wins) using aggregated career
 * totals across ALL of their rivalries combined.
 */
export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  const eligible = await db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(eq(users.suspended, false));

  // matches have no direct user columns: orientation comes from the rivalry.
  const joined = await db
    .select({ match: matches, userAId: rivalries.userAId, userBId: rivalries.userBId })
    .from(matches)
    .innerJoin(rivalries, eq(matches.rivalryId, rivalries.id))
    .where(and(eq(matches.status, "confirmed"), eq(rivalries.status, "active")));
  const allMatches = joined.map((j) => ({ ...j.match, userAId: j.userAId, userBId: j.userBId }));

  const rows: Omit<LeaderboardRow, "rank">[] = eligible.map((u) => {
    const oriented = allMatches
      .filter((m) => m.userAId === u.id || m.userBId === u.id)
      .map((m) => toAnalyticsMatch(m, u.id, m.userAId === u.id));
    const summary = computeSummary(oriented);
    const possession = oriented.filter((m) => m.my.possession !== null);
    const passes = oriented.filter(
      (m) => m.my.passes !== null && m.my.passes > 0 && m.my.successful_passes !== null,
    );
    return {
      userId: u.id,
      username: u.username,
      displayName: u.displayName,
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
  });

  return rows
    .filter((r) => r.summary.played > 0)
    .sort(
      (a, b) =>
        b.summary.winPct - a.summary.winPct || b.summary.wins - a.summary.wins,
    )
    .map((r, i) => ({ ...r, rank: i + 1 }));
}
