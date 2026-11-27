// Hardening batch 1a regression tests: [S-1] dispute teeth, [7D-1] war grace window,
// [S-2] ghost-opponent guard, [B-1] signed extraction, [B-2] match-save limits.
// Uses the LOCAL TEST database. No network, no LLM.
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { clanMembers, clanWarPairings, clanWars, clans, matches, rateLimits, rivalries, users } from "@/db/schema";
import { deleteAccount } from "@/lib/account";
import { listDisputedMatches, setSuspended } from "@/lib/admin";
import { WAR_GRACE_HOURS, createClanWar, respondToClanWar, settleWarPairings } from "@/lib/clan-wars";
import { createClan } from "@/lib/clans";
import { SIGNATURE_TTL_MS, screenshotHashOf, signExtraction, verifyExtraction } from "@/lib/extract-signature";
import { loadActiveMatches } from "@/lib/leaderboard";
import {
  MAX_DISPUTE_CYCLES, acknowledgeMatch, disputeMatch, getRivalryMatches, resolveMatchDispute, saveMatchForUser,
} from "@/lib/match-helpers";
import type { ExtractedMatch, ExtractedSide } from "@/lib/match-schema";
import { LIMITS, consumeMatchSaveLimits, shouldPushMatch } from "@/lib/rate-limit";
import { canonicalPair, sendRivalryRequest } from "@/lib/rivalry-helpers";

const RUN = `p7f${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
const rateKeys: string[] = [];
let n = 0;
let tagCounter = 0;
const tagN = () => `${RUN.slice(-3)}${(tagCounter++).toString(36).padStart(3, "0")}`.toUpperCase();

beforeAll(() => {
  process.env.EXTRACT_SIGNING_SECRET ??= "test-only-signing-secret-for-vitest";
});

async function makeUser(label: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db.insert(users).values({ username: `${RUN}_${n++}${label}`.toLowerCase().slice(0, 20), displayName: `N ${label}`, updatedAt: new Date(), ...extra }).returning();
  ids.push(row.id);
  return row;
}
const SIDE: ExtractedSide = {
  team: "A", goals: 2, possession: 50, shots: 5, shots_on_target: 3, fouls: 1, offsides: 0, corners: 1,
  free_kicks: 1, passes: 50, successful_passes: 40, crosses: 1, interceptions: 1, tackles: 1, saves: 1,
};
const extractedOf = (mine: number, theirs: number): ExtractedMatch => ({
  left: { ...SIDE, goals: mine, shots: Math.max(5, mine), shots_on_target: Math.max(3, mine) },
  right: { ...SIDE, team: "B", goals: theirs, shots: Math.max(5, theirs), shots_on_target: Math.max(3, theirs) },
});
async function rivalryBetween(a: { id: string }, b: { id: string }) {
  const [x, y] = canonicalPair(a.id, b.id);
  const [r] = await db.insert(rivalries).values({ userAId: x, userBId: y, status: "active", requestedBy: x, acceptedAt: new Date() }).returning();
  return r;
}
/** Saves a match the way the app does: with a server-issued signature for exactly these numbers. */
async function signedSave(me: { id: string }, rivalryId: string, mine: number, theirs: number) {
  const extracted = extractedOf(mine, theirs);
  const screenshotHash = randomBytes(32).toString("hex");
  const signature = signExtraction({ rivalryId, userId: me.id, screenshotHash, extracted });
  const res = await saveMatchForUser(me.id, { rivalryId, mySide: "left", host: "home", extracted, signature, screenshotHash });
  if (!res.ok) throw new Error(res.error);
  return res.matchId;
}
const unsignedSave = async (me: { id: string }, rivalryId: string, mine: number, theirs: number) => {
  const res = await saveMatchForUser(me.id, { rivalryId, mySide: "left", host: "home", extracted: extractedOf(mine, theirs) });
  if (!res.ok) throw new Error(res.error);
  return res.matchId;
};
const row = async (id: string) => (await db.select().from(matches).where(eq(matches.id, id)))[0];

/** Two clans at war (Bo3, accepted), one rivalry per pairing. */
async function activeWar() {
  const mk = async (label: string) => {
    const leader = await makeUser(`${label}L`);
    const tag = tagN();
    const res = await createClan(leader.id, { name: `${label} ${RUN} ${n++}`.slice(0, 40), tag, description: "x" });
    if (!res.ok) throw new Error(res.error);
    const [clan] = await db.select().from(clans).where(eq(clans.tag, tag));
    const members = [];
    for (let i = 0; i < 2; i++) {
      const u = await makeUser(`${label}m${i}`);
      await db.insert(clanMembers).values({ clanId: clan.id, userId: u.id, role: "member" });
      members.push(u);
    }
    return { clan, leader, tag, players: [leader, ...members] };
  };
  const A = await mk("fa");
  const B = await mk("fb");
  const created = await createClanWar(A.leader.id, {
    defenderTag: B.tag, seriesSize: 3,
    pairings: A.players.map((p, i) => ({ mine: p.username, theirs: B.players[i].username })),
  });
  if (!created.ok) throw new Error(created.error);
  const rivals = [];
  for (let i = 0; i < 3; i++) rivals.push(await rivalryBetween(A.players[i], B.players[i]));
  const accepted = await respondToClanWar(B.leader.id, created.warId, "accept");
  if (!accepted.ok) throw new Error(accepted.error);
  return { A, B, rivals, warId: created.warId };
}
const pairings = (warId: string) => db.select().from(clanWarPairings).where(eq(clanWarPairings.warId, warId)).orderBy(clanWarPairings.slotNumber);
const ageWar = async (warId: string, matchIds: string[], hours: number) => {
  await db.update(clanWars).set({ startedAt: new Date(Date.now() - (hours + 1) * 3_600_000) }).where(eq(clanWars.id, warId));
  for (const id of matchIds) await db.update(matches).set({ createdAt: new Date(Date.now() - hours * 3_600_000) }).where(eq(matches.id, id));
};

afterAll(async () => {
  if (ids.length) {
    await db.delete(rivalries).where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    await db.delete(rateLimits).where(sql`split_part(${rateLimits.key}, ':', 2) IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    await db.delete(users).where(inArray(users.id, ids));
  }
  if (rateKeys.length) await db.delete(rateLimits).where(inArray(rateLimits.key, rateKeys));
}, 120_000);

