// Analytics tests: parse "EFOOTIE REALITY .xlsx" directly and verify every
// calculation in src/lib/rivalry-analytics.ts against the known 31-match
// dataset, plus multi-rivalry career aggregation. Pure functions only; no
// database rows are created or deleted.

import { describe, expect, it } from "vitest";
import { parseMatchLog } from "../scripts/sheet-parser.mjs";
import { STAT_KEYS } from "@/lib/match-stats";
import {
  type AnalyticsFilters,
  type AnalyticsMatch,
  DEFAULT_FILTERS,
  buildTrendSeries,
  computeHosting,
  computeRecords,
  computeStatComparison,
  computeSummary,
  currentStreak,
  filterMatches,
  longestStreak,
} from "@/lib/rivalry-analytics";

const rows = parseMatchLog();

function rowToMatch(r: (typeof rows)[number]): AnalyticsMatch {
  const empty = () =>
    Object.fromEntries(STAT_KEYS.map((k) => [k, null])) as AnalyticsMatch["my"];
  const my = empty();
  const opp = empty();
  my.possession = r.namanPossession;
  my.shots = r.namanShots;
  my.shots_on_target = r.namanShotsOnTarget;
  my.fouls = r.namanFouls;
  my.corners = r.namanCorners;
  my.passes = r.namanPasses;
  my.successful_passes = r.namanSuccessfulPasses;
  my.tackles = r.namanTackles;
  my.offsides = r.namanOffsides ?? null;
  my.free_kicks = r.namanFreeKicks ?? null;
  my.crosses = r.namanCrosses ?? null;
  my.interceptions = r.namanInterceptions ?? null;
  my.saves = r.namanSaves ?? null;
  opp.possession = r.namanPossession === null ? null : 100 - r.namanPossession;
  opp.shots = r.ayushShots;
  opp.shots_on_target = r.ayushShotsOnTarget;
  opp.fouls = r.ayushFouls;
  opp.corners = r.ayushCorners;
  opp.passes = r.ayushPasses;
  opp.successful_passes = r.ayushSuccessfulPasses;
  opp.tackles = r.ayushTackles;
  opp.offsides = r.ayushOffsides ?? null;
  opp.free_kicks = r.ayushFreeKicks ?? null;
  opp.crosses = r.ayushCrosses ?? null;
  opp.interceptions = r.ayushInterceptions ?? null;
  opp.saves = r.ayushSaves ?? null;
  return {
    matchNo: r.matchNo,
    playedAt: r.playedAt,
    hostSide: r.host === "Naman" ? "me" : r.host === "Ayush" ? "opponent" : null,
    myGoals: r.namanGoals ?? 0,
    opponentGoals: r.ayushGoals ?? 0,
    decidedOnPens: r.decidedOnPens,
    needsReview: r.needsReview,
    my,
    opp,
  };
}

const matches = rows.map(rowToMatch);

