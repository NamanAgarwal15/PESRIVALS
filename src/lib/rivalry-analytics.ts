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
  /** Absent on legacy callers; anything other than "confirmed" is ignored by Tier 1B. */
  status?: "confirmed" | "pending" | "disputed";
  /** Phase 4 context tags (null when untagged). */
  myPlaystyle?: string | null;
  oppPlaystyle?: string | null;
  matchContext?: string | null;
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
    derived: computeDerivedIndices(filtered),
    eda: computeEdaLab(filtered),
  };
}

// ===========================================================================
// Tier 1B: derived indices + Rivalry EDA Lab. Pure and null-safe: a missing
// stat or a zero denominator yields null, never NaN or Infinity.
// ===========================================================================

/** Only confirmed matches count; a match with no status (legacy callers) does. */
export function onlyConfirmed(matches: AnalyticsMatch[]): AnalyticsMatch[] {
  return matches.filter((m) => m.status === undefined || m.status === "confirmed");
}

const finite = (v: number): number | null => (Number.isFinite(v) ? v : null);
const ratio = (num: number, den: number): number | null => (den > 0 ? finite(num / den) : null);

export const CLINICAL_K = 10;

export type PlayerIndices = {
  /** Shrunk goals / shots on target, as a percent. */
  shotClinical: number | null;
  /** Passes per minute of possession (90-minute match). */
  buildUpTempo: number | null;
  /** Crosses as a percent of passes; null when crosses were never recorded. */
  directness: number | null;
  /** Opponent passes per defensive action (lower = harder press). */
  pressing: number | null;
  /** Saves as a percent of opponent shots on target. */
  saveEfficiency: number | null;
};

export type DerivedIndices = { mine: PlayerIndices; theirs: PlayerIndices; clinicalPrior: number | null };

function indicesFor(ms: AnalyticsMatch[], side: "my" | "opp", prior: number | null): PlayerIndices {
  const other = side === "my" ? "opp" : "my";
  const goalsOf = (m: AnalyticsMatch) => (side === "my" ? m.myGoals : m.opponentGoals);

  let goals = 0;
  let sot = 0;
  let tempoSum = 0;
  let tempoN = 0;
  let crosses = 0;
  let crossPasses = 0;
  let oppPasses = 0;
  let defActions = 0;
  let saves = 0;
  let faced = 0;

  for (const m of ms) {
    const s = m[side];
    const o = m[other];
    if (s.shots_on_target !== null) {
      sot += s.shots_on_target;
      goals += goalsOf(m);
    }
    if (s.passes !== null && s.possession !== null && s.possession > 0) {
      const t = s.passes / (90 * (s.possession / 100));
      if (Number.isFinite(t)) {
        tempoSum += t;
        tempoN++;
      }
    }
    if (s.crosses !== null && s.passes !== null) {
      crosses += s.crosses;
      crossPasses += s.passes;
    }
    if (o.passes !== null && s.tackles !== null) {
      const def = s.tackles + (s.interceptions ?? 0) + (s.fouls ?? 0);
      if (def > 0) {
        oppPasses += o.passes;
        defActions += def;
      }
    }
    if (s.saves !== null && o.shots_on_target !== null) {
      saves += s.saves;
      faced += o.shots_on_target;
    }
  }

  const clinical =
    prior === null ? null : finite(((goals + CLINICAL_K * prior) / (sot + CLINICAL_K)) * 100);
  const direct = ratio(crosses, crossPasses);
  const save = ratio(saves, faced);
  return {
    shotClinical: clinical,
    buildUpTempo: tempoN ? finite(tempoSum / tempoN) : null,
    directness: direct === null ? null : direct * 100,
    pressing: ratio(oppPasses, defActions),
    saveEfficiency: save === null ? null : save * 100,
  };
}

export function computeDerivedIndices(matches: AnalyticsMatch[]): DerivedIndices {
  const ms = onlyConfirmed(matches);
  // Rivalry-wide mean conversion of shots on target, both players pooled.
  let goals = 0;
  let sot = 0;
  for (const m of ms) {
    if (m.my.shots_on_target !== null) {
      sot += m.my.shots_on_target;
      goals += m.myGoals;
    }
    if (m.opp.shots_on_target !== null) {
      sot += m.opp.shots_on_target;
      goals += m.opponentGoals;
    }
  }
  const prior = ratio(goals, sot);
  return { mine: indicesFor(ms, "my", prior), theirs: indicesFor(ms, "opp", prior), clinicalPrior: prior };
}

// --- EDA LAB ---

export type Record3 = { played: number; wins: number; draws: number; losses: number; winPct: number | null };

function record(ms: AnalyticsMatch[]): Record3 {
  let wins = 0;
  let draws = 0;
  let losses = 0;
  for (const m of ms) {
    const o = outcomeOf(m);
    if (o === "win") wins++;
    else if (o === "draw") draws++;
    else losses++;
  }
  const played = ms.length;
  const p = ratio(wins, played);
  return { played, wins, draws, losses, winPct: p === null ? null : p * 100 };
}