// ---------------------------------------------------------------------------
describe("[S-1] disputes have teeth", () => {
  it("lets only the opponent dispute, and only the disputer (or an admin) clear it", async () => {
    const [a, b, admin] = await Promise.all([makeUser("s1a"), makeUser("s1b"), makeUser("s1adm", { role: "admin" })]);
    const r = await rivalryBetween(a, b);
    const m = await unsignedSave(a, r.id, 2, 0);

    // The uploader cannot dispute their own match.
    expect(await disputeMatch(a.id, false, m)).toMatchObject({ ok: false });
    expect((await row(m)).status).toBe("confirmed");

    expect((await disputeMatch(b.id, false, m, "wrong score")).ok).toBe(true);
    expect(await row(m)).toMatchObject({ status: "disputed", disputedBy: b.id, disputeCount: 1, adminReview: false });

    // The uploader cannot re-confirm their own disputed match, no matter how often they try.
    for (let i = 0; i < 3; i++) expect(await resolveMatchDispute(a.id, false, m)).toMatchObject({ ok: false });
    expect((await row(m)).status).toBe("disputed");

    // The disputer can withdraw it.
    expect((await resolveMatchDispute(b.id, false, m)).ok).toBe(true);
    expect(await row(m)).toMatchObject({ status: "confirmed", acknowledgedBy: b.id });
    expect((await row(m)).acknowledgedAt).not.toBeNull();

    // An admin can rule on any dispute.
    expect((await disputeMatch(b.id, false, m)).ok).toBe(true);
    expect((await resolveMatchDispute(admin.id, true, m)).ok).toBe(true);
    expect((await row(m)).status).toBe("confirmed");
  });

  it("freezes a match after repeated dispute cycles: admin-only, and it shows on the admin queue", async () => {
    const [a, b, admin] = await Promise.all([makeUser("s1c"), makeUser("s1d"), makeUser("s1adm2", { role: "admin" })]);
    const r = await rivalryBetween(a, b);
    const m = await unsignedSave(a, r.id, 3, 1);
    for (let i = 1; i < MAX_DISPUTE_CYCLES; i++) {
      expect((await disputeMatch(b.id, false, m)).ok).toBe(true);
      expect((await row(m)).adminReview).toBe(false);
      expect((await resolveMatchDispute(b.id, false, m)).ok).toBe(true);
    }
    expect((await disputeMatch(b.id, false, m)).ok).toBe(true); // the last allowed dispute
    expect(await row(m)).toMatchObject({ status: "disputed", disputeCount: MAX_DISPUTE_CYCLES, adminReview: true });

    // Nobody but an admin can clear it now, not even the disputer.
    expect(await resolveMatchDispute(b.id, false, m)).toMatchObject({ ok: false });
    expect(await resolveMatchDispute(a.id, false, m)).toMatchObject({ ok: false });
    const mine = await getRivalryMatches(b.id, r.id);
    expect(mine[0]).toMatchObject({ status: "disputed", frozen: true });

    const queue = await listDisputedMatches(200);
    expect(queue.find((q) => q.id === m)).toMatchObject({ adminReview: true, disputeCount: MAX_DISPUTE_CYCLES });

    expect((await resolveMatchDispute(admin.id, true, m)).ok).toBe(true);
    expect(await row(m)).toMatchObject({ status: "confirmed", adminReview: false });
  });

  it("wires the admin queue with audited confirm and void actions", () => {
    const page = readFileSync("src/app/admin/page.tsx", "utf8");
    expect(page).toContain("Disputed matches");
    expect(page).toContain("adminResolveDisputeAction");
    expect(page).toContain("adminDeleteMatchAction");
    const actions = readFileSync("src/lib/admin-actions.ts", "utf8");
    expect(actions).toMatch(/adminResolveDisputeAction[\s\S]*?requireAdmin\(\)[\s\S]*?match\.resolve_dispute/);
    // The audit log is only ever appended to.
    expect(readFileSync("src/lib/match-helpers.ts", "utf8")).not.toMatch(/admin_audit_logs|adminAuditLogs/);
  });
});

