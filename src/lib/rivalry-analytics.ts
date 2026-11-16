// Pure, deterministic analytics for one rivalry, oriented "me vs opponent".
// No database, no React: every function here is unit-tested in
// tests/analytics.test.ts against the 31-match imported sheet dataset.
//
// Core rules baked in everywhere:
// - A match decided on penalties is ALWAYS a draw (matchOutcome).
// - Per-stat averages divide by the number of NON-NULL values, never by the
//   match count, so unlogged stats never get zero-inflated.

import { type MatchOutcome, type StatKey, STAT_KEYS, STAT_LABELS, matchOutcome } from "@/lib/match-stats";

export type StatSides = Record<StatKey, number | null>;

/** One match of a rivalry, already oriented to the viewing user. */
export type AnalyticsMatch = {
  matchNo: number;
  playedAt: string | null;
  hostSide: "me" | "opponent" | null;
  myGoals: number;
  opponentGoals: number;
  decidedOnPens: boolean;
  needsReview: boolean;
  my: StatSides;
  opp: StatSides;
};

export type AnalyticsWindow = "all" | "last5" | "last10" | "last20";
export type AnalyticsHostFilter = "all" | "me" | "opponent";
export type AnalyticsOutcomeFilter = "all" | "win" | "draw" | "loss";

export type AnalyticsFilters = {
  window: AnalyticsWindow;
  host: AnalyticsHostFilter;
  outcome: AnalyticsOutcomeFilter;
  minMargin: number;
};

export const DEFAULT_FILTERS: AnalyticsFilters = {
  window: "all",
  host: "all",
  outcome: "all",
  minMargin: 0,
};

export const MARGIN_OPTIONS = [0, 2, 3, 5] as const;

export function byMatchNo(a: AnalyticsMatch, b: AnalyticsMatch) {
  return a.matchNo - b.matchNo;
}

export function outcomeOf(m: AnalyticsMatch): MatchOutcome {
  return matchOutcome(m.myGoals, m.opponentGoals, m.decidedOnPens);
}

/** Applies the dashboard filters. window takes the LAST n matches by matchNo. */
export function filterMatches(
  matches: AnalyticsMatch[],
  filters: AnalyticsFilters,
): AnalyticsMatch[] {
  let out = [...matches].sort(byMatchNo);
  if (filters.window !== "all") {
    const n = Number(filters.window.replace("last", ""));
    out = out.slice(-n);
  }
  if (filters.host !== "all") {
    out = out.filter((m) => m.hostSide === filters.host);
  }
  if (filters.outcome !== "all") {
    out = out.filter((m) => outcomeOf(m) === filters.outcome);
  }
  if (filters.minMargin > 0) {
    out = out.filter((m) => Math.abs(m.myGoals - m.opponentGoals) >= filters.minMargin);
  }
  return out;
}

// --- SUMMARY ---

export type Scoreline = {
  matchNo: number;
  myGoals: number;
  opponentGoals: number;
  margin: number;
};

export type Summary = {
  played: number;
  wins: number;
  draws: number;
  losses: number;
  winPct: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  avgGoalsFor: number;
  cleanSheets: number;
  biggestWin: Scoreline | null;
  mostGoalsInGame: { matchNo: number; goals: number } | null;
  currentStreak: string | null;
  longestWinStreak: number;
  last5Form: MatchOutcome[]; // newest first
  latestMatchNo: number | null;
};

/** "W3" / "D1" / "L2" for the run of identical outcomes at the newest end. */
export function currentStreak(outcomesOldestFirst: MatchOutcome[]): string | null {
  if (!outcomesOldestFirst.length) return null;
  const last = outcomesOldestFirst[outcomesOldestFirst.length - 1];
  let n = 0;
  for (let i = outcomesOldestFirst.length - 1; i >= 0; i--) {
    if (outcomesOldestFirst[i] !== last) break;
    n++;
  }
  return `${last[0].toUpperCase()}${n}`;
}

export function longestStreak(outcomes: MatchOutcome[], of: MatchOutcome): number {
  let best = 0;
  let run = 0;
  for (const o of outcomes) {
    run = o === of ? run + 1 : 0;
    if (run > best) best = run;
  }
  return best;
}