export type ClutchProfile = {
  oneGoal: Record3;
  blowoutWins: number;
  blowoutLosses: number;
  avgWinMargin: { mine: number | null; theirs: number | null };
};

export function computeClutchProfile(matches: AnalyticsMatch[]): ClutchProfile {
  const ms = onlyConfirmed(matches);
  const diff = (m: AnalyticsMatch) => m.myGoals - m.opponentGoals;
  const wonBy = (sign: 1 | -1) => ms.filter((m) => diff(m) * sign > 0 && outcomeOf(m) !== "draw");
  const avg = (xs: AnalyticsMatch[]) => (xs.length ? xs.reduce((s, m) => s + Math.abs(diff(m)), 0) / xs.length : null);
  return {
    oneGoal: record(ms.filter((m) => Math.abs(diff(m)) === 1)),
    blowoutWins: ms.filter((m) => diff(m) >= 4 && outcomeOf(m) === "win").length,
    blowoutLosses: ms.filter((m) => diff(m) <= -4 && outcomeOf(m) === "loss").length,
    avgWinMargin: { mine: avg(wonBy(1)), theirs: avg(wonBy(-1)) },
  };
}

export const EDA_STATS = [
  "possession",
  "shots",
  "shots_on_target",
  "passes",
  "pass_accuracy",
  "tackles",
  "corners",
] as const;
export type EdaStat = (typeof EDA_STATS)[number];
export const EDA_STAT_LABELS: Record<EdaStat, string> = {
  possession: "Possession",
  shots: "Shots",
  shots_on_target: "Shots on Target",
  passes: "Passes",
  pass_accuracy: "Pass Accuracy",
  tackles: "Tackles",
  corners: "Corners",
};

function statValue(s: StatSides, stat: EdaStat): number | null {
  if (stat === "pass_accuracy") {
    return s.passes !== null && s.passes > 0 && s.successful_passes !== null
      ? (s.successful_passes / s.passes) * 100
      : null;
  }
  return s[stat];
}

export type LeadingRow = {
  stat: EdaStat;
  label: string;
  mine: { n: number; wins: number; winPct: number | null };
  theirs: { n: number; wins: number; winPct: number | null };
};

/** Win rate of each player in matches where they led the given stat (strictly). */
export function computeLeadingWinPct(matches: AnalyticsMatch[]): LeadingRow[] {
  const ms = onlyConfirmed(matches);
  return EDA_STATS.map((stat) => {
    const acc = { mine: { n: 0, wins: 0 }, theirs: { n: 0, wins: 0 } };
    for (const m of ms) {
      const a = statValue(m.my, stat);
      const b = statValue(m.opp, stat);
      if (a === null || b === null || a === b) continue;
      const o = outcomeOf(m);
      if (a > b) {
        acc.mine.n++;
        if (o === "win") acc.mine.wins++;
      } else {
        acc.theirs.n++;
        if (o === "loss") acc.theirs.wins++;
      }
    }
    const fin = (x: { n: number; wins: number }) => {
      const p = ratio(x.wins, x.n);
      return { ...x, winPct: p === null ? null : p * 100 };
    };
    return { stat, label: EDA_STAT_LABELS[stat], mine: fin(acc.mine), theirs: fin(acc.theirs) };
  });
}

/** Pearson r; null for fewer than 3 pairs or zero variance. Never NaN. */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = Math.min(xs.length, ys.length);
  if (n < 3) return null;
  const mx = xs.slice(0, n).reduce((s, v) => s + v, 0) / n;
  const my = ys.slice(0, n).reduce((s, v) => s + v, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  const r = sxy / Math.sqrt(sxx * syy);
  return Number.isFinite(r) ? Math.max(-1, Math.min(1, r)) : null;
}

export type CorrelationLabel = "Strong +" | "Moderate +" | "Weak" | "Moderate −" | "Strong −" | "N/A";

export function correlationLabel(r: number | null): CorrelationLabel {
  if (r === null) return "N/A";
  if (r >= 0.6) return "Strong +";
  if (r >= 0.3) return "Moderate +";
  if (r <= -0.6) return "Strong −";
  if (r <= -0.3) return "Moderate −";
  return "Weak";
}

export type CorrelationRow = { stat: EdaStat; label: string; n: number; r: number | null; strength: CorrelationLabel };

/** Correlation between each stat edge (me − opponent) and goal difference. */
export function computeStatCorrelations(matches: AnalyticsMatch[]): CorrelationRow[] {
  const ms = onlyConfirmed(matches);
  return EDA_STATS.map((stat) => {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const m of ms) {
      const a = statValue(m.my, stat);
      const b = statValue(m.opp, stat);
      if (a === null || b === null) continue;
      xs.push(a - b);
      ys.push(m.myGoals - m.opponentGoals);
    }
    const r = pearson(xs, ys);
    return { stat, label: EDA_STAT_LABELS[stat], n: xs.length, r, strength: correlationLabel(r) };
  });
}

