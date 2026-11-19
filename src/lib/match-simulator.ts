// Zero-LLM pre-match / halftime "what-if" simulator. Pure and deterministic.
// Every input is hard-clamped, so even absurd values (NaN, Infinity, negatives,
// huge numbers) give a valid result: integer percentages that sum to exactly 100.

import { PLAYSTYLES, type Playstyle } from "@/lib/match-context";
import { scoreGrid } from "@/lib/predictive-analytics";

export type SimHost = "me" | "opponent" | null;
export type SimMode = "prematch" | "live";

export type SimBaseline = {
  /** Expected goals for a full 90 minutes, neutral venue. */
  lambdaMe: number;
  lambdaOpp: number;
  /** Shared (correlated) goal rate of the bivariate model. */
  lambda3: number;
};

export type SimInputs = {
  mode: SimMode;
  host: SimHost;
  myPlaystyle: Playstyle | null;
  oppPlaystyle: Playstyle | null;
  minute: number;
  myGoals: number;
  oppGoals: number;
  myPossession: number;
  mySot: number;
  oppSot: number;
};

export const DEFAULT_BASELINE: SimBaseline = { lambdaMe: 1.3, lambdaOpp: 1.3, lambda3: 0.1 };

export const SIM_LIMITS = {
  minute: [0, 90],
  goals: [0, 20],
  possession: [15, 85],
  sot: [0, 30],
  lambda: [0.02, 6],
} as const;

/** Finite integer inside [lo, hi]; anything non-finite falls back to `fallback`. */
export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return Math.min(hi, Math.max(lo, fallback));
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

// Small, deliberately modest tactical multipliers: attack scales the team's own
// expected goals, concede scales what the opponent scores against that style.
const STYLE: Record<Playstyle, { attack: number; concede: number }> = {
  "Possession Game": { attack: 1.0, concede: 0.94 },
  "Quick Counter": { attack: 1.05, concede: 1.0 },
  "Long Ball Counter": { attack: 1.03, concede: 1.0 },
  "Out Wide": { attack: 1.05, concede: 1.05 },
  "Long Ball": { attack: 1.04, concede: 1.04 },
};
const HOST_BOOST = 1.08;
const HOST_PENALTY = 0.94;

export type SimResult = {
  /** Integer percentages that always sum to exactly 100. */
  win: number;
  draw: number;
  loss: number;
  likely: { me: number; opp: number; p: number };
  readout: string;
  clamped: SimInputs;
  remainingFraction: number;
  lambdaMe: number;
  lambdaOpp: number;
};

/** Largest-remainder rounding of three probabilities to integers summing to 100. */
export function toPercents(win: number, draw: number, loss: number): [number, number, number] {
  const raw = [win, draw, loss].map((v) => (Number.isFinite(v) && v > 0 ? v : 0));
  const total = raw[0] + raw[1] + raw[2];
  if (total <= 0) return [34, 33, 33];
  const scaled = raw.map((v) => (v / total) * 100);
  const floors = scaled.map(Math.floor);
  let left = 100 - floors.reduce((s, v) => s + v, 0);
  const order = scaled.map((v, i) => ({ i, r: v - floors[i] })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % 3, left--) floors[order[k].i]++;
  return [floors[0], floors[1], floors[2]];
}

export function clampInputs(raw: Partial<SimInputs>): SimInputs {
  const mode: SimMode = raw.mode === "live" ? "live" : "prematch";
  const style = (v: unknown): Playstyle | null => ((PLAYSTYLES as readonly string[]).includes(v as string) ? (v as Playstyle) : null);
  const live = mode === "live";
  return {
    mode,
    host: raw.host === "me" || raw.host === "opponent" ? raw.host : null,
    myPlaystyle: style(raw.myPlaystyle),
    oppPlaystyle: style(raw.oppPlaystyle),
    minute: live ? clampInt(raw.minute, SIM_LIMITS.minute[0], SIM_LIMITS.minute[1], 45) : 0,
    myGoals: live ? clampInt(raw.myGoals, SIM_LIMITS.goals[0], SIM_LIMITS.goals[1], 0) : 0,
    oppGoals: live ? clampInt(raw.oppGoals, SIM_LIMITS.goals[0], SIM_LIMITS.goals[1], 0) : 0,
    myPossession: live ? clampInt(raw.myPossession, SIM_LIMITS.possession[0], SIM_LIMITS.possession[1], 50) : 50,
    mySot: live ? clampInt(raw.mySot, SIM_LIMITS.sot[0], SIM_LIMITS.sot[1], 0) : 0,
    oppSot: live ? clampInt(raw.oppSot, SIM_LIMITS.sot[0], SIM_LIMITS.sot[1], 0) : 0,
  };
}