export function computeSummary(matches: AnalyticsMatch[]): Summary {
  const sorted = [...matches].sort(byMatchNo);
  const outcomes = sorted.map(outcomeOf);
  let wins = 0;
  let draws = 0;
  let losses = 0;
  let goalsFor = 0;
  let goalsAgainst = 0;
  let cleanSheets = 0;
  let biggestWin: Scoreline | null = null;
  let mostGoalsInGame: { matchNo: number; goals: number } | null = null;

  for (const m of sorted) {
    const o = outcomeOf(m);
    if (o === "win") wins++;
    else if (o === "draw") draws++;
    else losses++;
    goalsFor += m.myGoals;
    goalsAgainst += m.opponentGoals;
    if (m.opponentGoals === 0) cleanSheets++;
    const margin = m.myGoals - m.opponentGoals;
    if (margin > 0 && (!biggestWin || margin > biggestWin.margin)) {
      biggestWin = {
        matchNo: m.matchNo,
        myGoals: m.myGoals,
        opponentGoals: m.opponentGoals,
        margin,
      };
    }
    if (!mostGoalsInGame || m.myGoals > mostGoalsInGame.goals) {
      mostGoalsInGame = { matchNo: m.matchNo, goals: m.myGoals };
    }
  }

  const played = sorted.length;
  return {
    played,
    wins,
    draws,
    losses,
    winPct: played ? (wins / played) * 100 : 0,
    goalsFor,
    goalsAgainst,
    goalDiff: goalsFor - goalsAgainst,
    avgGoalsFor: played ? goalsFor / played : 0,
    cleanSheets,
    biggestWin,
    mostGoalsInGame,
    currentStreak: currentStreak(outcomes),
    longestWinStreak: longestStreak(outcomes, "win"),
    last5Form: [...outcomes].reverse().slice(0, 5),
    latestMatchNo: played ? sorted[played - 1].matchNo : null,
  };
}

// --- HOSTING ---

export type HostingRow = {
  label: "Me Hosting" | "Opponent Hosting";
  played: number;
  myWins: number;
  draws: number;
  opponentWins: number;
  winPct: number; // my win % from that seat
};

export type HostingTable = {
  rows: HostingRow[];
  unattributed: number; // matches with no host recorded
};

export function computeHosting(matches: AnalyticsMatch[]): HostingTable {
  const rows: HostingRow[] = [
    { label: "Me Hosting", played: 0, myWins: 0, draws: 0, opponentWins: 0, winPct: 0 },
    { label: "Opponent Hosting", played: 0, myWins: 0, draws: 0, opponentWins: 0, winPct: 0 },
  ];
  let unattributed = 0;
  for (const m of matches) {
    if (m.hostSide === null) {
      unattributed++;
      continue;
    }
    const row = rows[m.hostSide === "me" ? 0 : 1];
    row.played++;
    const o = outcomeOf(m);
    if (o === "win") row.myWins++;
    else if (o === "draw") row.draws++;
    else row.opponentWins++;
  }
  for (const row of rows) {
    row.winPct = row.played ? (row.myWins / row.played) * 100 : 0;
  }
  return { rows, unattributed };
}

export type StatAverage = {
  key: StatKey;
  label: string;
  mine: { avg: number | null; count: number };
  theirs: { avg: number | null; count: number };
};

export type DerivedRate = { mine: number | null; theirs: number | null };

export type StatComparison = {
  stats: StatAverage[];
  shotAccuracy: DerivedRate; // SoT / shots * 100
  goalConversion: DerivedRate; // goals / shots * 100
  passAccuracy: DerivedRate; // successful passes / passes * 100
};

function avgOf(values: (number | null)[]): { avg: number | null; count: number } {
  const nums = values.filter((v): v is number => v !== null);
  if (!nums.length) return { avg: null, count: 0 };
  return { avg: nums.reduce((s, v) => s + v, 0) / nums.length, count: nums.length };
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? (numerator / denominator) * 100 : null;
}

