// Tier 2 & 3 predictive / causal analytics for one rivalry. Pure and
// deterministic (the bootstrap uses a seeded PRNG). Confirmed matches only.
// Every function returns null / an "unlocked: false" shape instead of NaN.

import { type AnalyticsMatch, byMatchNo, onlyConfirmed, outcomeOf } from "@/lib/rivalry-analytics";

export const STAGE_3A_MIN = 5;
export const STAGE_3B_MIN = 20;
export const TIER2_MIN_TAGGED = 30;
export const EWMA_ALPHA = 0.25;
export const BOOTSTRAP_SAMPLES = 200;

const mean = (xs: number[]) => (xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : 0);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const sorted = (ms: AnalyticsMatch[]) => [...onlyConfirmed(ms)].sort(byMatchNo);

export function ewma(values: number[], alpha = EWMA_ALPHA): number {
  if (!values.length) return 0;
  let s = values[0];
  for (let i = 1; i < values.length; i++) s = alpha * values[i] + (1 - alpha) * s;
  return s;
}

// ---------------------------------------------------------------------------
// Stage 3A: EWMA rates + bivariate Poisson
// ---------------------------------------------------------------------------

// The exact pmf is computed for 0..15 goals each side and normalised. The display
// grid pools only 6 or more goals (index 6); the "most likely score" is taken from
// the UNPOOLED table so a pooled cell is never mistaken for a real scoreline.
const GRID_MAX = 15;
export const GRID_SIZE = 7; // 0..5 and "6+"

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/** Bivariate Poisson pmf P(X=x, Y=y) with independent rates l1, l2 and shared rate l3. */
export function bivariatePoissonPmf(x: number, y: number, l1: number, l2: number, l3: number): number {
  let sum = 0;
  const ratio = l3 / (l1 * l2);
  for (let k = 0; k <= Math.min(x, y); k++) {
    sum += (factorial(x) / (factorial(k) * factorial(x - k))) *
      (factorial(y) / (factorial(k) * factorial(y - k))) *
      factorial(k) * Math.pow(ratio, k);
  }
  const p = Math.exp(-(l1 + l2 + l3)) * (Math.pow(l1, x) / factorial(x)) * (Math.pow(l2, y) / factorial(y)) * sum;
  return Number.isFinite(p) && p > 0 ? p : 0;
}

export type ScoreGrid = {
  /** Display grid[me][opp], 7x7: 0..5 goals and index 6 = "6 or more". Sums to 1. */
  grid: number[][];
  /** Exact unpooled probabilities for 0..15 goals each side. */
  exact: number[][];
  win: number;
  draw: number;
  loss: number;
  /** The single most likely EXACT scoreline (never a pooled bucket). */
  likely: { me: number; opp: number; p: number };
};

export function scoreGrid(lambdaMe: number, lambdaOpp: number, lambda3: number): ScoreGrid {
  const l3 = Math.max(0, lambda3);
  const l1 = Math.max(0.01, lambdaMe - l3);
  const l2 = Math.max(0.01, lambdaOpp - l3);
  const full: number[][] = [];
  let total = 0;
  for (let x = 0; x <= GRID_MAX; x++) {
    full.push([]);
    for (let y = 0; y <= GRID_MAX; y++) {
      const p = bivariatePoissonPmf(x, y, l1, l2, l3);
      full[x].push(p);
      total += p;
    }
  }
  const norm = total > 0 ? total : 1;
  let win = 0;
  let draw = 0;
  let loss = 0;
  const grid = Array.from({ length: GRID_SIZE }, () => Array<number>(GRID_SIZE).fill(0));
  const exact: number[][] = [];
  let likely = { me: 0, opp: 0, p: -1 };
  for (let x = 0; x <= GRID_MAX; x++) {
    exact.push([]);
    for (let y = 0; y <= GRID_MAX; y++) {
      const p = full[x][y] / norm;
      exact[x].push(p);
      if (p > likely.p) likely = { me: x, opp: y, p };
      if (x > y) win += p;
      else if (x === y) draw += p;
      else loss += p;
      grid[Math.min(x, GRID_SIZE - 1)][Math.min(y, GRID_SIZE - 1)] += p;
    }
  }
  return { grid, exact, win, draw, loss, likely };
}

export type HostSeat = "me" | "opponent" | null;