describe("sheet parsing", () => {
  it("extracts exactly 31 rows with Excel Row 12 skipped", () => {
    expect(rows).toHaveLength(31);
    expect(rows.map((r) => r.matchNo)).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(rows.some((r) => r.excelRow === 12)).toBe(false);
    expect(rows[0].excelRow).toBe(6);
    expect(rows[6].excelRow).toBe(13); // first row after the skipped duplicate
  });

  it("matches the known totals: 22W-1D-8L, 172-116 goals, 1 pens, 4 review", () => {
    expect(matches.filter((m) => m.myGoals > m.opponentGoals && !m.decidedOnPens)).toHaveLength(22);
    expect(matches.filter((m) => m.opponentGoals > m.myGoals && !m.decidedOnPens)).toHaveLength(8);
    expect(matches.filter((m) => m.decidedOnPens || m.myGoals === m.opponentGoals)).toHaveLength(1);
    expect(matches.reduce((s, m) => s + m.myGoals, 0)).toBe(172);
    expect(matches.reduce((s, m) => s + m.opponentGoals, 0)).toBe(116);
    expect(matches.filter((m) => m.decidedOnPens)).toHaveLength(1);
    expect(matches.filter((m) => m.needsReview)).toHaveLength(4);
    expect(matches.filter((m) => m.playedAt === null)).toHaveLength(4);
    expect(matches.filter((m) => m.hostSide === null)).toHaveLength(4);
  });

  it("maps stats, nulls, fallback teams and remarks correctly", () => {
    // Row 6 (match 1): "EXAMPLE..." remark becomes null.
    expect(rows[0].remark).toBeNull();
    // Row 16 (match 10, 5-1): no stats at all.
    const m10 = matches[9];
    expect(m10.myGoals).toBe(5);
    expect(m10.opponentGoals).toBe(1);
    expect(Object.values(m10.my).every((v) => v === null)).toBe(true);
    expect(rows[9].namanTeam).toBe("Belgium"); // fallback team applied
    expect(rows[9].ayushTeam).toBe("FC Bayern München");
    // Row 17 (match 11, 6-6) is the pens match.
    expect(matches[10].decidedOnPens).toBe(true);
    expect(matches[10].myGoals).toBe(6);
    // Screenshot-only stats exist for exactly the 21 extracted matches.
    const extra = matches.filter((m) => m.my.offsides !== null);
    expect(extra).toHaveLength(21);
    expect(matches.filter((m) => m.my.offsides === null && m.my.saves === null)).toHaveLength(10);
    expect(extra.reduce((s, m) => s + (m.my.offsides ?? 0), 0)).toBe(29);
    expect(extra.reduce((s, m) => s + (m.opp.offsides ?? 0), 0)).toBe(24);
    expect(extra.reduce((s, m) => s + (m.my.free_kicks ?? 0), 0)).toBe(45);
    expect(extra.reduce((s, m) => s + (m.opp.free_kicks ?? 0), 0)).toBe(66);
    expect(extra.reduce((s, m) => s + (m.my.crosses ?? 0), 0)).toBe(128);
    expect(extra.reduce((s, m) => s + (m.opp.crosses ?? 0), 0)).toBe(54);
    expect(extra.reduce((s, m) => s + (m.my.interceptions ?? 0), 0)).toBe(735);
    expect(extra.reduce((s, m) => s + (m.opp.interceptions ?? 0), 0)).toBe(973);
    expect(extra.reduce((s, m) => s + (m.my.saves ?? 0), 0)).toBe(78);
    expect(extra.reduce((s, m) => s + (m.opp.saves ?? 0), 0)).toBe(109);
    // Average shots over the 30 stat matches.
    const shotMatches = matches.filter((m) => m.my.shots !== null);
    expect(shotMatches).toHaveLength(30);
    const namanAvg = shotMatches.reduce((s, m) => s + (m.my.shots ?? 0), 0) / 30;
    const ayushAvg = shotMatches.reduce((s, m) => s + (m.opp.shots ?? 0), 0) / 30;
    expect(namanAvg).toBeCloseTo(16.067, 2);
    expect(ayushAvg).toBeCloseTo(9.967, 2);
    expect(matches.reduce((s, m) => s + (m.my.passes ?? 0), 0)).toBe(6022);
    expect(matches.reduce((s, m) => s + (m.my.successful_passes ?? 0), 0)).toBe(4239);
  });
});

describe("summary", () => {
  const s = computeSummary(matches);

  it("computes the H2H record and goal totals", () => {
    expect(s.played).toBe(31);
    expect(s.wins).toBe(22);
    expect(s.draws).toBe(1);
    expect(s.losses).toBe(8);
    expect(s.winPct).toBeCloseTo((22 / 31) * 100, 5);
    expect(s.goalsFor).toBe(172);
    expect(s.goalsAgainst).toBe(116);
    expect(s.goalDiff).toBe(56);
    expect(s.avgGoalsFor).toBeCloseTo(172 / 31, 5);
    expect(s.cleanSheets).toBe(0); // Ayush always scored at least once
  });

  it("computes streaks, records and form", () => {
    expect(s.currentStreak).toBe("L1"); // match 31 was a 4-6 loss
    expect(s.longestWinStreak).toBe(8); // matches 13-20
    expect(s.biggestWin?.matchNo).toBe(17); // 11-4, first +7
    expect(s.biggestWin?.margin).toBe(7);
    expect(s.mostGoalsInGame).toEqual({ matchNo: 18, goals: 12 });
    expect(s.last5Form).toEqual(["loss", "win", "win", "loss", "loss"]); // newest first
  });

  it("treats penalty shootouts as draws", () => {
    const pens = { ...matches[10], myGoals: 3, opponentGoals: 2 }; // 3-2 on the sheet
    const out = computeSummary([pens]);
    expect(out.draws).toBe(1);
    expect(out.wins).toBe(0);
    expect(out.losses).toBe(0);
    expect(out.last5Form).toEqual(["draw"]);
  });

  it("computes streak helpers directly", () => {
    expect(currentStreak(["win", "win", "win"])).toBe("W3");
    expect(currentStreak(["win", "loss", "loss"])).toBe("L2");
    expect(currentStreak(["draw"])).toBe("D1");
    expect(currentStreak([])).toBeNull();
    expect(longestStreak(["win", "loss", "win", "win", "loss", "win"], "win")).toBe(2);
  });
});

