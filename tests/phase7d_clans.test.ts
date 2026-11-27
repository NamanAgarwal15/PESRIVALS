// Phase 7D: clans, private clan chat, two-tier clan wars with confirmed-match settlement.
// Uses the LOCAL TEST database. No network, no LLM.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import {
  clanChatMessages, clanInvites, clanMembers, clanWarPairings, clanWars, clans, matches, rateLimits, rivalries, sybilFlags, users,
} from "@/db/schema";
import { deleteAccount } from "@/lib/account";
import { refreshSessionUser } from "@/lib/auth-helpers";
import {
  createClanWar, getClanWars, respondToClanWar, settleClanWarsForMatch, settleWarPairings, winsNeeded,
} from "@/lib/clan-wars";
import {
  CLAN_MAX_MEMBERS, createClan, disbandClan, getClanHub, getClanMessages, getMembership, inviteToClan, kickMember,
  leaveClan, listClans, listMyInvites, respondToInvite, sendClanMessage, setMemberRole, transferLeadership,
} from "@/lib/clans";
import { setMessageBlock } from "@/lib/dm-chat";
import { disputeMatch, resolveMatchDispute, saveMatchForUser } from "@/lib/match-helpers";
import type { ExtractedSide } from "@/lib/match-schema";
import { LIMITS } from "@/lib/rate-limit";
import { canonicalPair } from "@/lib/rivalry-helpers";

const RUN = `p7d${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
let n = 0;
let tagCounter = 0;
const tagN = () => `${RUN.slice(-3)}${(tagCounter++).toString(36).padStart(3, "0")}`.toUpperCase();

async function makeUser(label: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db.insert(users).values({ username: `${RUN}_${n++}${label}`.toLowerCase().slice(0, 20), displayName: `N ${label}`, updatedAt: new Date(), ...extra }).returning();
  ids.push(row.id);
  return row;
}
const uniq = (label: string) => `${label} ${RUN} ${n++}`.slice(0, 40);

/** A clan with a leader plus `extra` plain members already on the roster. */
async function makeClan(label: string, extra = 0) {
  const leader = await makeUser(`${label}L`);
  const tag = tagN();
  const res = await createClan(leader.id, { name: uniq(label), tag, description: "good players" });
  if (!res.ok) throw new Error(`clan setup: ${res.error}`);
  const [clan] = await db.select().from(clans).where(eq(clans.tag, tag));
  const members = [];
  for (let i = 0; i < extra; i++) {
    const u = await makeUser(`${label}m${i}`);
    await db.insert(clanMembers).values({ clanId: clan.id, userId: u.id, role: "member" });
    members.push(u);
  }
  return { clan, leader, members, tag };
}

const SIDE: ExtractedSide = {
  team: "A", goals: 2, possession: 50, shots: 5, shots_on_target: 3, fouls: 1, offsides: 0, corners: 1,
  free_kicks: 1, passes: 50, successful_passes: 40, crosses: 1, interceptions: 1, tackles: 1, saves: 1,
};
async function rivalryBetween(a: { id: string }, b: { id: string }) {
  const [x, y] = canonicalPair(a.id, b.id);
  const [r] = await db.insert(rivalries).values({ userAId: x, userBId: y, status: "active", requestedBy: x, acceptedAt: new Date() }).returning();
  return r;
}
/** `me` saves a match in which they score `mine` and the opponent `theirs`. */
async function playMatch(me: { id: string }, rivalryId: string, mine: number, theirs: number) {
  const res = await saveMatchForUser(me.id, {
    rivalryId, mySide: "left", host: "home",
    extracted: { left: { ...SIDE, goals: mine, shots: Math.max(5, mine), shots_on_target: Math.max(3, mine) }, right: { ...SIDE, team: "B", goals: theirs, shots: Math.max(5, theirs), shots_on_target: Math.max(3, theirs) } },
  });
  if (!res.ok) throw new Error(res.error);
  // Model a screenshot-verified match the opponent has acknowledged (war slots need both), then settle.
  await db.update(matches).set({ verified: true, acknowledgedAt: new Date() }).where(eq(matches.id, res.matchId));
  await settleClanWarsForMatch(res.matchId);
  return res.matchId;
}

/** Two clans at war (Bo3), already accepted, with one rivalry per pairing. */
async function activeWar(seriesSize: 3 | 5 = 3) {
  const A = await makeClan("wa", seriesSize);
  const B = await makeClan("wb", seriesSize);
  const aPlayers = [A.leader, ...A.members].slice(0, seriesSize);
  const bPlayers = [B.leader, ...B.members].slice(0, seriesSize);
  const created = await createClanWar(A.leader.id, {
    defenderTag: B.tag, seriesSize,
    pairings: aPlayers.map((p, i) => ({ mine: p.username, theirs: bPlayers[i].username })),
  });
  if (!created.ok) throw new Error(created.error);
  const rivals = [];
  for (let i = 0; i < seriesSize; i++) rivals.push(await rivalryBetween(aPlayers[i], bPlayers[i]));
  return { A, B, aPlayers, bPlayers, rivals, warId: created.warId };
}
const accept = async (w: { B: { leader: { id: string } }; warId: string }) => {
  const r = await respondToClanWar(w.B.leader.id, w.warId, "accept");
  if (!r.ok) throw new Error(r.error);
};
const war = async (id: string) => (await db.select().from(clanWars).where(eq(clanWars.id, id)))[0];
const pairings = (id: string) => db.select().from(clanWarPairings).where(eq(clanWarPairings.warId, id)).orderBy(clanWarPairings.slotNumber);

afterAll(async () => {
  if (ids.length) {
    await db.delete(rivalries).where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    // One statement for every test user's buckets (keys look like "name:<userId>" or "name-day:<userId>:<date>").
    await db.delete(rateLimits).where(sql`split_part(${rateLimits.key}, ':', 2) IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    await db.delete(users).where(inArray(users.id, ids)); // cascades to clans, members, invites, chat, wars
  }
}, 120_000);