export type Forecast =
  | { unlocked: false; n: number; needed: number }
  | ({
      unlocked: true;
      n: number;
      host: HostSeat;
      attack: { me: number; opp: number };
      defense: { me: number; opp: number };
      lambdaMe: number;
      lambdaOpp: number;
      lambda3: number;
    } & ScoreGrid);

const SEAT_K = 3;

/** Seat factor: goals in the given seat vs overall, shrunk with K pseudo-matches. */
function seatFactor(ms: AnalyticsMatch[], seat: "me" | "opponent", pick: (m: AnalyticsMatch) => number): number {
  const overall = mean(ms.map(pick));
  if (overall <= 0) return 1;
  const inSeat = ms.filter((m) => m.hostSide === seat).map(pick);
  const rate = (inSeat.reduce((s, v) => s + v, 0) + SEAT_K * overall) / (inSeat.length + SEAT_K);
  return clamp(rate / overall, 0.5, 2);
}

export function forecastMatch(matches: AnalyticsMatch[], host: HostSeat = null): Forecast {
  const ms = sorted(matches);
  if (ms.length < STAGE_3A_MIN) return { unlocked: false, n: ms.length, needed: STAGE_3A_MIN };
  const mine = ms.map((m) => m.myGoals);
  const theirs = ms.map((m) => m.opponentGoals);
  let lambdaMe = 0.6 * ewma(mine) + 0.4 * mean(mine);
  let lambdaOpp = 0.6 * ewma(theirs) + 0.4 * mean(theirs);
  if (host) {
    lambdaMe *= seatFactor(ms, host, (m) => m.myGoals);
    lambdaOpp *= seatFactor(ms, host, (m) => m.opponentGoals);
  }
  lambdaMe = clamp(lambdaMe, 0.1, 6);
  lambdaOpp = clamp(lambdaOpp, 0.1, 6);

  const mm = mean(mine);
  const mo = mean(theirs);
  const cov = ms.length > 1
    ? mine.reduce((s, v, i) => s + (v - mm) * (theirs[i] - mo), 0) / (ms.length - 1)
    : 0;
  const lambda3 = clamp(Number.isFinite(cov) ? cov : 0, 0, 0.5 * Math.min(lambdaMe, lambdaOpp));

  return {
    unlocked: true,
    n: ms.length,
    host,
    attack: { me: ewma(mine), opp: ewma(theirs) },
    defense: { me: ewma(theirs), opp: ewma(mine) },
    lambdaMe,
    lambdaOpp,
    lambda3,
    ...scoreGrid(lambdaMe, lambdaOpp, lambda3),
  };
}

// ---------------------------------------------------------------------------
// Stage 3B: Glicko-2, tilt, playstyle clash
// ---------------------------------------------------------------------------

export type Glicko = { rating: number; rd: number; vol: number };
const SCALE = 173.7178;
export const GLICKO_START: Glicko = { rating: 1500, rd: 350, vol: 0.06 };

const gFn = (phi: number) => 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
const eFn = (mu: number, muJ: number, phiJ: number) => 1 / (1 + Math.exp(-gFn(phiJ) * (mu - muJ)));

/** One Glicko-2 rating period containing a single game. score: 1 win, 0.5 draw, 0 loss. */
export function glicko2Update(p: Glicko, opp: Glicko, score: number, tau = 0.5): Glicko {
  const mu = (p.rating - 1500) / SCALE;
  const phi = p.rd / SCALE;
  const muJ = (opp.rating - 1500) / SCALE;
  const phiJ = opp.rd / SCALE;
  const gj = gFn(phiJ);
  const e = eFn(mu, muJ, phiJ);
  const v = 1 / (gj * gj * e * (1 - e));
  const delta = v * gj * (score - e);
  const a = Math.log(p.vol * p.vol);
  const f = (x: number) => {
    const ex = Math.exp(x);
    return (ex * (delta * delta - phi * phi - v - ex)) / (2 * Math.pow(phi * phi + v + ex, 2)) - (x - a) / (tau * tau);
  };
  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else {
    let k = 1;
    while (f(a - k * tau) < 0 && k < 50) k++;
    B = a - k * tau;
  }
  let fA = f(A);
  let fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else fA /= 2;
    B = C;
    fB = fC;
  }
  const sigma = Math.exp(A / 2);
  const phiStar = Math.sqrt(phi * phi + sigma * sigma);
  const phiNew = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNew = mu + phiNew * phiNew * gj * (score - e);
  const out = { rating: SCALE * muNew + 1500, rd: SCALE * phiNew, vol: sigma };
  return Number.isFinite(out.rating) && Number.isFinite(out.rd) && Number.isFinite(out.vol) ? out : p;
}