describe("hosting table", () => {
  const h = computeHosting(matches);

  it("splits home and away, excluding unattributed matches", () => {
    expect(h.rows[0]).toMatchObject({
      label: "Me Hosting",
      played: 21,
      myWins: 15,
      draws: 1,
      opponentWins: 5,
    });
    expect(h.rows[0].winPct).toBeCloseTo((15 / 21) * 100, 5);
    expect(h.rows[1]).toMatchObject({
      label: "Opponent Hosting",
      played: 6,
      myWins: 4,
      draws: 0,
      opponentWins: 2,
    });
    expect(h.unattributed).toBe(4);
    // The three splits add back up to the overall record.
    const w = h.rows[0].myWins + h.rows[1].myWins + 3; // 3 wins with no host
    const l = h.rows[0].opponentWins + h.rows[1].opponentWins + 1;
    expect(w).toBe(22);
    expect(l).toBe(8);
  });
});

describe("stat comparison", () => {
  const c = computeStatComparison(matches);

  it("averages over non-null matches only (never zero-inflated)", () => {
    const shots = c.stats.find((s) => s.key === "shots")!;
    expect(shots.mine.count).toBe(30);
    expect(shots.mine.avg).toBeCloseTo(16.067, 2);
    expect(shots.theirs.avg).toBeCloseTo(9.967, 2);
    // Enriched screenshot stats average over their 21 non-null matches only.
    const offsides = c.stats.find((s) => s.key === "offsides")!;
    expect(offsides.mine.count).toBe(21);
    expect(offsides.mine.avg).toBeCloseTo(29 / 21, 3); // ≈ 1.4
    const saves = c.stats.find((s) => s.key === "saves")!;
    expect(saves.theirs.avg).toBeCloseTo(109 / 21, 3);
  });

  it("computes shot / goal conversion / pass accuracy rates", () => {
    expect(c.passAccuracy.mine).toBeCloseTo((4239 / 6022) * 100, 3);
    const statMatches = matches.filter((m) => m.my.shots !== null);
    const soT = statMatches.reduce((s, m) => s + (m.my.shots_on_target ?? 0), 0);
    const shots = statMatches.reduce((s, m) => s + (m.my.shots ?? 0), 0);
    const goalsOverStatMatches = statMatches.reduce((s, m) => s + m.myGoals, 0); // 167
    expect(c.shotAccuracy.mine).toBeCloseTo((soT / shots) * 100, 3);
    expect(c.goalConversion.mine).toBeCloseTo((goalsOverStatMatches / shots) * 100, 3);
  });
});