describe("clan creation and text hygiene", () => {
  it("creates a clan with the creator as leader, and enforces unique names and tags", async () => {
    const u = await makeUser("c1");
    const tag = tagN();
    const name = uniq("Alpha Squad");
    expect(await createClan(u.id, { name, tag: tag.toLowerCase(), description: "We win." })).toEqual({ ok: true, tag });
    expect(await getMembership(u.id)).toMatchObject({ tag, role: "leader" });
    const [clan] = await db.select().from(clans).where(eq(clans.tag, tag));
    expect(clan.leaderId).toBe(u.id);

    const v = await makeUser("c2");
    expect(await createClan(v.id, { name: uniq("Other"), tag })).toMatchObject({ ok: false, code: "conflict" });
    expect(await createClan(v.id, { name: name.toUpperCase(), tag: tagN() })).toMatchObject({ ok: false, code: "conflict" }); // case-insensitive name
    expect(await createClan(u.id, { name: uniq("Second"), tag: tagN() })).toMatchObject({ ok: false, code: "conflict" }); // already in a clan
    expect((await listClans(tag)).some((c) => c.tag === tag && c.members === 1)).toBe(true);
  });

  it("runs names, tags and descriptions through the deterministic filter and validates shape", async () => {
    const u = await makeUser("f1");
    for (const bad of [
      { name: "fuck clan", tag: "ABC" }, { name: uniq("ok"), tag: "SHIT" }, { name: uniq("ok"), tag: tagN(), description: "join http://evil.com" },
      { name: "x", tag: "AB" }, { name: uniq("ok"), tag: "A" }, { name: uniq("ok"), tag: "TOOLONG1" }, { name: uniq("ok"), tag: "a-b" },
      { name: "<script>alert(1)</script>", tag: "XSS" },
    ]) {
      const r = await createClan(u.id, bad);
      expect(r.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(await getMembership(u.id)).toBeNull();
    expect(readFileSync("src/lib/clans.ts", "utf8")).toContain("checkChatText");
  });

  it("rate limits clan creation", async () => {
    const u = await makeUser("rl");
    for (let i = 0; i < LIMITS.clanCreate.max; i++) {
      await createClan(u.id, { name: "fuck", tag: "ZZ" }); // filtered attempts still count against the limit
    }
    expect(await createClan(u.id, { name: uniq("Late"), tag: tagN() })).toMatchObject({ ok: false, code: "rate_limited" });
  });
});

describe("invites, roster cap and roles", () => {
  it("only officers invite; only the invitee answers; joining is atomic and single-clan", async () => {
    const { leader, members, tag } = await makeClan("inv", 1);
    const target = await makeUser("t");
    const outsider = await makeUser("o");
    expect(await inviteToClan(members[0].id, tag, target.username)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await inviteToClan(outsider.id, tag, target.username)).toMatchObject({ ok: false, code: "not_found" }); // non-member: no signal
    expect(await inviteToClan(leader.id, tag, "nobody_xyz")).toMatchObject({ ok: false, code: "not_found" });
    expect(await inviteToClan(leader.id, tag, members[0].username)).toMatchObject({ ok: false, code: "conflict" }); // already in a clan
    expect(await inviteToClan(leader.id, tag, target.username)).toEqual({ ok: true });
    expect(await inviteToClan(leader.id, tag, target.username)).toMatchObject({ ok: false, code: "conflict" }); // duplicate

    const [inv] = await listMyInvites(target.id);
    expect(inv.clanTag).toBe(tag);
    expect(await respondToInvite(outsider.id, inv.id, true)).toMatchObject({ ok: false, code: "not_found" }); // not your invite
    expect(await respondToInvite(target.id, inv.id, true)).toEqual({ ok: true, tag });
    expect(await getMembership(target.id)).toMatchObject({ tag, role: "member" });
    expect(await respondToInvite(target.id, inv.id, true)).toMatchObject({ ok: false }); // cannot reuse
  });

  it("declining keeps the player free and a full roster refuses new members", async () => {
    const { clan, leader, tag } = await makeClan("cap");
    const d = await makeUser("dec");
    await inviteToClan(leader.id, tag, d.username);
    const [inv] = await listMyInvites(d.id);
    expect(await respondToInvite(d.id, inv.id, false)).toEqual({ ok: true });
    expect(await getMembership(d.id)).toBeNull();

    // Fill to the cap with bulk-inserted members.
    const fillers = await db.insert(users).values(Array.from({ length: CLAN_MAX_MEMBERS - 1 }, (_, i) => ({ username: `${RUN}_f${i}`.slice(0, 20), displayName: "F", updatedAt: new Date() }))).returning();
    ids.push(...fillers.map((f) => f.id));
    await db.insert(clanMembers).values(fillers.map((f) => ({ clanId: clan.id, userId: f.id, role: "member" })));
    const late = await makeUser("late");
    expect(await inviteToClan(leader.id, tag, late.username)).toMatchObject({ ok: false, code: "conflict" });
    // Even an invite that was already out cannot push the roster over the cap.
    await db.insert(clanInvites).values({ clanId: clan.id, userId: late.id, invitedBy: leader.id });
    const [stale] = await listMyInvites(late.id);
    expect(await respondToInvite(late.id, stale.id, true)).toMatchObject({ ok: false, code: "conflict" });
    const count = await db.select().from(clanMembers).where(eq(clanMembers.clanId, clan.id));
    expect(count).toHaveLength(CLAN_MAX_MEMBERS);
  });

  it("enforces leader / officer / member permissions and is IDOR-safe across clans", async () => {
    const { leader, members, tag } = await makeClan("rbac", 3);
    const [officer, m1, m2] = members;
    const other = await makeClan("rbac2", 1);
    expect(await setMemberRole(officer.id, tag, m1.username, "officer")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await setMemberRole(leader.id, tag, officer.username, "officer")).toEqual({ ok: true });
    expect(await setMemberRole(leader.id, tag, officer.username, "king")).toMatchObject({ ok: false, code: "invalid" });

    expect(await kickMember(m1.id, tag, m2.username)).toMatchObject({ ok: false, code: "forbidden" }); // member
    expect(await kickMember(officer.id, tag, leader.username)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await kickMember(leader.id, tag, leader.username)).toMatchObject({ ok: false, code: "invalid" });
    // Another clan's leader cannot touch this clan at all.
    expect(await kickMember(other.leader.id, tag, m1.username)).toMatchObject({ ok: false, code: "not_found" });
    expect(await setMemberRole(other.leader.id, tag, m1.username, "officer")).toMatchObject({ ok: false, code: "not_found" });
    expect(await disbandClan(officer.id, tag)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await kickMember(officer.id, tag, m2.username)).toEqual({ ok: true }); // officer removes a plain member
    expect(await getMembership(m2.id)).toBeNull();

    // Leader cannot just walk away; transfer first.
    expect(await leaveClan(leader.id)).toMatchObject({ ok: false, code: "conflict" });
    expect(await transferLeadership(officer.id, tag, m1.username)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await transferLeadership(leader.id, tag, officer.username)).toEqual({ ok: true });
    expect(await getMembership(officer.id)).toMatchObject({ role: "leader" });
    expect(await getMembership(leader.id)).toMatchObject({ role: "officer" });
    const [clan] = await db.select().from(clans).where(eq(clans.tag, tag));
    expect(clan.leaderId).toBe(officer.id);
    expect(await leaveClan(leader.id)).toEqual({ ok: true });
    expect((await getClanHub(m1.id, tag))?.myRole).toBe("member");
    expect((await getClanHub(other.leader.id, tag))?.myRole).toBeNull(); // may look, not act
  });
});

describe("private clan chat", () => {
  it("is members-only for reading and posting", async () => {
    const { leader, members, tag } = await makeClan("chat", 1);
    const outsider = await makeUser("out");
    const sent = await sendClanMessage(members[0].id, tag, "  gg  everyone ");
    expect(sent.ok && sent.message.body).toBe("gg everyone");
    const mine = await getClanMessages(leader.id, tag);
    expect(mine.ok && mine.messages.map((m) => m.body)).toEqual(["gg everyone"]);
    expect(await getClanMessages(outsider.id, tag)).toMatchObject({ ok: false, code: "not_found" });
    expect(await sendClanMessage(outsider.id, tag, "let me in")).toMatchObject({ ok: false, code: "not_found" });
    const other = await makeClan("chat2");
    expect(await getClanMessages(other.leader.id, tag)).toMatchObject({ ok: false, code: "not_found" });
    expect(await sendClanMessage(other.leader.id, tag, "wrong clan")).toMatchObject({ ok: false, code: "not_found" });
    // Left the clan: access gone immediately.
    await leaveClan(members[0].id);
    expect(await getClanMessages(members[0].id, tag)).toMatchObject({ ok: false, code: "not_found" });
  });

  it("filters abuse, links and spam without storing, rate limits, and honours message blocks", async () => {
    const { clan, leader, members, tag } = await makeClan("flt", 2);
    for (const bad of ["fuck you all", "visit www.bad.com", "aaaaaaaaaaaaaaaaaa"]) {
      expect(await sendClanMessage(members[0].id, tag, bad)).toMatchObject({ ok: false, code: "filtered" });
    }
    expect(await db.select().from(clanChatMessages).where(eq(clanChatMessages.clanId, clan.id))).toHaveLength(0);
    await sendClanMessage(members[0].id, tag, "shit");
    await sendClanMessage(members[0].id, tag, "shit");
    expect(await sendClanMessage(members[0].id, tag, "clean again")).toMatchObject({ ok: false, code: "rate_limited" }); // strike cool-off

    for (let i = 0; i < LIMITS.clanChatUser.max; i++) expect((await sendClanMessage(members[1].id, tag, `message ${i} for the clan`)).ok).toBe(true);
    expect(await sendClanMessage(members[1].id, tag, "one more")).toMatchObject({ ok: false, code: "rate_limited" });

    // Phase 7B block: the leader no longer sees messages from the blocked member.
    expect((await getClanMessages(leader.id, tag)).ok).toBe(true);
    await setMessageBlock(leader.id, members[1].username, true);
    const afterBlock = await getClanMessages(leader.id, tag);
    expect(afterBlock.ok && afterBlock.messages.some((m) => m.username === members[1].username)).toBe(false);
    for (const f of ["src/lib/rivalry-helpers.ts", "src/lib/rivalry-actions.ts"]) expect(readFileSync(f, "utf8")).not.toMatch(/clans|clan-wars/);
  });
});

describe("clan war creation and authorization", () => {
  it("lets only officers challenge, validates pairings, and only the challenged clan's officers accept", async () => {
    const A = await makeClan("ca", 3);
    const B = await makeClan("cb", 3);
    const C = await makeClan("cc", 3);
    const pairs = (as: { username: string }[], bs: { username: string }[]) => as.slice(0, 3).map((a, i) => ({ mine: a.username, theirs: bs[i].username }));
    const aAll = [A.leader, ...A.members];
    const bAll = [B.leader, ...B.members];
    const input = { defenderTag: B.tag, seriesSize: 3, pairings: pairs(aAll, bAll) };

    expect(await createClanWar(A.members[0].id, input)).toMatchObject({ ok: false, code: "forbidden" }); // plain member
    expect(await createClanWar((await makeUser("nobody")).id, input)).toMatchObject({ ok: false, code: "not_found" });
    expect(await createClanWar(A.leader.id, { ...input, defenderTag: A.tag })).toMatchObject({ ok: false });
    expect(await createClanWar(A.leader.id, { ...input, seriesSize: 4 })).toMatchObject({ ok: false, code: "invalid" });
    expect(await createClanWar(A.leader.id, { ...input, pairings: input.pairings.slice(0, 2) })).toMatchObject({ ok: false, code: "invalid" });
    expect(await createClanWar(A.leader.id, { ...input, pairings: pairs(aAll, [C.leader, ...C.members]) })).toMatchObject({ ok: false, code: "invalid" }); // C players are not in B
    const dupe = [input.pairings[0], { mine: aAll[0].username, theirs: bAll[1].username }, input.pairings[2]];
    expect(await createClanWar(A.leader.id, { ...input, pairings: dupe })).toMatchObject({ ok: false, code: "invalid" }); // same player twice

    const ok = await createClanWar(A.leader.id, input);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(await createClanWar(B.leader.id, { defenderTag: A.tag, seriesSize: 3, pairings: pairs(bAll, aAll) })).toMatchObject({ ok: false, code: "conflict" }); // already a war between them

    expect(await respondToClanWar(A.leader.id, ok.warId, "accept")).toMatchObject({ ok: false, code: "forbidden" }); // challenger cannot accept
    expect(await respondToClanWar(B.members[0].id, ok.warId, "accept")).toMatchObject({ ok: false, code: "forbidden" }); // plain member
    expect(await respondToClanWar(C.leader.id, ok.warId, "accept")).toMatchObject({ ok: false, code: "not_found" }); // third clan
    expect(await respondToClanWar(B.leader.id, ok.warId, "cancel")).toMatchObject({ ok: false, code: "forbidden" });
    expect((await war(ok.warId)).status).toBe("pending");
    expect(await respondToClanWar(B.leader.id, ok.warId, "accept")).toEqual({ ok: true });
    const w = await war(ok.warId);
    expect(w.status).toBe("active");
    expect(w.startedAt).not.toBeNull();
    expect(await respondToClanWar(B.leader.id, ok.warId, "accept")).toMatchObject({ ok: false, code: "conflict" });
    const view = await getClanWars(A.clan.id, "leader");
    expect(view[0].pairings).toHaveLength(3);
  });

  it("supports decline and cancel, and rejects accept after a paired player left", async () => {
    const A = await makeClan("da", 3);
    const B = await makeClan("db", 3);
    const input = { defenderTag: B.tag, seriesSize: 3, pairings: [A.leader, ...A.members].slice(0, 3).map((a, i) => ({ mine: a.username, theirs: [B.leader, ...B.members][i].username })) };
    const w1 = await createClanWar(A.leader.id, input);
    if (!w1.ok) throw new Error(w1.error);
    expect(await respondToClanWar(A.leader.id, w1.warId, "cancel")).toEqual({ ok: true });
    expect((await war(w1.warId)).status).toBe("cancelled");
    const w2 = await createClanWar(A.leader.id, input);
    if (!w2.ok) throw new Error(w2.error);
    expect(await respondToClanWar(B.leader.id, w2.warId, "decline")).toEqual({ ok: true });
    expect((await war(w2.warId)).status).toBe("declined");
    const w3 = await createClanWar(A.leader.id, input);
    if (!w3.ok) throw new Error(w3.error);
    await leaveClan(B.members[0].id);
    expect(await respondToClanWar(B.leader.id, w3.warId, "accept")).toMatchObject({ ok: false, code: "conflict" });
  });
});

describe("idempotent confirmed-match war settlement", () => {
  it("counts only confirmed, decisive matches played after the war starts, between the exact pair", async () => {
    const w = await activeWar(3);
    const [c1, c2] = w.aPlayers;
    const [d1] = w.bPlayers;
    // A decisive match BEFORE the war is accepted must not count.
    const early = await playMatch(c1, w.rivals[0].id, 3, 0);
    await new Promise((r) => setTimeout(r, 50));
    await accept(w);
    await settleWarPairings(w.warId);
    expect((await pairings(w.warId))[0].status).toBe("pending");
    expect(early).toBeTruthy();

    // A draw does not decide a slot.
    await playMatch(c1, w.rivals[0].id, 1, 1);
    expect((await pairings(w.warId))[0].status).toBe("pending");

    // A disputed match does not count; re-confirming it does.
    const disputed = await playMatch(c1, w.rivals[0].id, 2, 0);
    // saving already settled it; dispute reopens the slot while the war is active
    expect((await pairings(w.warId))[0]).toMatchObject({ status: "completed", matchId: disputed });
    expect((await disputeMatch(d1.id, false, disputed)).ok).toBe(true);
    expect((await pairings(w.warId))[0]).toMatchObject({ status: "pending", matchId: null });
    expect((await war(w.warId)).challengerWins).toBe(0);
    expect((await resolveMatchDispute(d1.id, false, disputed)).ok).toBe(true);
    expect((await pairings(w.warId))[0]).toMatchObject({ status: "completed", matchId: disputed, winnerPlayerId: c1.id, winnerClanId: w.A.clan.id });
    expect((await war(w.warId)).challengerWins).toBe(1);

    // A match between players who are not paired in this war counts for nothing.
    const outsider = await makeUser("stranger");
    const rv = await rivalryBetween(c2, outsider);
    await playMatch(c2, rv.id, 5, 0);
    expect((await pairings(w.warId))[1].status).toBe("pending");
  });

  it("is idempotent, never reuses a match, and completes the war exactly at a majority", async () => {
    const w = await activeWar(3);
    await accept(w);
    const m1 = await playMatch(w.aPlayers[0], w.rivals[0].id, 2, 1); // challenger clan wins game 1
    for (let i = 0; i < 3; i++) await settleWarPairings(w.warId); // re-running changes nothing
    let ps = await pairings(w.warId);
    expect(ps[0]).toMatchObject({ status: "completed", matchId: m1 });
    expect(await war(w.warId)).toMatchObject({ challengerWins: 1, defenderWins: 0, status: "active" });

    // The unique constraint refuses to give the same match to a second slot.
    await expect(db.update(clanWarPairings).set({ matchId: m1, status: "completed" }).where(eq(clanWarPairings.id, ps[1].id))).rejects.toThrow();
    ps = await pairings(w.warId);
    expect(ps[1].status).toBe("pending");

    // Defender wins game 2: 1-1, still active.
    await playMatch(w.bPlayers[1], w.rivals[1].id, 4, 2);
    expect(await war(w.warId)).toMatchObject({ challengerWins: 1, defenderWins: 1, status: "active", winnerClanId: null });
    // Challenger wins game 3: 2-1, majority reached.
    await playMatch(w.aPlayers[2], w.rivals[2].id, 1, 0);
    const done = await war(w.warId);
    expect(done).toMatchObject({ challengerWins: 2, defenderWins: 1, status: "completed", winnerClanId: w.A.clan.id });
    expect(done.completedAt).not.toBeNull();
    expect(winsNeeded(3)).toBe(2);
    expect(winsNeeded(5)).toBe(3);
    // Final: more matches or re-settling cannot change a completed war.
    await playMatch(w.aPlayers[0], w.rivals[0].id, 9, 0);
    await settleWarPairings(w.warId);
    expect(await war(w.warId)).toMatchObject({ challengerWins: 2, defenderWins: 1, status: "completed" });
  });

  it("ends a war as soon as one clan has the majority (2-0) and ignores later games", async () => {
    const w = await activeWar(3);
    await accept(w);
    await playMatch(w.bPlayers[0], w.rivals[0].id, 3, 1);
    await playMatch(w.bPlayers[1], w.rivals[1].id, 2, 0);
    const done = await war(w.warId);
    expect(done).toMatchObject({ defenderWins: 2, challengerWins: 0, status: "completed", winnerClanId: w.B.clan.id });
    await playMatch(w.aPlayers[2], w.rivals[2].id, 4, 0);
    expect(await war(w.warId)).toMatchObject({ defenderWins: 2, challengerWins: 0, status: "completed" });
    expect((await pairings(w.warId))[2].status).toBe("pending");
  });

  it("holds settlement while an anti-sybil flag is open on the rivalry, and releases it when resolved", async () => {
    const w = await activeWar(3);
    await accept(w);
    const [flag] = await db.insert(sybilFlags).values({ flagType: "score_farming", severity: "high", primaryUserId: w.aPlayers[0].id, rivalryId: w.rivals[0].id, reason: "test" }).returning();
    await playMatch(w.aPlayers[0], w.rivals[0].id, 2, 0);
    expect((await pairings(w.warId))[0].status).toBe("pending");
    await db.update(sybilFlags).set({ status: "dismissed" }).where(eq(sybilFlags.id, flag.id));
    await settleWarPairings(w.warId);
    expect((await pairings(w.warId))[0].status).toBe("completed");
  });

  it("reopens a slot whose match is soft-deleted while the war is still open", async () => {
    const w = await activeWar(3);
    await accept(w);
    const id = await playMatch(w.aPlayers[0], w.rivals[0].id, 2, 0);
    expect((await pairings(w.warId))[0].status).toBe("completed");
    await db.update(matches).set({ deletedAt: new Date() }).where(eq(matches.id, id));
    await settleWarPairings(w.warId);
    expect((await pairings(w.warId))[0]).toMatchObject({ status: "pending", matchId: null });
    expect((await war(w.warId)).challengerWins).toBe(0);
  });

  it("never settles a war that is pending", async () => {
    const w = await activeWar(3); // created, not accepted
    await playMatch(w.aPlayers[0], w.rivals[0].id, 2, 0);
    await settleWarPairings(w.warId);
    expect((await pairings(w.warId))[0].status).toBe("pending");
    expect((await war(w.warId)).status).toBe("pending");
  });
});

describe("cascades, account deletion, rendering and no-LLM guarantees", () => {
  it("disbanding or deleting cascades cleanly", async () => {
    const w = await activeWar(3);
    await accept(w);
    await sendClanMessage(w.A.leader.id, w.A.tag, "hello clan");
    expect(await disbandClan(w.A.leader.id, w.A.tag)).toEqual({ ok: true });
    expect(await db.select().from(clanMembers).where(eq(clanMembers.clanId, w.A.clan.id))).toHaveLength(0);
    expect(await db.select().from(clanChatMessages).where(eq(clanChatMessages.clanId, w.A.clan.id))).toHaveLength(0);
    expect(await db.select().from(clanWars).where(eq(clanWars.id, w.warId))).toHaveLength(0);
    expect(await pairings(w.warId)).toHaveLength(0);
    expect(await getMembership(w.A.leader.id)).toBeNull();
  });

  it("hands leadership on (or disbands) when a leader deletes their account", async () => {
    const A = await makeClan("del", 2);
    expect(await deleteAccount(A.leader.id)).toEqual({ ok: true });
    const [clan] = await db.select().from(clans).where(eq(clans.id, A.clan.id));
    expect(clan.leaderId).toBe(A.members[0].id);
    expect(await getMembership(A.members[0].id)).toMatchObject({ role: "leader" });
    expect(await getMembership(A.leader.id)).toBeNull();
    const solo = await makeClan("del2");
    expect(await deleteAccount(solo.leader.id)).toEqual({ ok: true });
    expect(await db.select().from(clans).where(eq(clans.id, solo.clan.id))).toHaveLength(0);
  });

  it("suspended accounts fail the API guard, and every clan route uses it", async () => {
    const sus = await makeUser("susp", { suspended: true });
    expect(await refreshSessionUser(sus.id)).toBeNull();
    for (const f of [
      "src/app/api/clans/route.ts", "src/app/api/clans/[tag]/manage/route.ts", "src/app/api/clans/[tag]/chat/route.ts",
      "src/app/api/clans/[tag]/wars/route.ts", "src/app/api/clan-wars/[id]/route.ts", "src/app/api/clan-invites/route.ts",
    ]) {
      expect(readFileSync(f, "utf8"), f).toContain("apiUser(request");
    }
    for (const f of ["src/app/clans/page.tsx", "src/app/clans/[tag]/page.tsx"]) expect(readFileSync(f, "utf8")).toContain('redirect("/login")');
  });

  it("makes no LLM or network calls and renders user text as plain text", () => {
    for (const f of ["src/lib/clans.ts", "src/lib/clan-wars.ts", "src/lib/clan-api.ts", "src/components/clans/clan-ui.tsx"]) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/gemini|generativelanguage|fetch\(\s*["'`]https?:/i);
      expect(readFileSync(f, "utf8"), f).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
    for (const f of ["src/app/clans/page.tsx", "src/app/clans/[tag]/page.tsx"]) expect(readFileSync(f, "utf8")).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    const html = renderToStaticMarkup(createElement("p", null, `<img src=x onerror=alert(1)>`));
    expect(html).not.toContain("<img");
    expect(readFileSync("src/lib/match-helpers.ts", "utf8")).toContain("settleClanWarsForMatch");
  });
});
