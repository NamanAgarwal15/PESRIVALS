// Phase 2: display name, ingestor abstraction, confidence flags, disputes.
// Database parts run against the LOCAL TEST database and clean up after.

import { randomBytes } from "node:crypto";
import { eq, inArray, like, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { matches, rivalries, users } from "@/db/schema";
import { assessConfidence } from "@/lib/confidence";
import { SheetImportIngestor, VisionVlmIngestor } from "@/lib/ingestors";
import { getRivalryAnalyticsMatches } from "@/lib/career-stats";
import { getLeaderboard } from "@/lib/leaderboard";
import { disputeMatch, getRivalryMatches, resolveMatchDispute, saveMatchForUser } from "@/lib/match-helpers";
import type { ExtractedSide } from "@/lib/match-schema";
import { parseDisplayName, setDisplayName } from "@/lib/profile";
import { canonicalPair } from "@/lib/rivalry-helpers";

const RUN = `p2${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
let n = 0;

const SIDE: ExtractedSide = {
  team: "FC One", goals: 2, possession: 55, shots: 10, shots_on_target: 5, fouls: 1,
  offsides: 1, corners: 2, free_kicks: 3, passes: 100, successful_passes: 80, crosses: 4,
  interceptions: 5, tackles: 6, saves: 1,
};
const OTHER: ExtractedSide = { ...SIDE, team: "FC Two", goals: 0, possession: 45 };

async function makeUser(label: string) {
  const [row] = await db
    .insert(users)
    .values({ username: `${RUN}_${label}${n++}`.slice(0, 20), displayName: `Name ${label}`, updatedAt: new Date() })
    .returning();
  ids.push(row.id);
  return row;
}

async function makeRivalry() {
  const [p, q] = await Promise.all([makeUser("a"), makeUser("b")]);
  const [userAId, userBId] = canonicalPair(p.id, q.id);
  const [r] = await db
    .insert(rivalries)
    .values({ userAId, userBId, status: "active", requestedBy: userAId, acceptedAt: new Date() })
    .returning();
  return { id: r.id, p, q };
}

afterAll(async () => {
  if (ids.length) {
    await db.delete(rivalries).where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    await db.delete(users).where(inArray(users.id, ids));
  }
  await db.delete(users).where(like(users.username, `${RUN}\\_%`));
});

describe("display name", () => {
  it("trims, and rejects blank or oversized names", async () => {
    expect(parseDisplayName("  Alex   Doe ")).toEqual({ ok: true, value: "Alex Doe" });
    expect(parseDisplayName("   ").ok).toBe(false);
    expect(parseDisplayName("a").ok).toBe(false);
    expect(parseDisplayName("x".repeat(51)).ok).toBe(false);
    expect(parseDisplayName("x".repeat(50)).ok).toBe(true);
    const u = await makeUser("dn");
    expect(await setDisplayName(u.id, " New Name ")).toEqual({ ok: true, value: "New Name" });
    const [row] = await db.select({ d: users.displayName }).from(users).where(eq(users.id, u.id));
    expect(row.d).toBe("New Name");
    expect((await setDisplayName(u.id, "")).ok).toBe(false);
  });

  it("refuses suspended accounts", async () => {
    const u = await makeUser("dns");
    await db.update(users).set({ suspended: true }).where(eq(users.id, u.id));
    expect((await setDisplayName(u.id, "Valid Name")).ok).toBe(false);
  });
});

describe("confidence flags", () => {
  it("is green for a consistent match", () => {
    const r = assessConfidence({ left: SIDE, right: OTHER });
    expect(r.hasYellow).toBe(false);
    expect(r.warnings).toEqual([]);
  });

  it("flags shots on target > shots, passes, possession and missing stats", () => {
    const bad = { ...SIDE, shots: 3, shots_on_target: 5, passes: 10, successful_passes: 20, tackles: null };
    const r = assessConfidence({ left: bad, right: { ...OTHER, possession: 50 } });
    expect(r.hasYellow).toBe(true);
    expect(r.yellow.left).toEqual(expect.arrayContaining(["shots_on_target", "successful_passes", "tackles", "possession"]));
    expect(r.yellow.right).toContain("possession");
  });

  it("flags fields the model reported as uncertain and ignores junk names", () => {
    const r = assessConfidence({ left: SIDE, right: OTHER }, ["left.shots", "right.goals", "nonsense", "left.bogus"]);
    expect(r.yellow.left).toEqual(["shots"]);
    expect(r.yellow.right).toEqual(["goals"]);
  });

  it("persists needsReview on save when yellow, not when green", async () => {
    const { id, p } = await makeRivalry();
    const base = { rivalryId: id, mySide: "left", host: "home", decidedOnPens: false, remark: "" };
    const green = await saveMatchForUser(p.id, { ...base, extracted: { left: SIDE, right: OTHER } });
    const yellow = await saveMatchForUser(p.id, {
      ...base,
      extracted: { left: { ...SIDE, possession: 60 }, right: OTHER },
    });
    const flagged = await saveMatchForUser(p.id, { ...base, needsReview: true, extracted: { left: SIDE, right: OTHER } });
    if (!green.ok || !yellow.ok || !flagged.ok) throw new Error("save failed");
    const rows = await db.select().from(matches).where(eq(matches.rivalryId, id));
    const by = (m: string) => rows.find((r) => r.id === m)!;
    expect(by(green.matchId).needsReview).toBe(true); // unsigned saves are always flagged (see phase7f)
    expect(by(yellow.matchId).needsReview).toBe(true);
    expect(by(flagged.matchId).needsReview).toBe(true);
    expect(by(green.matchId).status).toBe("confirmed");
  });
});

describe("MatchTelemetryIngestor", () => {
  it("declares its source", () => {
    expect(VisionVlmIngestor.source).toBe("screenshot");
    expect(SheetImportIngestor.source).toBe("import");
  });

  it("vision ingestor rejects a non-image through the shared interface", async () => {
    const r = await VisionVlmIngestor.ingest({ bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("invalid_image");
  });

  it("sheet ingestor validates rows and flags gaps", async () => {
    const ok = await SheetImportIngestor.ingest({ left: SIDE, right: { ...OTHER, saves: null } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.confidence.hasYellow).toBe(true);
    const bad = await SheetImportIngestor.ingest({ left: { team: "" }, right: OTHER });
    expect(bad).toMatchObject({ ok: false, code: "invalid_data" });
  });
});

describe("dispute / resolve", () => {
  it("pauses stats while disputed and restores them on resolve", async () => {
    const { id, p, q } = await makeRivalry();
    const save = await saveMatchForUser(p.id, {
      rivalryId: id, extracted: { left: SIDE, right: OTHER }, mySide: "left", host: "home", decidedOnPens: false, remark: "",
    });
    if (!save.ok) throw new Error("save failed");

    expect((await getRivalryAnalyticsMatches(p.id, id)).length).toBe(1);
    const lbWins = async () => (await getLeaderboard()).find((r) => r.userId === p.id)?.summary.wins ?? 0;
    expect(await lbWins()).toBe(1);

    // Outsiders cannot dispute; a rival can; double-dispute is refused.
    const outsider = await makeUser("out");
    expect((await disputeMatch(outsider.id, false, save.matchId)).ok).toBe(false);
    expect((await disputeMatch(q.id, false, save.matchId, "Wrong score")).ok).toBe(true);
    expect((await disputeMatch(q.id, false, save.matchId)).ok).toBe(false);

    const [row] = await db.select().from(matches).where(eq(matches.id, save.matchId));
    expect(row.status).toBe("disputed");
    expect(row.needsReview).toBe(true);

    // Excluded from every aggregation, but still listed with its status.
    expect(await getRivalryAnalyticsMatches(p.id, id)).toHaveLength(0);
    expect(await lbWins()).toBe(0);
    const listed = await getRivalryMatches(q.id, id);
    expect(listed[0].status).toBe("disputed");

    // Outsider cannot resolve; a member can; an admin outside the rivalry can too.
    expect((await resolveMatchDispute(outsider.id, false, save.matchId)).ok).toBe(false);
    expect((await resolveMatchDispute(p.id, false, save.matchId)).ok).toBe(false); // the uploader cannot re-confirm
    expect((await resolveMatchDispute(q.id, false, save.matchId)).ok).toBe(true); // the disputer withdraws
    expect((await resolveMatchDispute(q.id, false, save.matchId)).ok).toBe(false);
    expect(await lbWins()).toBe(1);

    expect((await disputeMatch(outsider.id, true, save.matchId)).ok).toBe(true);
    expect((await resolveMatchDispute(outsider.id, true, save.matchId)).ok).toBe(true);
    const [after] = await db.select().from(matches).where(eq(matches.id, save.matchId));
    expect(after.status).toBe("confirmed");
    expect(after.needsReview).toBe(false);
  });
});