export type Ratings = {
  me: Glicko;
  opp: Glicko;
  /** My rating after each match, oldest first. */
  history: { matchNo: number; me: number; opp: number }[];
};

export function computeRatings(matches: AnalyticsMatch[]): Ratings {
  let me = { ...GLICKO_START };
  let opp = { ...GLICKO_START };
  const history: Ratings["history"] = [];
  for (const m of sorted(matches)) {
    const o = outcomeOf(m);
    const sMe = o === "win" ? 1 : o === "draw" ? 0.5 : 0;
    const nextMe = glicko2Update(me, opp, sMe);
    const nextOpp = glicko2Update(opp, me, 1 - sMe);
    me = nextMe;
    opp = nextOpp;
    history.push({ matchNo: m.matchNo, me: me.rating, opp: opp.rating });
  }
  return { me, opp, history };
}

export type TiltSide = {
  /** Sessions in which this player lost two or more in a row. */
  tiltedSessions: number;
  afterN: number;
  afterWinPct: number | null;
  baselineWinPct: number | null;
  /** baseline - after, in percentage points (positive = they fall off). */
  dropoff: number | null;
};

export function computeTilt(matches: AnalyticsMatch[]): { me: TiltSide; opp: TiltSide } {
  const ms = sorted(matches).filter((m) => m.playedAt);
  const sessions = new Map<string, AnalyticsMatch[]>();
  for (const m of ms) {
    const d = m.playedAt!.slice(0, 10);
    sessions.set(d, [...(sessions.get(d) ?? []), m]);
  }
  const side = (who: "me" | "opp"): TiltSide => {
    let tilted = 0;
    const afterIds = new Set<number>();
    for (const list of sessions.values()) {
      let losses = 0;
      let triggered = false;
      for (const m of list) {
        if (triggered) afterIds.add(m.matchNo);
        const o = outcomeOf(m);
        const lost = who === "me" ? o === "loss" : o === "win";
        losses = lost ? losses + 1 : 0;
        if (losses >= 2 && !triggered) {
          triggered = true;
          tilted++;
        }
      }
    }
    const won = (m: AnalyticsMatch) => (who === "me" ? outcomeOf(m) === "win" : outcomeOf(m) === "loss");
    const after = ms.filter((m) => afterIds.has(m.matchNo));
    const rest = ms.filter((m) => !afterIds.has(m.matchNo));
    const pct = (xs: AnalyticsMatch[]) => (xs.length ? (xs.filter(won).length / xs.length) * 100 : null);
    const a = pct(after);
    const b = pct(rest);
    return {
      tiltedSessions: tilted,
      afterN: after.length,
      afterWinPct: a,
      baselineWinPct: b,
      dropoff: a !== null && b !== null ? b - a : null,
    };
  };
  return { me: side("me"), opp: side("opp") };
}

export type ClashRow = { mine: string; theirs: string; played: number; wins: number; draws: number; losses: number; goalDiff: number };
export type ClashMatrix = { ready: false; tagged: number } | { ready: true; tagged: number; rows: ClashRow[] };

export function computeClashMatrix(matches: AnalyticsMatch[]): ClashMatrix {
  const tagged = sorted(matches).filter((m) => m.myPlaystyle && m.oppPlaystyle);
  if (tagged.length < 3) return { ready: false, tagged: tagged.length };
  const map = new Map<string, ClashRow>();
  for (const m of tagged) {
    const key = `${m.myPlaystyle}|${m.oppPlaystyle}`;
    const row = map.get(key) ?? { mine: m.myPlaystyle!, theirs: m.oppPlaystyle!, played: 0, wins: 0, draws: 0, losses: 0, goalDiff: 0 };
    row.played++;
    const o = outcomeOf(m);
    if (o === "win") row.wins++;
    else if (o === "draw") row.draws++;
    else row.losses++;
    row.goalDiff += m.myGoals - m.opponentGoals;
    map.set(key, row);
  }
  return { ready: true, tagged: tagged.length, rows: [...map.values()].sort((a, b) => b.played - a.played) };
}

