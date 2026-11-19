// Phase 6A: personal win drivers, unpooled scoreline + 0..6+ grid, audit-log trigger.
import { randomBytes } from "node:crypto";
import { eq, like, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { adminAuditLogs, users } from "@/db/schema";
import { recordAudit } from "@/lib/audit";
import { GRID_SIZE, scoreGrid } from "@/lib/predictive-analytics";
import { type AnalyticsMatch, type StatSides, computeEdaLab, computePlayerWinDrivers } from "@/lib/rivalry-analytics";

const EMPTY: StatSides = {
  possession: null, shots: null, shots_on_target: null, fouls: null, offsides: null, corners: null,
  free_kicks: null, passes: null, successful_passes: null, crosses: null, interceptions: null,
  tackles: null, saves: null,
};
let no = 0;
const m = (g1: number, g2: number, my: Partial<StatSides> = {}, opp: Partial<StatSides> = {}, x: Partial<AnalyticsMatch> = {}): AnalyticsMatch => ({
  matchNo: ++no, playedAt: null, hostSide: null, myGoals: g1, opponentGoals: g2, decidedOnPens: false,
  needsReview: false, my: { ...EMPTY, ...my }, opp: { ...EMPTY, ...opp }, ...x,
});
const finiteDeep = (o: unknown): boolean =>
  typeof o === "number" ? Number.isFinite(o) : o && typeof o === "object" ? Object.values(o).every(finiteDeep) : true;

describe("0..6+ grid and true most-likely scoreline", () => {
  it("is a 7x7 grid that sums to 1", () => {
    expect(GRID_SIZE).toBe(7);
    const g = scoreGrid(4.2, 3.6, 0.4);
    expect(g.grid).toHaveLength(7);
    for (const row of g.grid) expect(row).toHaveLength(7);
    expect(g.grid.flat().reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
    expect(g.exact.flat().reduce((s, v) => s + v, 0)).toBeCloseTo(1, 6);
  });

  it("the headline score is the true unpooled maximum, never a pooled bucket", () => {
    // A high-scoring rivalry: the old 0..4+ grid would have shown "4-4" for a pool.
    const g = scoreGrid(5.5, 4.5, 0.3);
    const flat = g.exact.flatMap((row, x) => row.map((p, y) => ({ x, y, p })));
    const top = flat.reduce((a, b) => (b.p > a.p ? b : a));
    expect(g.likely).toEqual({ me: top.x, opp: top.y, p: top.p });
    expect(g.likely.me).toBeGreaterThanOrEqual(4);
    expect(g.likely.opp).toBeGreaterThanOrEqual(3);
    // The pooled 6+ cell is bigger than any single exact scoreline but is not the headline.
    expect(g.grid[6][6]).toBeGreaterThan(g.likely.p);
    expect(g.likely.me === 6 && g.likely.opp === 6 && g.likely.p === g.grid[6][6]).toBe(false);
  });

  it("matches known cases for low-scoring rivalries", () => {
    const g = scoreGrid(1.1, 0.9, 0);
    expect(g.likely.me).toBeLessThanOrEqual(1);
    expect(g.likely.opp).toBeLessThanOrEqual(1);
    expect(g.win + g.draw + g.loss).toBeCloseTo(1, 6);
    for (const p of g.grid.flat()) expect(p).toBeGreaterThanOrEqual(0);
  });
});

describe("personal win drivers", () => {
  const data = [
    // You win when you have lots of shots; your rival wins with FEWER shots (counter-attacker).
    m(3, 0, { shots: 18, possession: 62 }, { shots: 4, possession: 38 }),
    m(2, 1, { shots: 16, possession: 58 }, { shots: 6, possession: 42 }),
    m(0, 2, { shots: 6, possession: 45 }, { shots: 5, possession: 55 }),
    m(1, 3, { shots: 7, possession: 48 }, { shots: 4, possession: 52 }),
    m(4, 1, { shots: 20, possession: 65 }, { shots: 3, possession: 35 }),
    m(0, 1, { shots: 5, possession: 40 }, { shots: 3, possession: 60 }),
  ];

  it("gives Player A and Player B different, asymmetric results", () => {
    const d = computePlayerWinDrivers(data);
    const a = d.playerA.find((r) => r.stat === "shots")!;
    const b = d.playerB.find((r) => r.stat === "shots")!;
    expect(a.winN).toBe(3);
    expect(a.lossN).toBe(3);
    expect(a.winAvg).toBeCloseTo((18 + 16 + 20) / 3);
    expect(a.lossAvg).toBeCloseTo((6 + 7 + 5) / 3);
    expect(a.lift).toBeGreaterThan(5);
    expect(a.r).toBeGreaterThan(0.8);
    // Player B's wins are Player A's losses, with B's OWN numbers.
    expect(b.winAvg).toBeCloseTo((5 + 4 + 3) / 3);
    expect(b.lossAvg).toBeCloseTo((4 + 6 + 3) / 3);
    expect(b.winAvg).not.toBeCloseTo(a.winAvg!);
    expect(JSON.stringify(d.playerA)).not.toBe(JSON.stringify(d.playerB));
    // Their shot lifts differ in size and in sign: what wins for A is not what wins for B.
    expect(a.lift).toBeGreaterThan(5);
    expect(b.lift!).toBeLessThan(a.lift!);
    expect(Math.sign(b.lift!)).not.toBe(Math.sign(a.lift!));
    // Possession is zero-sum (always adds to 100), so those two rows legitimately mirror; other stats do not.
  });

  it("excludes draws, disputed and soft-deleted matches", () => {
    const withNoise = [
      ...data,
      m(1, 1, { shots: 99 }, { shots: 99 }),
      m(5, 0, { shots: 99 }, { shots: 99 }, { status: "disputed" }),
      m(5, 0, { shots: 99 }, { shots: 99 }, { deletedAt: new Date() } as Partial<AnalyticsMatch>),
    ];
    const d = computePlayerWinDrivers(withNoise);
    expect(d.playerA.find((r) => r.stat === "shots")!.winAvg).toBeCloseTo((18 + 16 + 20) / 3);
  });

  it("returns null (never NaN/Infinity) for empty, legacy and single-class data", () => {
    for (const input of [[], [m(1, 0)], [m(2, 0, { shots: 5 }), m(3, 0, { shots: 5 }), m(1, 0, { shots: 5 })]]) {
      const d = computePlayerWinDrivers(input);
      expect(finiteDeep(d)).toBe(true);
      for (const r of [...d.playerA, ...d.playerB]) {
        if (r.winN === 0 || r.lossN === 0) {
          expect(r.lift).toBeNull();
          expect(r.r).toBeNull();
        }
      }
    }
    // Zero variance: all wins have the same shots -> r is null, not NaN.
    const flat = computePlayerWinDrivers([m(1, 0, { shots: 5 }), m(1, 0, { shots: 5 }), m(0, 1, { shots: 5 }), m(0, 1, { shots: 5 })]);
    expect(flat.playerA.find((r) => r.stat === "shots")!.r).toBeNull();
    expect(finiteDeep(computeEdaLab(data))).toBe(true);
    expect(computeEdaLab(data).drivers.playerA).toHaveLength(7);
  });
});

describe("admin_audit_logs append-only trigger", () => {
  const RUN = `p6${randomBytes(3).toString("hex")}`;
  const ids: string[] = [];
  afterAll(async () => {
    for (const id of ids) await db.delete(users).where(eq(users.id, id));
    await db.delete(users).where(like(users.username, `${RUN}\\_%`));
  });

  async function rejects(run: () => Promise<unknown>) {
    let msg = "";
    try {
      await run();
    } catch (err) {
      const e = err as { message?: string; cause?: { message?: string } };
      msg = `${e.message ?? ""} ${e.cause?.message ?? ""}`;
    }
    return msg;
  }

  it("rejects UPDATE and DELETE at the database level", async () => {
    const [u] = await db.insert(users).values({ username: `${RUN}_adm`, displayName: "A", updatedAt: new Date() }).returning();
    ids.push(u.id);
    await recordAudit(u.id, "user.suspend", "user", u.id, { reason: "t" });
    const [row] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.actorUserId, u.id));
    expect(row).toBeTruthy();

    expect(await rejects(() => db.execute(sql`UPDATE admin_audit_logs SET action = 'tampered' WHERE id = ${row.id}`))).toMatch(/append-only/);
    expect(await rejects(() => db.execute(sql`UPDATE admin_audit_logs SET metadata = '{}'::jsonb WHERE id = ${row.id}`))).toMatch(/append-only/);
    expect(await rejects(() => db.execute(sql`DELETE FROM admin_audit_logs WHERE id = ${row.id}`))).toMatch(/append-only/);
    expect(await rejects(() => db.delete(adminAuditLogs).where(eq(adminAuditLogs.id, row.id)))).toMatch(/append-only/);

    const [still] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.id, row.id));
    expect(still.action).toBe("user.suspend");
  });

  it("still lets a user be deleted (the FK nulls only actor_user_id)", async () => {
    const [u] = await db.insert(users).values({ username: `${RUN}_gone`, displayName: "G", updatedAt: new Date() }).returning();
    await recordAudit(u.id, "user.unsuspend", "user", u.id);
    const [row] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.actorUserId, u.id));
    await db.delete(users).where(eq(users.id, u.id)); // must not throw
    const [after] = await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.id, row.id));
    expect(after.actorUserId).toBeNull();
    expect(after.action).toBe("user.unsuspend");
  });
});