// ---------------------------------------------------------------------------
describe("[7D-1] clan-war settlement waits for acknowledgement or the grace window", () => {
  it("does not settle a fresh verified match, then settles on opponent acknowledgement", async () => {
    const w = await activeWar();
    const m = await signedSave(w.A.players[0], w.rivals[0].id, 2, 0);
    expect((await pairings(w.warId))[0].status).toBe("pending"); // saved, but the opponent has not agreed

    // The uploader cannot acknowledge their own match.
    expect(await acknowledgeMatch(w.A.players[0].id, m)).toMatchObject({ ok: false });
    expect((await pairings(w.warId))[0].status).toBe("pending");

    const ack = await acknowledgeMatch(w.B.players[0].id, m);
    expect(ack.ok).toBe(true);
    expect((await pairings(w.warId))[0]).toMatchObject({ status: "completed", matchId: m });
  });

  it("settles after the grace window if nobody disputed, but not if it was disputed", async () => {
    const w = await activeWar();
    const quiet = await signedSave(w.A.players[1], w.rivals[1].id, 1, 0);
    const contested = await signedSave(w.A.players[2], w.rivals[2].id, 3, 0);
    expect((await disputeMatch(w.B.players[2].id, false, contested)).ok).toBe(true);
    await ageWar(w.warId, [quiet, contested], WAR_GRACE_HOURS + 1);
    await settleWarPairings(w.warId);
    const ps = await pairings(w.warId);
    expect(ps[1]).toMatchObject({ status: "completed", matchId: quiet });
    expect(ps[2].status).toBe("pending"); // disputed matches never settle
    expect(WAR_GRACE_HOURS).toBe(24);
  });

  it("never settles from an unverified (manual) match, even if acknowledged or old", async () => {
    const w = await activeWar();
    const m = await unsignedSave(w.A.players[0], w.rivals[0].id, 4, 0);
    expect(await row(m)).toMatchObject({ verified: false, needsReview: true });
    await acknowledgeMatch(w.B.players[0].id, m);
    await ageWar(w.warId, [m], WAR_GRACE_HOURS + 1);
    await settleWarPairings(w.warId);
    expect((await pairings(w.warId))[0].status).toBe("pending");
  });

  it("tells the opponent on save and shows the acknowledgement state", () => {
    const actions = readFileSync("src/lib/match-actions.ts", "utf8");
    expect(actions).toMatch(/sendPushToUser\(opponentId[\s\S]*?24 hours/);
    expect(actions).toContain("acknowledgeMatchAction");
    expect(readFileSync("src/components/matches/match-list.tsx", "utf8")).toContain("Looks right");
    const sql = readFileSync("src/lib/clan-wars.ts", "utf8");
    expect(sql).toContain("m.verified = true");
    expect(sql).toMatch(/m\.acknowledged_at IS NOT NULL OR m\.created_at <= now\(\)/);
  });
});

// ---------------------------------------------------------------------------
describe("[S-2] ghost-opponent farming guard", () => {
  it("archives active rivalries and declines pending challenges when a player is suspended, and restores on unsuspend", async () => {
    const [a, b, c] = await Promise.all([makeUser("g1a"), makeUser("g1b"), makeUser("g1c")]);
    const active = await rivalryBetween(a, b);
    const [x, y] = canonicalPair(a.id, c.id);
    const [pending] = await db.insert(rivalries).values({ userAId: x, userBId: y, status: "pending", requestedBy: c.id }).returning();

    await setSuspended(a.id, true);
    const after = (id: string) => db.select().from(rivalries).where(eq(rivalries.id, id)).then((r) => r[0]);
    expect(await after(active.id)).toMatchObject({ status: "archived", archivedBy: a.id });
    expect((await after(pending.id)).status).toBe("declined");

    // Nobody can save a match against the ghost, and nothing can be read through the rivalry.
    expect(await saveMatchForUser(b.id, { rivalryId: active.id, mySide: "left", host: "home", extracted: extractedOf(5, 0) })).toEqual({ ok: false, error: "Rivalry not found" });
    expect(await getRivalryMatches(b.id, active.id)).toEqual([]); // no matches yet; history stays readable, writes do not
    expect(await sendRivalryRequest(b.id, a.username)).toMatchObject({ ok: false });

    await setSuspended(a.id, false);
    expect((await after(active.id)).status).toBe("active");
    expect((await after(pending.id)).status).toBe("declined"); // declined challenges stay declined
  });

  it("does not restore a rivalry when the other player is still suspended", async () => {
    const [a, b] = await Promise.all([makeUser("g2a"), makeUser("g2b")]);
    const r = await rivalryBetween(a, b);
    await setSuspended(a.id, true);
    await setSuspended(b.id, true);
    await setSuspended(a.id, false);
    expect((await db.select().from(rivalries).where(eq(rivalries.id, r.id)))[0].status).toBe("archived");
  });

  it("archives rivalries on account deletion", async () => {
    const [a, b] = await Promise.all([makeUser("g3a"), makeUser("g3b")]);
    const r = await rivalryBetween(a, b);
    expect(await deleteAccount(a.id)).toEqual({ ok: true });
    expect((await db.select().from(rivalries).where(eq(rivalries.id, r.id)))[0].status).toBe("archived");
    expect(await saveMatchForUser(b.id, { rivalryId: r.id, mySide: "left", host: "home", extracted: extractedOf(9, 0) })).toMatchObject({ ok: false });
  });

  it("refuses saves and excludes stats even if the rivalry was left active (defence in depth)", async () => {
    const [a, b] = await Promise.all([makeUser("g4a"), makeUser("g4b")]);
    const r = await rivalryBetween(a, b);
    const m = await unsignedSave(a, r.id, 2, 0);
    expect((await loadActiveMatches()).some((x) => x.id === m)).toBe(true);
    await db.update(users).set({ suspended: true }).where(eq(users.id, b.id)); // bypasses the admin path on purpose
    expect(await saveMatchForUser(a.id, { rivalryId: r.id, mySide: "left", host: "home", extracted: extractedOf(7, 0) })).toEqual({ ok: false, error: "Rivalry not found" });
    expect((await loadActiveMatches()).some((x) => x.id === m)).toBe(false);
  });

  it("excludes a suspended opponent from clan-war settlement", async () => {
    const w = await activeWar();
    const m = await signedSave(w.A.players[0], w.rivals[0].id, 2, 0);
    await acknowledgeMatch(w.B.players[0].id, m); // would settle right away...
    expect((await pairings(w.warId))[0].status).toBe("completed");
    const w2 = await activeWar();
    const m2 = await signedSave(w2.A.players[0], w2.rivals[0].id, 2, 0);
    await db.update(users).set({ suspended: true }).where(eq(users.id, w2.B.players[0].id));
    await db.update(matches).set({ acknowledgedAt: new Date() }).where(eq(matches.id, m2));
    await settleWarPairings(w2.warId);
    expect((await pairings(w2.warId))[0].status).toBe("pending"); // ...but not against a suspended opponent
  });
});

// ---------------------------------------------------------------------------
describe("[B-1] signed extraction payload", () => {
  const rivalryId = randomUUID();
  const userId = randomUUID();
  const extracted = extractedOf(2, 1);
  const hash = screenshotHashOf(new Uint8Array([1, 2, 3]));
  const base = { rivalryId, userId, screenshotHash: hash, extracted };

  it("verifies only the exact numbers, user, rivalry and screenshot, and only until it expires", () => {
    const sig = signExtraction(base);
    expect(sig).toBeTruthy();
    expect(verifyExtraction(sig, base)).toBe(true);
    expect(verifyExtraction(sig, { ...base, extracted: extractedOf(5, 1) })).toBe(false); // edited score
    expect(verifyExtraction(sig, { ...base, extracted: { ...extracted, left: { ...extracted.left, shots: 6 } } })).toBe(false); // edited stat
    expect(verifyExtraction(sig, { ...base, userId: randomUUID() })).toBe(false); // someone else's token
    expect(verifyExtraction(sig, { ...base, rivalryId: randomUUID() })).toBe(false); // another rivalry
    expect(verifyExtraction(sig, { ...base, screenshotHash: screenshotHashOf(new Uint8Array([9])) })).toBe(false); // another image
    expect(verifyExtraction(sig, { ...base, now: Date.now() + SIGNATURE_TTL_MS + 5_000 })).toBe(false); // expired
    for (const bad of [null, undefined, "", "nope", "1.2", `${Date.now() + 60_000}.${"0".repeat(64)}`, 42]) {
      expect(verifyExtraction(bad, base)).toBe(false);
    }
    // Extending the expiry by hand breaks the MAC.
    const [exp, mac] = String(sig).split(".");
    expect(verifyExtraction(`${Number(exp) + 3_600_000}.${mac}`, base)).toBe(false);
  });

  it("saves a signed screenshot match as verified, and anything else as manual / needs review", async () => {
    const [a, b] = await Promise.all([makeUser("b1a"), makeUser("b1b")]);
    const r = await rivalryBetween(a, b);

    const signedId = await signedSave(a, r.id, 2, 1);
    expect(await row(signedId)).toMatchObject({ verified: true, source: "screenshot" });
    expect((await row(signedId)).screenshotHash).toMatch(/^[0-9a-f]{64}$/);

    const manualId = await unsignedSave(a, r.id, 2, 1);
    expect(await row(manualId)).toMatchObject({ verified: false, needsReview: true, screenshotHash: null });

    // A valid signature for DIFFERENT numbers (a hand-edited score) is saved as manual, not verified.
    const honest = extractedOf(1, 1);
    const screenshotHash = randomBytes(32).toString("hex");
    const signature = signExtraction({ rivalryId: r.id, userId: a.id, screenshotHash, extracted: honest });
    const edited = await saveMatchForUser(a.id, { rivalryId: r.id, mySide: "left", host: "home", extracted: extractedOf(9, 0), signature, screenshotHash });
    if (!edited.ok) throw new Error(edited.error);
    expect(await row(edited.matchId)).toMatchObject({ verified: false, needsReview: true, screenshotHash: null });

    // The opponent cannot reuse my signature.
    const stolen = await saveMatchForUser(b.id, { rivalryId: r.id, mySide: "left", host: "home", extracted: honest, signature, screenshotHash });
    if (!stolen.ok) throw new Error(stolen.error);
    expect((await row(stolen.matchId)).verified).toBe(false);
  });

  it("does not let the same screenshot become two matches in one rivalry", async () => {
    const [a, b] = await Promise.all([makeUser("b1c"), makeUser("b1d")]);
    const r = await rivalryBetween(a, b);
    const extractedA = extractedOf(3, 0);
    const screenshotHash = randomBytes(32).toString("hex");
    const signature = signExtraction({ rivalryId: r.id, userId: a.id, screenshotHash, extracted: extractedA });
    const input = { rivalryId: r.id, mySide: "left" as const, host: "home" as const, extracted: extractedA, signature, screenshotHash };
    expect((await saveMatchForUser(a.id, input)).ok).toBe(true);
    expect(await saveMatchForUser(a.id, input)).toEqual({ ok: false, error: "That screenshot has already been saved as a match." });
  });

  it("is issued by the extract route and carried by the upload panel", () => {
    const route = readFileSync("src/app/api/rivalry/[id]/extract/route.ts", "utf8");
    expect(route).toMatch(/signExtraction\(\{ rivalryId: id, userId: who\.userId/);
    expect(route).toContain("signature, screenshotHash");
    const panel = readFileSync("src/components/matches/upload-match-panel.tsx", "utf8");
    expect(panel).toContain("signature: proof.signature");
    expect(panel).toContain("screenshotHash: proof.screenshotHash");
    // The signing key is derived, never the raw session secret.
    expect(readFileSync("src/lib/extract-signature.ts", "utf8")).toContain("pesrivals:extract-signature:v1");
  });
});

// ---------------------------------------------------------------------------
describe("[B-2] match-save rate limits", () => {
  it("allows 15 saves per user per hour, then refuses", async () => {
    const userId = randomUUID();
    rateKeys.push(`match-save:${userId}`);
    for (let i = 0; i < LIMITS.matchSave.max; i++) expect((await consumeMatchSaveLimits(userId, null)).ok).toBe(true);
    expect(await consumeMatchSaveLimits(userId, null)).toMatchObject({ ok: false });
    expect(LIMITS.matchSave).toEqual({ max: 15, windowMinutes: 60 });
  });

  it("allows 25 saves per rivalry per day across users, then refuses", async () => {
    const rivalryId = randomUUID();
    rateKeys.push(`match-save-rv-day:${rivalryId}:${new Date().toISOString().slice(0, 10)}`);
    for (let i = 0; i < LIMITS.matchSaveRivalryDay.max; i++) {
      const u = randomUUID();
      rateKeys.push(`match-save:${u}`);
      expect((await consumeMatchSaveLimits(u, rivalryId)).ok).toBe(true);
    }
    const u = randomUUID();
    rateKeys.push(`match-save:${u}`);
    expect(await consumeMatchSaveLimits(u, rivalryId)).toMatchObject({ ok: false });
    expect(LIMITS.matchSaveRivalryDay).toEqual({ max: 25, windowMinutes: 1440 });
  });

  it("coalesces rapid pushes to one per rivalry per 10 minutes", async () => {
    const rivalryId = randomUUID();
    rateKeys.push(`match-push:${rivalryId}`);
    expect(await shouldPushMatch(rivalryId)).toBe(true);
    expect(await shouldPushMatch(rivalryId)).toBe(false);
    expect(await shouldPushMatch(rivalryId)).toBe(false);
  });

  it("is enforced by the save action before anything is written", () => {
    const actions = readFileSync("src/lib/match-actions.ts", "utf8");
    const limitAt = actions.indexOf("consumeMatchSaveLimits(session.user.id");
    const saveAt = actions.indexOf("saveMatchForUser(session.user.id");
    expect(limitAt).toBeGreaterThan(0);
    expect(limitAt).toBeLessThan(saveAt);
    expect(actions).toContain("shouldPushMatch");
  });
});

describe("migration and docs", () => {
  it("adds only additive columns and an enum value", () => {
    const sqlText = readFileSync("drizzle/0014_premium_callisto.sql", "utf8");
    expect(sqlText).not.toMatch(/DROP |TRUNCATE|DELETE FROM|ALTER COLUMN/i);
    expect(sqlText).toContain("ADD VALUE 'archived'");
  });
  it("documents the five controls", () => {
    const docs = readFileSync("docs/ASPIRED_SYSTEM_ARCHITECTURE.md", "utf8");
    for (const key of ["S-1", "7D-1", "S-2", "B-1", "B-2"]) expect(docs).toContain(key);
  });
});
