// Match logic that talks to the database. Framework-free on purpose (no
// next/* imports) so it can be exercised directly by Vitest. Every function
// takes the acting user's id explicitly and checks rivalry membership itself.

import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { matches, rivalries } from "@/db/schema";
import { type ExtractResult, extractMatchFromScreenshot } from "@/lib/gemini-extract";
import { type ExtractedSide, saveMatchInputSchema } from "@/lib/match-schema";
import { type MatchOutcome, type StatKey, STAT_KEYS, matchOutcome } from "@/lib/match-stats";
import { isUuid } from "@/lib/rivalry-helpers";

type MatchInsert = typeof matches.$inferInsert;

// Column name suffix for each stat: user_a_<stat> is userA<Suffix> in Drizzle.
const STAT_COLUMN_SUFFIX: Record<StatKey, string> = {
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

/** All columns of one canonical slot (user_a_* or user_b_*) from one screenshot side. */
function slotColumns(slot: "A" | "B", side: ExtractedSide): Partial<MatchInsert> {
  const out: Record<string, string | number | null> = {
    [`user${slot}Team`]: side.team,
    [`user${slot}Goals`]: side.goals,
  };
  for (const key of STAT_KEYS) {
    out[`user${slot}${STAT_COLUMN_SUFFIX[key]}`] = side[key];
  }
  return out as Partial<MatchInsert>;
}

async function findActiveRivalry(currentUserId: string, rivalryId: unknown) {
  if (!isUuid(currentUserId) || !isUuid(rivalryId)) return null;
  const [row] = await db
    .select({
      id: rivalries.id,
      userAId: rivalries.userAId,
      userBId: rivalries.userBId,
    })
    .from(rivalries)
    .where(
      and(
        eq(rivalries.id, rivalryId),
        eq(rivalries.status, "active"),
        or(eq(rivalries.userAId, currentUserId), eq(rivalries.userBId, currentUserId)),
      ),
    );
  return row ?? null;
}

function pgErrorCode(err: unknown): string | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { code?: unknown; cause?: unknown };
    if (typeof e.code === "string" && /^[0-9A-Z]{5}$/.test(e.code)) return e.code;
    current = e.cause;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Extract
// ---------------------------------------------------------------------------

export type ExtractForMemberResult =
  | ExtractResult
  | { ok: false; code: "not_found"; error: string };

/** Runs the Gemini extraction, but only for a member of the active rivalry. */
export async function extractForMember(
  currentUserId: string,
  rivalryId: unknown,
  image: { bytes: Uint8Array },
): Promise<ExtractForMemberResult> {
  const rivalry = await findActiveRivalry(currentUserId, rivalryId);
  if (!rivalry) return { ok: false, code: "not_found", error: "Rivalry not found" };
  return extractMatchFromScreenshot(image);
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

export type SaveMatchResult =
  | { ok: true; matchId: string; matchNo: number }
  | { ok: false; error: string };

const MATCH_NO_ATTEMPTS = 3;

/**
 * Saves an extracted match into a rivalry.
 *
 * The screenshot only knows LEFT and RIGHT. The database only knows user_a
 * and user_b (lower uuid = user_a). `mySide` says which screenshot side the
 * current user played, so:
 *   current user's slot  <- the side they picked
 *   opponent's slot      <- the other side
 */
export async function saveMatchForUser(
  currentUserId: string,
  input: unknown,
): Promise<SaveMatchResult> {
  const parsed = saveMatchInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = String(issue?.path[0] ?? "");
    if (field === "mySide") return { ok: false, error: "Choose which side you played" };
    if (field === "host") return { ok: false, error: "Choose who hosted the match" };
    if (field === "remark") return { ok: false, error: "Remark can be at most 200 characters" };
    if (field === "rivalryId") return { ok: false, error: "Rivalry not found" };
    return {
      ok: false,
      error: "The match details are not valid. Upload the screenshot again.",
    };
  }
  const { rivalryId, extracted, mySide, host, decidedOnPens, remark } = parsed.data;

  const rivalry = await findActiveRivalry(currentUserId, rivalryId);
  if (!rivalry) return { ok: false, error: "Rivalry not found" };

  const iAmUserA = rivalry.userAId === currentUserId;
  const opponentId = iAmUserA ? rivalry.userBId : rivalry.userAId;

  const mine = extracted[mySide];
  const theirs = extracted[mySide === "left" ? "right" : "left"];

  const values = {
    rivalryId: rivalry.id,
    // Computed inside the INSERT; the unique constraint settles any race.
    matchNo: sql<number>`(SELECT COALESCE(MAX(m.match_no), 0) + 1 FROM matches m WHERE m.rivalry_id = ${rivalry.id})`,
    playedAt: new Date().toISOString().slice(0, 10), // today, UTC
    hostUserId: host === "home" ? currentUserId : opponentId,
    createdBy: currentUserId,
    source: "screenshot",
    status: "confirmed",
    needsReview: false,
    decidedOnPens,
    remark,
    ...slotColumns(iAmUserA ? "A" : "B", mine),
    ...slotColumns(iAmUserA ? "B" : "A", theirs),
  } as MatchInsert;

  for (let attempt = 1; attempt <= MATCH_NO_ATTEMPTS; attempt++) {
    try {
      const [row] = await db
        .insert(matches)
        .values(values)
        .returning({ id: matches.id, matchNo: matches.matchNo });
      return { ok: true, matchId: row.id, matchNo: row.matchNo };
    } catch (err) {
      const code = pgErrorCode(err);
      // 23505: both players saved at once and took the same match_no. Retry.
      if (code === "23505" && attempt < MATCH_NO_ATTEMPTS) continue;
      if (code === "23505") {
        return { ok: false, error: "Could not save the match. Please try again." };
      }
      // 23514: a CHECK constraint. Zod should have caught it already.
      if (code === "23514") {
        return {
          ok: false,
          error: "The match details are not valid. Upload the screenshot again.",
        };
      }
      throw err;
    }
  }
  return { ok: false, error: "Could not save the match. Please try again." };
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

/** One match, oriented to the user who is looking at it. */
export type RivalryMatch = {
  id: string;
  matchNo: number;
  playedAt: string | null;
  myTeam: string;
  opponentTeam: string;
  myGoals: number;
  opponentGoals: number;
  decidedOnPens: boolean;
  outcome: MatchOutcome;
  /** "home" when the current user hosted, "away" when the opponent did. */
  venue: "home" | "away" | null;
  needsReview: boolean;
  remark: string | null;
};

/** Matches of an active rivalry, newest first. Empty for non-members. */
export async function getRivalryMatches(
  currentUserId: string,
  rivalryId: unknown,
  limit = 50,
): Promise<RivalryMatch[]> {
  const rivalry = await findActiveRivalry(currentUserId, rivalryId);
  if (!rivalry) return [];
  const iAmUserA = rivalry.userAId === currentUserId;

  const rows = await db
    .select({
      id: matches.id,
      matchNo: matches.matchNo,
      playedAt: matches.playedAt,
      hostUserId: matches.hostUserId,
      userATeam: matches.userATeam,
      userBTeam: matches.userBTeam,
      userAGoals: matches.userAGoals,
      userBGoals: matches.userBGoals,
      decidedOnPens: matches.decidedOnPens,
      needsReview: matches.needsReview,
      remark: matches.remark,
    })
    .from(matches)
    .where(eq(matches.rivalryId, rivalry.id))
    .orderBy(desc(matches.matchNo))
    .limit(limit);

  return rows.map((row) => {
    const myGoals = iAmUserA ? row.userAGoals : row.userBGoals;
    const opponentGoals = iAmUserA ? row.userBGoals : row.userAGoals;
    return {
      id: row.id,
      matchNo: row.matchNo,
      playedAt: row.playedAt,
      myTeam: iAmUserA ? row.userATeam : row.userBTeam,
      opponentTeam: iAmUserA ? row.userBTeam : row.userATeam,
      myGoals,
      opponentGoals,
      decidedOnPens: row.decidedOnPens,
      needsReview: row.needsReview,
      outcome: matchOutcome(myGoals, opponentGoals, row.decidedOnPens),
      venue: row.hostUserId === null ? null : row.hostUserId === currentUserId ? "home" : "away",
      remark: row.remark,
    };
  });
}