export type SessionRow = {
  date: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  goalsFor: number;
  goalsAgainst: number;
  goalsPerMatch: number | null;
};

/** One row per calendar date (YYYY-MM-DD), newest first. Undated matches are skipped. */
export function computeSessions(matches: AnalyticsMatch[]): SessionRow[] {
  const byDate = new Map<string, AnalyticsMatch[]>();
  for (const m of onlyConfirmed(matches)) {
    if (!m.playedAt) continue;
    const d = m.playedAt.slice(0, 10);
    byDate.set(d, [...(byDate.get(d) ?? []), m]);
  }
  return [...byDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([date, ms]) => {
      const r = record(ms);
      const gf = ms.reduce((s, m) => s + m.myGoals, 0);
      const ga = ms.reduce((s, m) => s + m.opponentGoals, 0);
      return {
        date,
        played: r.played,
        wins: r.wins,
        draws: r.draws,
        losses: r.losses,
        goalsFor: gf,
        goalsAgainst: ga,
        goalsPerMatch: ratio(gf + ga, r.played),
      };
    });
}

export type ScorelineStats = {
  common: { score: string; count: number }[];
  margins: { label: "1 goal" | "2 goals" | "3 goals" | "4+ goals"; count: number; mine: number; theirs: number }[];
};

export function computeScorelines(matches: AnalyticsMatch[], top = 5): ScorelineStats {
  const ms = onlyConfirmed(matches);
  const counts = new Map<string, number>();
  const margins: ScorelineStats["margins"] = [
    { label: "1 goal", count: 0, mine: 0, theirs: 0 },
    { label: "2 goals", count: 0, mine: 0, theirs: 0 },
    { label: "3 goals", count: 0, mine: 0, theirs: 0 },
    { label: "4+ goals", count: 0, mine: 0, theirs: 0 },
  ];
  for (const m of ms) {
    const key = `${m.myGoals}–${m.opponentGoals}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const d = m.myGoals - m.opponentGoals;
    const o = outcomeOf(m);
    if (d === 0 || o === "draw") continue; // penalty-decided matches are draws
    const bucket = margins[Math.min(Math.abs(d), 4) - 1];
    bucket.count++;
    if (d > 0) bucket.mine++;
    else bucket.theirs++;
  }
  const common = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, top)
    .map(([score, count]) => ({ score, count }));
  return { common, margins };
}

// --- PERSONAL WIN DRIVERS ---

export type WinDriverRow = {
  stat: EdaStat;
  label: string;
  winN: number;
  lossN: number;
  winAvg: number | null;
  lossAvg: number | null;
  /** winAvg - lossAvg: how much higher this stat is in their wins than in their losses. */
  lift: number | null;
  /** Point-biserial correlation of the stat with winning (win = 1, loss = 0); draws excluded. */
  r: number | null;
  strength: CorrelationLabel;
};

function driversFor(ms: AnalyticsMatch[], who: "my" | "opp"): WinDriverRow[] {
  const won = (m: AnalyticsMatch) => (who === "my" ? outcomeOf(m) === "win" : outcomeOf(m) === "loss");
  const lost = (m: AnalyticsMatch) => (who === "my" ? outcomeOf(m) === "loss" : outcomeOf(m) === "win");
  return EDA_STATS.map((stat) => {
    const wins: number[] = [];
    const losses: number[] = [];
    for (const m of ms) {
      const v = statValue(m[who], stat);
      if (v === null) continue;
      if (won(m)) wins.push(v);
      else if (lost(m)) losses.push(v);
    }
    const avg = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null);
    const winAvg = avg(wins);
    const lossAvg = avg(losses);
    const r = pearson([...wins, ...losses], [...wins.map(() => 1), ...losses.map(() => 0)]);
    return {
      stat,
      label: EDA_STAT_LABELS[stat],
      winN: wins.length,
      lossN: losses.length,
      winAvg,
      lossAvg,
      lift: winAvg !== null && lossAvg !== null ? winAvg - lossAvg : null,
      r,
      strength: correlationLabel(r),
    };
  });
}

/** Each player's own stats in their wins vs their losses. Player A = you, Player B = your rival. */
export function computePlayerWinDrivers(matches: AnalyticsMatch[]): { playerA: WinDriverRow[]; playerB: WinDriverRow[] } {
  const ms = onlyConfirmed(matches).filter((m) => (m as { deletedAt?: unknown }).deletedAt == null);
  return { playerA: driversFor(ms, "my"), playerB: driversFor(ms, "opp") };
}

export function computeEdaLab(matches: AnalyticsMatch[]) {
  return {
    clutch: computeClutchProfile(matches),
    leading: computeLeadingWinPct(matches),
    correlations: computeStatCorrelations(matches),
    drivers: computePlayerWinDrivers(matches),
    sessions: computeSessions(matches),
    scorelines: computeScorelines(matches),
  };
}