describe("filters", () => {
  const f = (patch: Partial<AnalyticsFilters>) =>
    filterMatches(matches, { ...DEFAULT_FILTERS, ...patch });

  it("window filters take the newest n matches", () => {
    expect(f({ window: "last5" }).map((m) => m.matchNo)).toEqual([27, 28, 29, 30, 31]);
    expect(f({ window: "last10" })).toHaveLength(10);
    expect(f({ window: "all" })).toHaveLength(31);
  });

  it("filters by host, outcome and margin", () => {
    expect(f({ host: "me" })).toHaveLength(21);
    expect(f({ host: "opponent" })).toHaveLength(6);
    expect(f({ outcome: "win" })).toHaveLength(22);
    expect(f({ outcome: "draw" })).toHaveLength(1);
    expect(f({ outcome: "loss" })).toHaveLength(8);
    expect(f({ minMargin: 5 }).map((m) => m.matchNo).sort((a, b) => a - b)).toEqual([
      4, 8, 17, 18, 24, 26,
    ]);
  });

  it("combines filters", () => {
    const combo = f({ window: "last10", host: "me", outcome: "win", minMargin: 0 });
    expect(combo.every((m) => m.hostSide === "me")).toBe(true);
    expect(combo.every((m) => m.myGoals > m.opponentGoals && !m.decidedOnPens)).toBe(true);
    expect(combo.every((m) => m.matchNo >= 22)).toBe(true);
    expect(combo.length).toBeGreaterThan(0);
    expect(f({ window: "last10", outcome: "draw" })).toHaveLength(0);
    expect(f({ window: "all", outcome: "draw" })[0].decidedOnPens).toBe(true);
  });
});

describe("trend series and records", () => {
  it("builds a 20-point series ending at the +14 H2H lead", () => {
    const series = buildTrendSeries(matches);
    expect(series).toHaveLength(20);
    expect(series[0].matchNo).toBe(12);
    expect(series[series.length - 1]).toMatchObject({
      matchNo: 31,
      myGoals: 4,
      oppGoals: 6,
      goalDiff: -2,
      h2hNetWins: 10, // 15 wins - 5 losses within the last-20 window
    });
  });

  it("finds the thriller, blowout, most shots and best pass accuracy", () => {
    const r = computeRecords(matches);
    expect(r.thriller).toMatchObject({ matchNo: 18, combined: 17 }); // 12-5
    expect(r.blowout).toMatchObject({ matchNo: 17, margin: 7 }); // 11-4 (first +7)
    expect(r.mostShots).toMatchObject({ side: "me", shots: 24 }); // match 17
    expect(r.bestPassAccuracy).not.toBeNull();
    expect(r.bestPassAccuracy!.pct).toBeGreaterThan(70);
  });
});

describe("career aggregation (me vs everyone)", () => {
  it("aggregates two rivalries where the user is user_a in one and user_b in the other", () => {
    // Rivalry 1: the real sheet data, oriented as Naman (whichever slot he is).
    const rivalryOne = matches;
    // Rivalry 2: a small synthetic rivalry, already oriented "me vs opponent".
    const rivalryTwo: AnalyticsMatch[] = [
      {
        matchNo: 1,
        playedAt: "2026-11-10",
        hostSide: "me",
        myGoals: 2,
        opponentGoals: 2,
        decidedOnPens: false,
        needsReview: false,
        my: { ...matches[0].my, shots: 10, shots_on_target: 5 },
        opp: { ...matches[0].opp, shots: 8, shots_on_target: 3 },
      },
      {
        matchNo: 2,
        playedAt: "2026-11-11",
        hostSide: "opponent",
        myGoals: 0,
        opponentGoals: 3,
        decidedOnPens: true, // 0-3 on the scoreboard but pens => draw
        needsReview: false,
        my: { ...matches[0].my, shots: 6, shots_on_target: 2 },
        opp: { ...matches[0].opp, shots: 12, shots_on_target: 7 },
      },
    ];

    const combined = computeSummary([...rivalryOne, ...rivalryTwo]);
    expect(combined.played).toBe(33);
    expect(combined.wins).toBe(22);
    expect(combined.draws).toBe(3); // 1 sheet pens draw + 2 synthetic draws
    expect(combined.losses).toBe(8);
    expect(combined.goalsFor).toBe(172 + 2);
    expect(combined.goalsAgainst).toBe(116 + 5);

    const perRivalry = [rivalryOne, rivalryTwo].map((list) => computeSummary(list));
    expect(perRivalry[1]).toMatchObject({ played: 2, wins: 0, draws: 2, losses: 0 });
    // Per-rivalry summaries add back up to the overall numbers.
    expect(perRivalry.reduce((s, r) => s + r.wins, 0)).toBe(combined.wins);
    expect(perRivalry.reduce((s, r) => s + r.draws, 0)).toBe(combined.draws);

    const c = computeStatComparison(rivalryTwo);
    expect(c.shotAccuracy.mine).toBeCloseTo((7 / 16) * 100, 5);
  });
});

