// Phase 3: derived indices, EDA Lab, extraction cache, trusted IP headers.
import { describe, expect, it } from "vitest";
import {
  type AnalyticsMatch,
  type StatSides,
  computeClutchProfile,
  computeDerivedIndices,
  computeEdaLab,
  computeLeadingWinPct,
  computeScorelines,
  computeSessions,
  computeStatCorrelations,
  correlationLabel,
  pearson,
} from "@/lib/rivalry-analytics";
import {
  EXTRACT_CACHE_MAX,
  EXTRACT_CACHE_TTL_MS,
  clearExtractionCache,
  getCachedExtraction,
  putCachedExtraction,
  sha256Hex,
} from "@/lib/extract-cache";
import { clientIpFromHeaders } from "@/lib/rate-limit";

const EMPTY: StatSides = {
  possession: null, shots: null, shots_on_target: null, fouls: null, offsides: null, corners: null,
  free_kicks: null, passes: null, successful_passes: null, crosses: null, interceptions: null,
  tackles: null, saves: null,
};
let no = 0;
const m = (
  myGoals: number,
  opponentGoals: number,
  my: Partial<StatSides> = {},
  opp: Partial<StatSides> = {},
  extra: Partial<AnalyticsMatch> = {},
): AnalyticsMatch => ({
  matchNo: ++no, playedAt: null, hostSide: null, myGoals, opponentGoals, decidedOnPens: false,
  needsReview: false, my: { ...EMPTY, ...my }, opp: { ...EMPTY, ...opp }, ...extra,
});

const allFinite = (o: unknown): boolean => {
  if (typeof o === "number") return Number.isFinite(o);
  if (o && typeof o === "object") return Object.values(o).every(allFinite);
  return true;
};

describe("derived indices", () => {
  it("computes all five from a full row", () => {
    const d = computeDerivedIndices([
      m(2, 1,
        { shots_on_target: 4, possession: 60, passes: 108, crosses: 10, tackles: 5, interceptions: 3, fouls: 2, saves: 2 },
        { shots_on_target: 5, possession: 40, passes: 90, crosses: 2, tackles: 4, interceptions: 1, fouls: 5, saves: 3 }),
    ]);
    // prior = 3 goals / 9 SoT; mine = (2 + 10/3) / 14
    expect(d.clinicalPrior).toBeCloseTo(1 / 3);
    expect(d.mine.shotClinical).toBeCloseTo(((2 + 10 / 3) / 14) * 100);
    expect(d.mine.buildUpTempo).toBeCloseTo(108 / (90 * 0.6));
    expect(d.mine.directness).toBeCloseTo((10 / 108) * 100);
    expect(d.mine.pressing).toBeCloseTo(90 / (5 + 3 + 2));
    expect(d.mine.saveEfficiency).toBeCloseTo((2 / 5) * 100);
    expect(d.theirs.saveEfficiency).toBeCloseTo((3 / 4) * 100);
  });

  it("shrinks tiny samples toward the mean instead of spiking to 100%", () => {
    const d = computeDerivedIndices([
      m(1, 0, { shots_on_target: 1 }, { shots_on_target: 9 }),
    ]);
    expect(d.mine.shotClinical!).toBeLessThan(25);
  });

  it("falls back cleanly when interceptions are null and is N/A for missing stats", () => {
    const d = computeDerivedIndices([m(0, 0, { tackles: 4, fouls: 1 }, { passes: 50 })]);
    expect(d.mine.pressing).toBeCloseTo(50 / 5);
    expect(d.mine.directness).toBeNull();
    expect(d.mine.saveEfficiency).toBeNull();
    expect(d.mine.shotClinical).toBeNull();
  });

  it("never yields NaN or Infinity on zeros and legacy rows", () => {
    const rows = [
      m(0, 0, { shots_on_target: 0, possession: 0, passes: 0, crosses: 0, tackles: 0, interceptions: 0, fouls: 0, saves: 0 },
        { shots_on_target: 0, possession: 100, passes: 0, saves: 0 }),
      m(1, 1),
    ];
    const d = computeDerivedIndices(rows);
    expect(allFinite(d)).toBe(true);
    expect(allFinite(computeEdaLab(rows))).toBe(true);
    expect(computeDerivedIndices([])).toMatchObject({ clinicalPrior: null });
  });

  it("ignores disputed matches", () => {
    const d = computeDerivedIndices([m(5, 0, { shots_on_target: 5 }, { shots_on_target: 1 }, { status: "disputed" })]);
    expect(d.clinicalPrior).toBeNull();
  });
});