export function computeStatComparison(matches: AnalyticsMatch[]): StatComparison {
  const stats: StatAverage[] = STAT_KEYS.map((key) => ({
    key,
    label: STAT_LABELS[key],
    mine: avgOf(matches.map((m) => m.my[key])),
    theirs: avgOf(matches.map((m) => m.opp[key])),
  }));

  // Totals over matches where the relevant stats exist (never zero-inflated).
  let mySoT = 0;
  let myShots = 0;
  let myGoals = 0;
  let myPasses = 0;
  let mySucc = 0;
  let oppSoT = 0;
  let oppShots = 0;
  let oppGoals = 0;
  let oppPasses = 0;
  let oppSucc = 0;
  for (const m of matches) {
    if (m.my.shots !== null) {
      myShots += m.my.shots;
      mySoT += m.my.shots_on_target ?? 0;
      myGoals += m.myGoals;
    }
    if (m.opp.shots !== null) {
      oppShots += m.opp.shots;
      oppSoT += m.opp.shots_on_target ?? 0;
      oppGoals += m.opponentGoals;
    }
    if (m.my.passes !== null) {
      myPasses += m.my.passes;
      mySucc += m.my.successful_passes ?? 0;
    }
    if (m.opp.passes !== null) {
      oppPasses += m.opp.passes;
      oppSucc += m.opp.successful_passes ?? 0;
    }
  }

  return {
    stats,
    shotAccuracy: { mine: rate(mySoT, myShots), theirs: rate(oppSoT, oppShots) },
    goalConversion: { mine: rate(myGoals, myShots), theirs: rate(oppGoals, oppShots) },
    passAccuracy: { mine: rate(mySucc, myPasses), theirs: rate(oppSucc, oppPasses) },
  };
}

// --- TREND SERIES + RECORDS ---

export type TrendPoint = {
  matchNo: number;
  myGoals: number;
  oppGoals: number;
  goalDiff: number;
  h2hNetWins: number; // cumulative my wins - opponent wins
  myPossession: number | null;
  oppPossession: number | null;
};

/** Rolling series over the last `limit` matches (or all of them). */
export function buildTrendSeries(matches: AnalyticsMatch[], limit = 20): TrendPoint[] {
  const sorted = [...matches].sort(byMatchNo).slice(-limit);
  let netWins = 0;
  return sorted.map((m) => {
    const o = outcomeOf(m);
    if (o === "win") netWins += 1;
    else if (o === "loss") netWins -= 1;
    return {
      matchNo: m.matchNo,
      myGoals: m.myGoals,
      oppGoals: m.opponentGoals,
      goalDiff: m.myGoals - m.opponentGoals,
      h2hNetWins: netWins,
      myPossession: m.my.possession,
      oppPossession: m.opp.possession,
    };
  });
}

export type Records = {
  thriller: { matchNo: number; myGoals: number; opponentGoals: number; combined: number } | null;
  blowout: Scoreline | null; // biggest absolute margin either way
  mostShots: { matchNo: number; side: "me" | "opponent"; shots: number } | null;
  bestPassAccuracy: { matchNo: number; side: "me" | "opp"; pct: number } | null;
};

export function computeRecords(matches: AnalyticsMatch[]): Records {
  let thriller: Records["thriller"] = null;
  let blowout: Scoreline | null = null;
  let mostShots: Records["mostShots"] = null;
  let bestPassAccuracy: Records["bestPassAccuracy"] = null;

  for (const m of matches) {
    const combined = m.myGoals + m.opponentGoals;
    if (!thriller || combined > thriller.combined) {
      thriller = {
        matchNo: m.matchNo,
        myGoals: m.myGoals,
        opponentGoals: m.opponentGoals,
        combined,
      };
    }
    const margin = Math.abs(m.myGoals - m.opponentGoals);
    if (margin > 0 && (!blowout || margin > blowout.margin)) {
      blowout = {
        matchNo: m.matchNo,
        myGoals: m.myGoals,
        opponentGoals: m.opponentGoals,
        margin,
      };
    }
    if (m.my.shots !== null && (!mostShots || m.my.shots > mostShots.shots)) {
      mostShots = { matchNo: m.matchNo, side: "me", shots: m.my.shots };
    }
    if (m.opp.shots !== null && (!mostShots || m.opp.shots > mostShots.shots)) {
      mostShots = { matchNo: m.matchNo, side: "opponent", shots: m.opp.shots };
    }
    for (const side of ["me", "opp"] as const) {
      const s = side === "me" ? m.my : m.opp;
      if (s.passes !== null && s.passes > 0 && s.successful_passes !== null) {
        const pct = (s.successful_passes / s.passes) * 100;
        if (!bestPassAccuracy || pct > bestPassAccuracy.pct) {
          bestPassAccuracy = { matchNo: m.matchNo, side, pct };
        }
      }
    }
  }
  return { thriller, blowout, mostShots, bestPassAccuracy };
}

/** Full dashboard model for one filtered view. */
export function computeRivalryAnalytics(
  matches: AnalyticsMatch[],
  filters: AnalyticsFilters,
) {
  const filtered = filterMatches(matches, filters);
  return {
    filtered,
    summary: computeSummary(filtered),
    hosting: computeHosting(filtered),
    comparison: computeStatComparison(filtered),
    series: buildTrendSeries(filtered),
    records: computeRecords(filtered),
  };
}
