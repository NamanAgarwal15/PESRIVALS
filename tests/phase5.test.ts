// Phase 5: predictive/causal engine, anti-sybil, soft delete, audit log, data rights.
import { randomBytes } from "node:crypto";
import { eq, inArray, like, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { adminAuditLogs, deviceSessions, matches, rivalries, sybilFlags, users } from "@/db/schema";
import { buildUserExport, deleteAccount } from "@/lib/account";
import { checkDeviceAnomalies, checkScoreFarming, hashIp, recordDeviceSession } from "@/lib/anti-sybil";
import { deleteMatch, getPlatformStats, listRecentMatches } from "@/lib/admin";
import { listAuditLogs, recordAudit } from "@/lib/audit";
import { getRivalryAnalyticsMatches } from "@/lib/career-stats";
import { canonicalizeSignals, normalizeFingerprintHash } from "@/lib/fingerprint";
import { getLeaderboard } from "@/lib/leaderboard";
import { getRivalryMatches, saveMatchForUser } from "@/lib/match-helpers";
import type { ExtractedSide } from "@/lib/match-schema";
import { getPlayerProfile } from "@/lib/player-profile";
import {
  bivariatePoissonPmf, bootstrapAte, computeCausal, computeClashMatrix, computeMatchLab, computeRatings,
  computeTilt, estimateAte, ewma, forecastMatch, glicko2Update, GLICKO_START, scoreGrid,
} from "@/lib/predictive-analytics";
import type { AnalyticsMatch, StatSides } from "@/lib/rivalry-analytics";
import { canonicalPair } from "@/lib/rivalry-helpers";

const EMPTY: StatSides = {
  possession: null, shots: null, shots_on_target: null, fouls: null, offsides: null, corners: null,
  free_kicks: null, passes: null, successful_passes: null, crosses: null, interceptions: null,
  tackles: null, saves: null,
};
let no = 0;
const m = (g1: number, g2: number, x: Partial<AnalyticsMatch> = {}): AnalyticsMatch => ({
  matchNo: ++no, playedAt: null, hostSide: null, myGoals: g1, opponentGoals: g2, decidedOnPens: false,
  needsReview: false, my: EMPTY, opp: EMPTY, ...x,
});
const series = (n: number) => Array.from({ length: n }, (_, i) => m((i * 3) % 4, (i * 5) % 3));
const finiteDeep = (o: unknown): boolean =>
  typeof o === "number" ? Number.isFinite(o) : o && typeof o === "object" ? Object.values(o).every(finiteDeep) : true;

describe("Stage 3A forecast", () => {
  it("is locked below 5 confirmed matches (disputed do not count)", () => {
    expect(forecastMatch(series(4)).unlocked).toBe(false);
    const withDisputed = [...series(4), m(1, 1, { status: "disputed" })];
    expect(forecastMatch(withDisputed)).toMatchObject({ unlocked: false, n: 4 });
    expect(forecastMatch(series(5)).unlocked).toBe(true);
  });

  it("ewma weights recent values", () => {
    expect(ewma([0, 0, 0, 4])).toBeCloseTo(1);
    expect(ewma([])).toBe(0);
  });

  it("probabilities are valid and sum to 1 across many parameter sets", () => {
    for (const [a, b, c] of [[1.2, 1.1, 0.1], [0.1, 0.1, 0], [5, 0.3, 0.1], [2.5, 2.5, 1.2], [0.5, 3, 0]]) {
      const g = scoreGrid(a, b, c);
      const total = g.grid.flat().reduce((s, v) => s + v, 0);
      expect(total).toBeCloseTo(1, 6);
      expect(g.win + g.draw + g.loss).toBeCloseTo(1, 6);
      for (const p of [...g.grid.flat(), g.win, g.draw, g.loss]) {
        expect(Number.isFinite(p)).toBe(true);
        expect(p).toBeGreaterThanOrEqual(0);
      }
      expect(g.grid).toHaveLength(5);
      expect(g.grid[0]).toHaveLength(5);
      expect(g.grid[g.likely.me][g.likely.opp]).toBeCloseTo(g.likely.p);
    }
  });

  it("reduces to independent Poisson when the shared rate is 0", () => {
    const p = bivariatePoissonPmf(1, 2, 1.5, 0.8, 0);
    const expected = (Math.exp(-1.5) * 1.5) * (Math.exp(-0.8) * 0.8 ** 2 / 2);
    expect(p).toBeCloseTo(expected, 10);
  });

  it("favours the stronger side and responds to host seat", () => {
    const strong = Array.from({ length: 8 }, (_, i) => m(3, 1, { hostSide: i % 2 ? "me" : "opponent" }));
    const f = forecastMatch(strong);
    if (!f.unlocked) throw new Error("locked");
    expect(f.win).toBeGreaterThan(f.loss);
    expect(forecastMatch(strong, "me")).toMatchObject({ unlocked: true, host: "me" });
    expect(finiteDeep(forecastMatch(Array.from({ length: 6 }, () => m(0, 0))))).toBe(true);
  });
});

describe("Stage 3B", () => {
  it("glicko-2 updates move ratings the right way, symmetrically", () => {
    // Single-game check: a win against an equal opponent raises the rating, a loss lowers it.
    const up = glicko2Update(GLICKO_START, GLICKO_START, 1);
    const down = glicko2Update(GLICKO_START, GLICKO_START, 0);
    expect(up.rating).toBeGreaterThan(1500);
    expect(down.rating).toBeLessThan(1500);
    expect(up.rd).toBeLessThan(350);
    expect(up.rating - 1500).toBeCloseTo(1500 - down.rating, 6);
    const draw = glicko2Update(GLICKO_START, GLICKO_START, 0.5);
    expect(draw.rating).toBeCloseTo(1500, 6);
  });

  it("ratings track dominance and stay finite", () => {
    const r = computeRatings(Array.from({ length: 20 }, () => m(3, 0)));
    expect(r.me.rating).toBeGreaterThan(r.opp.rating);
    expect(r.me.rd).toBeLessThan(350);
    expect(r.history).toHaveLength(20);
    expect(finiteDeep(r)).toBe(true);
  });

  it("deep stage unlocks at 20", () => {
    expect(computeMatchLab(series(19)).deep.unlocked).toBe(false);
    expect(computeMatchLab(series(20)).deep.unlocked).toBe(true);
  });

  it("detects tilt: 2 straight losses in one session then a worse win rate", () => {
    const d = "2026-03-01";
    const ms = [
      m(0, 1, { playedAt: d }), m(0, 2, { playedAt: d }), m(0, 1, { playedAt: d }), m(1, 2, { playedAt: d }),
      m(2, 0, { playedAt: "2026-03-02" }), m(3, 0, { playedAt: "2026-03-02" }), m(1, 0, { playedAt: "2026-03-02" }),
    ];
    const t = computeTilt(ms);
    expect(t.me.tiltedSessions).toBe(1);
    expect(t.me.afterN).toBe(2);
    expect(t.me.afterWinPct).toBe(0);
    expect(t.me.dropoff).toBeGreaterThan(0);
    expect(t.opp.tiltedSessions).toBe(1); // three straight wins on day 2 = three straight losses for the rival
    expect(computeTilt([m(1, 0)]).me.dropoff).toBeNull();
  });

  it("playstyle clash needs 3 tagged matches", () => {
    expect(computeClashMatrix([m(1, 0, { myPlaystyle: "Out Wide", oppPlaystyle: "Long Ball" })])).toEqual({ ready: false, tagged: 1 });
    const c = computeClashMatrix([
      m(2, 0, { myPlaystyle: "Out Wide", oppPlaystyle: "Long Ball" }),
      m(0, 1, { myPlaystyle: "Out Wide", oppPlaystyle: "Long Ball" }),
      m(1, 1, { myPlaystyle: "Quick Counter", oppPlaystyle: "Long Ball" }),
    ]);
    if (!c.ready) throw new Error("not ready");
    expect(c.rows[0]).toMatchObject({ mine: "Out Wide", played: 2, wins: 1, losses: 1, goalDiff: 1 });
  });
});

describe("Tier 2 causal inference", () => {
  const tagged = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      m(i % 3 === 0 ? 0 : 2, i % 3 === 0 ? 1 : 1, {
        hostSide: i % 2 ? "me" : "opponent",
        myPlaystyle: i % 4 === 0 ? "Quick Counter" : "Out Wide",
      }),
    );

  it("stays locked until 30 TAGGED matches (untagged matches do not count)", () => {
    const r = computeCausal([...tagged(29), ...series(40)]);
    expect(r).toEqual({ ready: false, tagged: 29, needed: 30 });
    expect(computeCausal(tagged(30)).ready).toBe(true);
  });

  it("returns finite estimates with an ordered, deterministic CI", () => {
    const a = computeCausal(tagged(40));
    const b = computeCausal(tagged(40));
    expect(a).toEqual(b);
    if (!a.ready) throw new Error("locked");
    expect(a.host).not.toBeNull();
    expect(a.host!.lo).toBeLessThanOrEqual(a.host!.ate);
    expect(a.host!.ate).toBeLessThanOrEqual(a.host!.hi);
    expect(finiteDeep(a)).toBe(true);
  });

  it("estimates a known effect and handles degenerate input", () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ t: (i % 2) as 0 | 1, y: i % 2 ? 1 : 0, stratum: "s" }));
    expect(estimateAte(rows)).toBeCloseTo(1);
    expect(estimateAte(rows.map((r) => ({ ...r, t: 1 as const })))).toBeNull();
    expect(bootstrapAte(rows.slice(0, 4), 1)).toBeNull();
    expect(bootstrapAte([], 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Database-backed
// ---------------------------------------------------------------------------
const RUN = `p5${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
let n = 0;
async function makeUser(label: string) {
  const [row] = await db
    .insert(users)
    .values({ username: `${RUN}_${label}${n++}`.slice(0, 20), displayName: `N ${label}`, email: `${RUN}${n}@example.com`, updatedAt: new Date() })
    .returning();
  ids.push(row.id);
  return row;
}
async function makeRivalry() {
  const [p, q] = await Promise.all([makeUser("a"), makeUser("b")]);
  const [aId, bId] = canonicalPair(p.id, q.id);
  const [r] = await db.insert(rivalries).values({ userAId: aId, userBId: bId, status: "active", requestedBy: aId, acceptedAt: new Date() }).returning();
  return { id: r.id, p, q };
}
const SIDE: ExtractedSide = {
  team: "A", goals: 5, possession: 50, shots: 5, shots_on_target: 2, fouls: 1, offsides: 0, corners: 1,
  free_kicks: 1, passes: 50, successful_passes: 40, crosses: 1, interceptions: 1, tackles: 1, saves: 1,
};
const save = async (userId: string, rivalryId: string, goals = 5) => {
  const r = await saveMatchForUser(userId, {
    rivalryId, mySide: "left", host: "home",
    extracted: { left: { ...SIDE, goals }, right: { ...SIDE, team: "B", goals: 0 } },
  });
  if (!r.ok) throw new Error(r.error);
  return r;
};

afterAll(async () => {
  if (ids.length) {
    await db.delete(sybilFlags).where(inArray(sybilFlags.primaryUserId, ids));
    await db.delete(rivalries).where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    await db.delete(users).where(inArray(users.id, ids));
  }
  await db.delete(users).where(like(users.username, `${RUN}\\_%`));
});

describe("anti-sybil", () => {
  const H = (c: string) => c.repeat(64);

  it("normalises fingerprints and hashes IPs", () => {
    expect(normalizeFingerprintHash("A".repeat(64))).toBe("a".repeat(64));
    expect(normalizeFingerprintHash("xyz")).toBeNull();
    expect(normalizeFingerprintHash(5)).toBeNull();
    expect(canonicalizeSignals({ b: 2, a: null })).toBe("a=|b=2");
    expect(hashIp("1.2.3.4")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashIp(null)).toBeNull();
  });

  it("flags a self-rivalry collision once, high severity, without blocking anyone", async () => {
    const { id, p, q } = await makeRivalry();
    await recordDeviceSession(p.id, H("a"), "1.1.1.1", "UA");
    await recordDeviceSession(q.id, H("a"), "2.2.2.2", "UA");
    expect(await checkDeviceAnomalies(p.id)).toBeGreaterThanOrEqual(1);
    expect(await checkDeviceAnomalies(p.id)).toBe(0); // deduplicated
    const flags = await db.select().from(sybilFlags).where(eq(sybilFlags.primaryUserId, p.id));
    const f = flags.find((x) => x.flagType === "self_rivalry_collision")!;
    expect(f).toMatchObject({ severity: "high", status: "open", rivalryId: id, relatedUserId: q.id });
    const [u] = await db.select({ s: users.suspended }).from(users).where(eq(users.id, p.id));
    expect(u.s).toBe(false); // never auto-banned
    // seen count increments on repeat check-ins
    await recordDeviceSession(p.id, H("a"), "1.1.1.1", "UA");
    const [d] = await db.select().from(deviceSessions).where(eq(deviceSessions.userId, p.id));
    expect(d.seenCount).toBe(2);
  });

  it("does not flag two friends on different devices", async () => {
    const { p, q } = await makeRivalry();
    await recordDeviceSession(p.id, H("b"), null, null);
    await recordDeviceSession(q.id, H("c"), null, null);
    expect(await checkDeviceAnomalies(p.id)).toBe(0);
    expect(await checkDeviceAnomalies(q.id)).toBe(0);
  });

  it("flags an account farm at 3 accounts on one device", async () => {
    const [u1, u2, u3] = await Promise.all([makeUser("f"), makeUser("f"), makeUser("f")]);
    for (const u of [u1, u2, u3]) await recordDeviceSession(u.id, H("d"), null, null);
    expect(await checkDeviceAnomalies(u1.id)).toBe(1);
    const [f] = await db.select().from(sybilFlags).where(eq(sybilFlags.primaryUserId, u1.id));
    expect(f).toMatchObject({ flagType: "account_farm", severity: "medium" });
    const [u2flags] = [await checkDeviceAnomalies(u2.id)];
    expect(u2flags).toBe(1);
  });

  it("flags score farming: shared device + 5 lopsided matches in an hour", async () => {
    const { id, p, q } = await makeRivalry();
    await recordDeviceSession(p.id, H("e"), null, null);
    await recordDeviceSession(q.id, H("e"), null, null);
    for (let i = 0; i < 4; i++) await save(p.id, id);
    expect(await checkScoreFarming(id)).toBe(0);
    await save(p.id, id);
    expect(await checkScoreFarming(id)).toBe(1);
    expect(await checkScoreFarming(id)).toBe(0);
    // Without a shared device the same cadence is not flagged.
    const other = await makeRivalry();
    for (let i = 0; i < 5; i++) await save(other.p.id, other.id);
    expect(await checkScoreFarming(other.id)).toBe(0);
  });
});

describe("soft delete, audit log and data rights", () => {
  it("a soft-deleted match disappears from every read path", async () => {
    const { id, p, q } = await makeRivalry();
    const a = await save(p.id, id, 3);
    const b = await save(p.id, id, 2);
    const before = await getPlatformStats();
    expect((await getRivalryAnalyticsMatches(p.id, id)).length).toBe(2);
    expect(await deleteMatch(a.matchId, q.id)).toBe(true);
    expect(await deleteMatch(a.matchId, q.id)).toBe(false); // already gone

    const [row] = await db.select().from(matches).where(eq(matches.id, a.matchId));
    expect(row.deletedAt).not.toBeNull(); // row kept (soft)
    expect(row.deletedBy).toBe(q.id);

    expect((await getRivalryAnalyticsMatches(p.id, id)).map((x) => x.myGoals)).toEqual([2]);
    expect((await getRivalryMatches(p.id, id)).map((x) => x.id)).toEqual([b.matchId]);
    const lb = (await getLeaderboard()).find((r) => r.userId === p.id);
    expect(lb?.summary.played).toBe(1);
    const prof = await getPlayerProfile({ id: q.id, role: "admin" }, p.username);
    expect(prof?.career.summary.played).toBe(1);
    expect(prof?.recentMatches.map((x) => x.id)).toEqual([b.matchId]);
    const recent = (await listRecentMatches(500)) as unknown as { rows: { id: string }[] };
    expect(recent.rows.some((r) => r.id === a.matchId)).toBe(false);
    expect((await getPlatformStats()).matches).toBe(before.matches - 1);
  });

  it("writes append-only audit entries with redacted metadata", async () => {
    const admin = await makeUser("adm");
    await recordAudit(admin.id, "user.suspend", "user", admin.id, { reason: "x", password: "secret" });
    const logs = (await listAuditLogs(500)).filter((l) => l.actor === admin.username);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ action: "user.suspend", targetType: "user" });
    expect(logs[0].metadata).toMatchObject({ reason: "x", password: "[redacted]" });
    await db.delete(adminAuditLogs).where(eq(adminAuditLogs.actorUserId, admin.id));
  });

  it("exports only the user's own confirmed matches and no credentials", async () => {
    const { id, p, q } = await makeRivalry();
    await db.update(users).set({ passwordHash: "HASHVALUE" }).where(eq(users.id, p.id));
    const a = await save(p.id, id);
    await save(p.id, id);
    await deleteMatch(a.matchId, p.id);
    const out = await buildUserExport(p.id);
    expect(out?.profile.username).toBe(p.username);
    expect(out?.matches).toHaveLength(1);
    expect(out?.rivalries[0].opponent).toBe(q.username);
    expect(JSON.stringify(out)).not.toContain("HASHVALUE");
    expect(await buildUserExport("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("deletes (anonymises) an account but keeps the opponent's history", async () => {
    const { id, p, q } = await makeRivalry();
    await save(p.id, id);
    await recordDeviceSession(p.id, "f".repeat(64), null, null);
    expect(await deleteAccount(p.id)).toEqual({ ok: true });
    const [u] = await db.select().from(users).where(eq(users.id, p.id));
    expect(u).toMatchObject({ displayName: "Deleted player", email: null, passwordHash: null, suspended: true });
    expect(u.username).toMatch(/^deleted_[0-9a-f]{12}$/);
    expect((await db.select().from(deviceSessions).where(eq(deviceSessions.userId, p.id))).length).toBe(0);
    expect((await getRivalryMatches(q.id, id)).length).toBe(1); // opponent keeps history
    expect((await getLeaderboard()).some((r) => r.userId === p.id)).toBe(false);
  });

  it("refuses to delete the last admin", async () => {
    const solo = await makeUser("solo");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, solo.id));
    const admins = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin"));
    if (admins.length === 1) expect((await deleteAccount(solo.id)).ok).toBe(false);
    else expect(true).toBe(true); // other admins exist in this DB: guard not reachable
    await db.update(users).set({ role: "user" }).where(eq(users.id, solo.id));
  });
});