// ---------------------------------------------------------------------------
// Tier 2: IPTW / propensity-stratified ATE with deterministic bootstrap CI
// ---------------------------------------------------------------------------

export type CausalRow = { t: 0 | 1; y: number; stratum: string };

/** Hajek IPTW estimate of E[Y|T=1] - E[Y|T=0], propensity = treated share within the stratum. */
export function estimateAte(rows: CausalRow[]): number | null {
  const byStratum = new Map<string, { n: number; t: number }>();
  for (const r of rows) {
    const s = byStratum.get(r.stratum) ?? { n: 0, t: 0 };
    s.n++;
    s.t += r.t;
    byStratum.set(r.stratum, s);
  }
  let w1 = 0, y1 = 0, w0 = 0, y0 = 0;
  for (const r of rows) {
    const s = byStratum.get(r.stratum)!;
    const e = clamp(s.t / s.n, 0.05, 0.95);
    if (r.t === 1) {
      w1 += 1 / e;
      y1 += r.y / e;
    } else {
      w0 += 1 / (1 - e);
      y0 += r.y / (1 - e);
    }
  }
  if (w1 === 0 || w0 === 0) return null;
  const ate = y1 / w1 - y0 / w0;
  return Number.isFinite(ate) ? ate : null;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type AteResult = { ate: number; lo: number; hi: number; nTreated: number; nControl: number } | null;

export function bootstrapAte(rows: CausalRow[], seed: number, samples = BOOTSTRAP_SAMPLES): AteResult {
  const nTreated = rows.filter((r) => r.t === 1).length;
  const nControl = rows.length - nTreated;
  if (nTreated < 3 || nControl < 3) return null;
  const point = estimateAte(rows);
  if (point === null) return null;
  const rand = mulberry32(seed);
  const draws: number[] = [];
  for (let b = 0; b < samples; b++) {
    const resample = Array.from({ length: rows.length }, () => rows[Math.floor(rand() * rows.length)]);
    const est = estimateAte(resample);
    if (est !== null) draws.push(est);
  }
  if (draws.length < samples / 4) return null;
  draws.sort((a, b) => a - b);
  const q = (p: number) => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))];
  return { ate: point, lo: q(0.025), hi: q(0.975), nTreated, nControl };
}

export type CausalResult =
  | { ready: false; tagged: number; needed: number }
  | { ready: true; tagged: number; host: AteResult; playstyle: { style: string; result: AteResult } | null };

export function isTagged(m: AnalyticsMatch): boolean {
  return m.hostSide !== null && Boolean(m.myPlaystyle);
}

export function computeCausal(matches: AnalyticsMatch[]): CausalResult {
  const tagged = sorted(matches).filter(isTagged);
  if (tagged.length < TIER2_MIN_TAGGED) return { ready: false, tagged: tagged.length, needed: TIER2_MIN_TAGGED };
  const win = (m: AnalyticsMatch) => (outcomeOf(m) === "win" ? 1 : 0);

  // Effect of hosting, adjusted for my playstyle choice.
  const hostRows: CausalRow[] = tagged.map((m) => ({ t: m.hostSide === "me" ? 1 : 0, y: win(m), stratum: m.myPlaystyle! }));
  const host = bootstrapAte(hostRows, tagged.length * 7919 + 1);

  // Effect of my most-used playstyle vs others, adjusted for host seat.
  const counts = new Map<string, number>();
  for (const m of tagged) counts.set(m.myPlaystyle!, (counts.get(m.myPlaystyle!) ?? 0) + 1);
  const style = [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  const styleRows: CausalRow[] = tagged.map((m) => ({ t: m.myPlaystyle === style ? 1 : 0, y: win(m), stratum: m.hostSide! }));
  return { ready: true, tagged: tagged.length, host, playstyle: { style, result: bootstrapAte(styleRows, tagged.length * 7919 + 2) } };
}

export function computeMatchLab(matches: AnalyticsMatch[], host: HostSeat = null) {
  const n = sorted(matches).length;
  return {
    n,
    forecast: forecastMatch(matches, host),
    deep:
      n >= STAGE_3B_MIN
        ? { unlocked: true as const, ratings: computeRatings(matches), tilt: computeTilt(matches), clash: computeClashMatrix(matches) }
        : { unlocked: false as const, needed: STAGE_3B_MIN },
    causal: computeCausal(matches),
  };
}