describe("EDA lab", () => {
  it("clutch & blowout profile", () => {
    const c = computeClutchProfile([m(2, 1), m(0, 1), m(1, 1), m(5, 0), m(0, 4), m(3, 1)]);
    expect(c.oneGoal).toMatchObject({ played: 2, wins: 1, losses: 1, winPct: 50 });
    expect(c.blowoutWins).toBe(1);
    expect(c.blowoutLosses).toBe(1);
    expect(c.avgWinMargin.mine).toBeCloseTo((1 + 5 + 2) / 3);
    expect(c.avgWinMargin.theirs).toBeCloseTo((1 + 4) / 2);
    expect(computeClutchProfile([]).avgWinMargin).toEqual({ mine: null, theirs: null });
  });

  it("leading-stat win % counts strict leads only and reports n", () => {
    const rows = computeLeadingWinPct([
      m(2, 0, { shots: 10 }, { shots: 5 }),
      m(0, 1, { shots: 9 }, { shots: 3 }),
      m(1, 0, { shots: 4 }, { shots: 4 }),
      m(0, 2, { shots: 1 }, { shots: 8 }),
    ]);
    const shots = rows.find((r) => r.stat === "shots")!;
    expect(shots.mine).toMatchObject({ n: 2, wins: 1, winPct: 50 });
    expect(shots.theirs).toMatchObject({ n: 1, wins: 1, winPct: 100 });
    expect(rows.find((r) => r.stat === "tackles")!.mine.winPct).toBeNull();
  });

  it("pearson handles edge cases without NaN", () => {
    expect(pearson([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1);
    expect(pearson([1, 2, 3], [3, 2, 1])).toBeCloseTo(-1);
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull(); // zero variance
    expect(pearson([1, 2], [1, 2])).toBeNull(); // too few
    expect(pearson([], [])).toBeNull();
    expect(correlationLabel(0.8)).toBe("Strong +");
    expect(correlationLabel(0.4)).toBe("Moderate +");
    expect(correlationLabel(0.1)).toBe("Weak");
    expect(correlationLabel(-0.4)).toBe("Moderate −");
    expect(correlationLabel(-0.9)).toBe("Strong −");
    expect(correlationLabel(null)).toBe("N/A");
  });

  it("stat-to-goal-difference correlation", () => {
    const rows = computeStatCorrelations([
      m(3, 0, { shots: 12 }, { shots: 4 }),
      m(1, 1, { shots: 8 }, { shots: 8 }),
      m(0, 2, { shots: 3 }, { shots: 9 }),
      m(2, 1, { shots: 10 }, { shots: 7 }),
    ]);
    const shots = rows.find((r) => r.stat === "shots")!;
    expect(shots.n).toBe(4);
    expect(shots.r!).toBeGreaterThan(0.9);
    expect(shots.strength).toBe("Strong +");
    expect(rows.find((r) => r.stat === "corners")!.r).toBeNull();
  });

  it("groups sessions by date, newest first", () => {
    const s = computeSessions([
      m(2, 1, {}, {}, { playedAt: "2026-01-02" }),
      m(0, 0, {}, {}, { playedAt: "2026-01-02" }),
      m(1, 3, {}, {}, { playedAt: "2026-01-05" }),
      m(1, 1),
    ]);
    expect(s.map((x) => x.date)).toEqual(["2026-01-05", "2026-01-02"]);
    expect(s[1]).toMatchObject({ played: 2, wins: 1, draws: 1, losses: 0, goalsFor: 2, goalsAgainst: 1, goalsPerMatch: 1.5 });
  });

  it("scoreline frequency and margin buckets (pens are draws)", () => {
    const s = computeScorelines([
      m(1, 0), m(1, 0), m(2, 0), m(0, 3), m(5, 0), m(2, 2), m(3, 3, {}, {}, { decidedOnPens: true }), m(2, 1, {}, {}, { decidedOnPens: true }),
    ]);
    expect(s.common[0]).toEqual({ score: "1–0", count: 2 });
    expect(s.margins.map((b) => b.count)).toEqual([2, 1, 1, 1]);
    expect(s.margins[3]).toMatchObject({ mine: 1, theirs: 0 });
  });
});

describe("screenshot dedup cache", () => {
  const ok = { ok: true, extracted: {}, confidence: { yellow: { left: [], right: [] }, warnings: [], hasYellow: false } } as never;

  it("hashes identical bytes identically", () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(sha256Hex(a)).toBe(sha256Hex(new Uint8Array([1, 2, 3])));
    expect(sha256Hex(a)).not.toBe(sha256Hex(new Uint8Array([1, 2, 4])));
    expect(sha256Hex(a)).toHaveLength(64);
  });

  it("returns hits, expires on TTL, and stays bounded", () => {
    clearExtractionCache();
    putCachedExtraction("h1", ok, 1000);
    expect(getCachedExtraction("h1", 1000 + 10)).toBe(ok);
    expect(getCachedExtraction("h1", 1000 + EXTRACT_CACHE_TTL_MS + 1)).toBeNull();
    for (let i = 0; i < EXTRACT_CACHE_MAX + 10; i++) putCachedExtraction(`k${i}`, ok, 5000);
    expect(getCachedExtraction("k0", 5000)).toBeNull();
    expect(getCachedExtraction(`k${EXTRACT_CACHE_MAX + 9}`, 5000)).toBe(ok);
    clearExtractionCache();
  });
});

describe("trusted client IP", () => {
  const h = (o: Record<string, string>) => ({ get: (k: string) => o[k] ?? null });
  it("prefers x-vercel-forwarded-for, then x-real-ip, then x-forwarded-for", () => {
    expect(clientIpFromHeaders(h({ "x-vercel-forwarded-for": "1.1.1.1", "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" }))).toBe("1.1.1.1");
    expect(clientIpFromHeaders(h({ "x-real-ip": "2.2.2.2", "x-forwarded-for": "3.3.3.3" }))).toBe("2.2.2.2");
    expect(clientIpFromHeaders(h({ "x-forwarded-for": "3.3.3.3, 4.4.4.4" }))).toBe("3.3.3.3");
    expect(clientIpFromHeaders(h({}))).toBeNull();
  });
});