export function simulateMatchScenario(baselineRaw: Partial<SimBaseline> | null | undefined, inputsRaw: Partial<SimInputs>): SimResult {
  const c = clampInputs(inputsRaw);
  const [lo, hi] = SIM_LIMITS.lambda;
  const base = {
    lambdaMe: clampNum(baselineRaw?.lambdaMe, lo, hi, DEFAULT_BASELINE.lambdaMe),
    lambdaOpp: clampNum(baselineRaw?.lambdaOpp, lo, hi, DEFAULT_BASELINE.lambdaOpp),
    lambda3: clampNum(baselineRaw?.lambda3, 0, 3, DEFAULT_BASELINE.lambda3),
  };

  const remainingFraction = Math.max(0.05, (90 - c.minute) / 90);
  let lMe = base.lambdaMe * remainingFraction;
  let lOpp = base.lambdaOpp * remainingFraction;
  let l3 = base.lambda3 * remainingFraction;

  // Host seat.
  if (c.host === "me") { lMe *= HOST_BOOST; lOpp *= HOST_PENALTY; }
  if (c.host === "opponent") { lOpp *= HOST_BOOST; lMe *= HOST_PENALTY; }

  // Playstyles.
  const mine = c.myPlaystyle ? STYLE[c.myPlaystyle] : { attack: 1, concede: 1 };
  const theirs = c.oppPlaystyle ? STYLE[c.oppPlaystyle] : { attack: 1, concede: 1 };
  lMe *= mine.attack * theirs.concede;
  lOpp *= theirs.attack * mine.concede;

  // Live pressure: possession and shots-on-target edges.
  if (c.mode === "live") {
    const possEdge = (c.myPossession - 50) / 100; // -0.35 .. 0.35
    lMe *= 1 + 0.4 * possEdge;
    lOpp *= 1 - 0.4 * possEdge;
    const sotEdge = (c.mySot - c.oppSot) / (c.mySot + c.oppSot + 4); // -1 .. 1 (exclusive)
    lMe *= 1 + 0.15 * sotEdge;
    lOpp *= 1 - 0.15 * sotEdge;
  }

  lMe = clampNum(lMe, lo, hi, base.lambdaMe);
  lOpp = clampNum(lOpp, lo, hi, base.lambdaOpp);
  l3 = clampNum(l3, 0, 0.5 * Math.min(lMe, lOpp), 0);

  // Remaining-goals distribution, shifted onto the current score.
  const rem = scoreGrid(lMe, lOpp, l3).exact;
  let w = 0, d = 0, l = 0;
  let likely = { me: c.myGoals, opp: c.oppGoals, p: -1 };
  for (let x = 0; x < rem.length; x++) {
    for (let y = 0; y < rem[x].length; y++) {
      const p = Number.isFinite(rem[x][y]) && rem[x][y] > 0 ? rem[x][y] : 0;
      const fm = c.myGoals + x;
      const fo = c.oppGoals + y;
      if (fm > fo) w += p;
      else if (fm === fo) d += p;
      else l += p;
      if (p > likely.p) likely = { me: fm, opp: fo, p };
    }
  }
  const [win, draw, loss] = toPercents(w, d, l);
  if (!(likely.p >= 0)) likely = { me: c.myGoals, opp: c.oppGoals, p: 0 };

  return {
    win, draw, loss,
    likely: { me: likely.me, opp: likely.opp, p: Number.isFinite(likely.p) ? likely.p : 0 },
    readout: readout(c, { win, draw, loss }, lMe, lOpp),
    clamped: c,
    remainingFraction,
    lambdaMe: lMe,
    lambdaOpp: lOpp,
  };
}

function readout(c: SimInputs, r: { win: number; draw: number; loss: number }, lMe: number, lOpp: number): string {
  const bits: string[] = [];
  if (c.mode === "live") {
    const left = 90 - c.minute;
    bits.push(
      c.myGoals === c.oppGoals
        ? `At ${c.minute}' it is level ${c.myGoals}-${c.oppGoals} with ${left} minutes left.`
        : `At ${c.minute}' you are ${c.myGoals > c.oppGoals ? "ahead" : "behind"} ${c.myGoals}-${c.oppGoals} with ${left} minutes left.`,
    );
    if (c.myPossession >= 60) bits.push("Your possession edge is adding pressure.");
    else if (c.myPossession <= 40) bits.push("Your rival has the ball more, which raises their chances.");
    if (c.mySot - c.oppSot >= 3) bits.push("You are testing the keeper more often.");
    else if (c.oppSot - c.mySot >= 3) bits.push("Your rival is testing your keeper more often.");
  } else {
    bits.push("Before kickoff, based on your history.");
  }
  if (c.host) bits.push(c.host === "me" ? "Hosting gives you a small boost." : "Your rival hosting gives them a small boost.");
  bits.push(`Win ${r.win}%, draw ${r.draw}%, loss ${r.loss}%.`);
  if (r.win >= 60) bits.push("You are the clear favourite: protect the lead and avoid risky passes.");
  else if (r.loss >= 60) bits.push("You are the underdog: look for counters and set pieces.");
  else if (lMe > lOpp) bits.push("Slightly in your favour; keep creating chances.");
  else bits.push("Very close: the next goal will likely decide it.");
  return bits.join(" ");
}
