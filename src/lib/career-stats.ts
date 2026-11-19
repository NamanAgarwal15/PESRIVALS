// "Me vs Everyone": overall career stats across ALL of a user's active
// rivalries. The pure aggregation lives in rivalry-analytics.ts; this file
// loads the data (strict user_a/user_b mapping) and summarizes per rivalry.

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { matches, rivalries, users } from "@/db/schema";
import {
  type AnalyticsMatch,
  type StatComparison,
  type StatSides,
  type Summary,
  computeStatComparison,
  computeSummary,
} from "@/lib/rivalry-analytics";
import { STAT_KEYS } from "@/lib/match-stats";
import { isUuid } from "@/lib/rivalry-helpers";

/**
 * All matches of one of the user's ACTIVE rivalries, oriented "me vs
 * opponent" for the dashboard. Empty for non-members / missing rivalries.
 */
export async function getRivalryAnalyticsMatches(
  currentUserId: string,
  rivalryId: unknown,
): Promise<AnalyticsMatch[]> {
  if (!isUuid(currentUserId) || !isUuid(rivalryId)) return [];
  const [rivalry] = await db
    .select({ id: rivalries.id, userAId: rivalries.userAId })
    .from(rivalries)
    .where(
      and(
        eq(rivalries.id, rivalryId),
        eq(rivalries.status, "active"),
        or(eq(rivalries.userAId, currentUserId), eq(rivalries.userBId, currentUserId)),
      ),
    );
  if (!rivalry) return [];
  const iAmA = rivalry.userAId === currentUserId;
  const rows = await db
    .select()
    .from(matches)
    .where(and(eq(matches.rivalryId, rivalry.id), eq(matches.status, "confirmed"), isNull(matches.deletedAt)))
    .orderBy(asc(matches.matchNo));
  return rows.map((row) => toAnalyticsMatch(row, currentUserId, iAmA));
}

// Drizzle column suffix per stat key (matches STAT_COLUMN_SUFFIX in
// match-helpers, duplicated here so this module stands alone).
const STAT_COLUMN: Record<(typeof STAT_KEYS)[number], string> = {
  possession: "Possession",
  shots: "Shots",
  shots_on_target: "ShotsOnTarget",
  fouls: "Fouls",
  offsides: "Offsides",
  corners: "Corners",
  free_kicks: "FreeKicks",
  passes: "Passes",
  successful_passes: "SuccessfulPasses",
  crosses: "Crosses",
  interceptions: "Interceptions",
  tackles: "Tackles",
  saves: "Saves",
};

type RawMatch = typeof matches.$inferSelect;

/** Maps one rivalry row to the viewing user's orientation (me vs opponent). */
export function toAnalyticsMatch(row: RawMatch, currentUserId: string, iAmA: boolean): AnalyticsMatch {
  const pick = (stat: (typeof STAT_KEYS)[number]): number | null => {
    const a = row[`userA${STAT_COLUMN[stat]}` as keyof RawMatch] as number | null;
    const b = row[`userB${STAT_COLUMN[stat]}` as keyof RawMatch] as number | null;
    return iAmA ? (a ?? null) : (b ?? null);
  };
  const reject = (stat: (typeof STAT_KEYS)[number]): number | null => {
    const a = row[`userA${STAT_COLUMN[stat]}` as keyof RawMatch] as number | null;
    const b = row[`userB${STAT_COLUMN[stat]}` as keyof RawMatch] as number | null;
    return iAmA ? (b ?? null) : (a ?? null);
  };
  const my: StatSides = {} as StatSides;
  const opp: StatSides = {} as StatSides;
  for (const key of STAT_KEYS) {
    my[key] = pick(key);
    opp[key] = reject(key);
  }
  return {
    matchNo: row.matchNo,
    playedAt: row.playedAt,
    hostSide:
      row.hostUserId === null
        ? null
        : row.hostUserId === currentUserId
          ? "me"
          : "opponent",
    myGoals: iAmA ? row.userAGoals : row.userBGoals,
    opponentGoals: iAmA ? row.userBGoals : row.userAGoals,
    decidedOnPens: row.decidedOnPens,
    needsReview: row.needsReview,
    status: row.status,
    myPlaystyle: iAmA ? row.playstyleA : row.playstyleB,
    oppPlaystyle: iAmA ? row.playstyleB : row.playstyleA,
    matchContext: row.matchContext,
    my,
    opp,
  };
}

export type CareerRivalryRow = {
  rivalryId: string;
  opponentUsername: string;
  opponentDisplayName: string;
  summary: Summary;
  comparison: StatComparison;
};

export type CareerStats = {
  totalRivalries: number;
  overall: Summary;
  overallComparison: StatComparison;
  perRivalry: CareerRivalryRow[];
};

/** Loads every active rivalry of the user plus its confirmed matches. */
export async function getCareerStats(currentUserId: string): Promise<CareerStats | null> {
  if (!isUuid(currentUserId)) return null;

  const rows = await db
    .select({
      id: rivalries.id,
      userAId: rivalries.userAId,
      opponentId: users.id,
      opponentUsername: users.username,
      opponentDisplayName: users.displayName,
    })
    .from(rivalries)
    .innerJoin(
      users,
      sql`${users.id} = CASE WHEN ${rivalries.userAId} = ${currentUserId} THEN ${rivalries.userBId} ELSE ${rivalries.userAId} END`,
    )
    .where(
      and(
        eq(rivalries.status, "active"),
        or(eq(rivalries.userAId, currentUserId), eq(rivalries.userBId, currentUserId)),
      ),
    );

  if (!rows.length) {
    return {
      totalRivalries: 0,
      overall: computeSummary([]),
      overallComparison: computeStatComparison([]),
      perRivalry: [],
    };
  }

  const allMatches = await db
    .select()
    .from(matches)
    .where(
      and(
        inArray(
          matches.rivalryId,
          rows.map((r) => r.id),
        ),
        eq(matches.status, "confirmed"),
        isNull(matches.deletedAt),
      ),
    )
    .orderBy(asc(matches.matchNo));

  const perRivalry: CareerRivalryRow[] = [];
  const combined: AnalyticsMatch[] = [];
  for (const r of rows) {
    const iAmA = r.userAId === currentUserId;
    const oriented = allMatches
      .filter((m) => m.rivalryId === r.id)
      .map((m) => toAnalyticsMatch(m, currentUserId, iAmA));
    combined.push(...oriented);
    perRivalry.push({
      rivalryId: r.id,
      opponentUsername: r.opponentUsername,
      opponentDisplayName: r.opponentDisplayName,
      summary: computeSummary(oriented),
      comparison: computeStatComparison(oriented),
    });
  }

  return {
    totalRivalries: rows.length,
    overall: computeSummary(combined),
    overallComparison: computeStatComparison(combined),
    perRivalry: perRivalry.sort((a, b) => b.summary.played - a.summary.played),
  };
}
