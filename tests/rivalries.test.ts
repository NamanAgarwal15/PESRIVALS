// Integration tests for src/lib/rivalry-helpers.ts against the LOCAL TEST database.
// Every row created here is tracked and deleted again in afterAll.

import { randomBytes } from "node:crypto";
import { eq, inArray, like, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { matches, rivalries, users } from "@/db/schema";
import {
  canonicalPair,
  cancelRivalryRequest,
  getRivalryForMember,
  getUserRivalries,
  isActiveRivalryMember,
  normalizeUsernameQuery,
  respondToRivalryRequest,
  searchUsersByUsername,
  sendRivalryRequest,
} from "@/lib/rivalry-helpers";

const RUN = `r${randomBytes(3).toString("hex")}`; // e.g. "r3fa91c"
const createdUserIds = new Set<string>();
let counter = 0;

type NewUser = { onboarded?: boolean; isPlaceholder?: boolean; username?: string };

async function makeUser(label: string, options: NewUser = {}) {
  const [row] = await db
    .insert(users)
    .values({
      username: options.username ?? `${RUN}_${label}${counter++}`.slice(0, 20),
      displayName: `Test ${label}`,
      onboarded: options.onboarded ?? true,
      isPlaceholder: options.isPlaceholder ?? false,
      updatedAt: new Date(),
    })
    .returning();
  createdUserIds.add(row.id);
  return row;
}

async function rivalryRow(id: string) {
  const [row] = await db.select().from(rivalries).where(eq(rivalries.id, id));
  return row;
}

async function rowsBetween(id1: string, id2: string) {
  const [a, b] = canonicalPair(id1, id2);
  return db
    .select()
    .from(rivalries)
    .where(or(eq(rivalries.userAId, a), eq(rivalries.userBId, a)))
    .then((rows) => rows.filter((r) => r.userAId === a && r.userBId === b));
}

/** Sends a challenge and returns the new rivalry id, failing loudly otherwise. */
async function challenge(fromId: string, toId: string) {
  const result = await sendRivalryRequest(fromId, toId);
  if (!result.ok) throw new Error(`challenge failed: ${result.error}`);
  return result.rivalryId;
}

async function activeRivalry(fromId: string, toId: string) {
  const id = await challenge(fromId, toId);
  const accepted = await respondToRivalryRequest(toId, id, "accept");
  if (!accepted.ok) throw new Error(`accept failed: ${accepted.error}`);
  return id;
}

afterAll(async () => {
  const ids = [...createdUserIds];
  if (ids.length) {
    // Matches go with their rivalry, rivalries with their users (ON DELETE CASCADE).
    await db
      .delete(rivalries)
      .where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    await db.delete(users).where(inArray(users.id, ids));
  }
  // Safety net for anything a failed test created but did not track.
  await db.delete(users).where(like(users.username, `${RUN}\\_%`));
});

describe("canonical pair", () => {
  it("always puts the lower uuid first", () => {
    const low = "11111111-1111-4111-8111-111111111111";
    const high = "99999999-9999-4999-8999-999999999999";
    expect(canonicalPair(low, high)).toEqual([low, high]);
    expect(canonicalPair(high, low)).toEqual([low, high]);
    expect(canonicalPair(high.toUpperCase(), low)).toEqual([low, high]);
  });

  it("rejects a self-rivalry", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(() => canonicalPair(id, id)).toThrow();
    expect(() => canonicalPair(id, id.toUpperCase())).toThrow();
  });

  it("stores user_a < user_b no matter who sends the challenge", async () => {
    const [p, q, r] = await Promise.all([makeUser("ord"), makeUser("ord"), makeUser("ord")]);
    const [low, mid, high] = [p.id, q.id, r.id].sort();

    // Lower id challenges higher id, and higher id challenges lower id.
    const first = await rivalryRow(await challenge(low, mid));
    const second = await rivalryRow(await challenge(high, mid));

    expect([first.userAId, first.userBId]).toEqual([low, mid]);
    expect(first.requestedBy).toBe(low);
    expect([second.userAId, second.userBId]).toEqual([mid, high]);
    expect(second.requestedBy).toBe(high);
    expect(first.status).toBe("pending");
    expect(first.acceptedAt).toBeNull();
  });
});

describe("searchUsersByUsername", () => {
  it("normalizes the query", () => {
    expect(normalizeUsernameQuery("  @NaMan ")).toBe("naman");
    expect(normalizeUsernameQuery("@a")).toBeNull();
    expect(normalizeUsernameQuery("")).toBeNull();
    expect(normalizeUsernameQuery("na man")).toBeNull();
    expect(normalizeUsernameQuery("a%")).toBeNull();
    expect(normalizeUsernameQuery(undefined)).toBeNull();
  });

  it("finds users by prefix and excludes self, placeholders and un-onboarded users", async () => {
    const prefix = `${RUN}_s`;
    const me = await makeUser("s_me", { username: `${prefix}me` });
    const alice = await makeUser("", { username: `${prefix}alice` });
    const bob = await makeUser("", { username: `${prefix}bob` });
    const placeholder = await makeUser("", { username: `${prefix}ghost`, isPlaceholder: true });
    const fresh = await makeUser("", { username: `${prefix}fresh`, onboarded: false });
    const elsewhere = await makeUser("", { username: `${RUN}_zzz` });

    const results = await searchUsersByUsername(me.id, `  @${prefix.toUpperCase()} `);
    const names = results.map((r) => r.username);

    expect(names).toEqual([alice.username, bob.username]); // sorted, prefix only
    expect(names).not.toContain(me.username);
    expect(names).not.toContain(placeholder.username);
    expect(names).not.toContain(fresh.username);
    expect(names).not.toContain(elsewhere.username);
    expect(results[0]).toMatchObject({
      id: alice.id,
      displayName: alice.displayName,
      relation: "none",
      rivalryId: null,
    });

    // Prefix only: "alice" is found by its start, not by its middle.
    expect(await searchUsersByUsername(me.id, "lice")).toEqual([]);
    // Too short or malformed queries return nothing instead of everything.
    expect(await searchUsersByUsername(me.id, "@")).toEqual([]);
    expect(await searchUsersByUsername(me.id, "%")).toEqual([]);
  });

  it("treats an underscore literally, not as a wildcard", async () => {
    const me = await makeUser("u_me");
    await makeUser("", { username: `${RUN}xw1` });
    const real = await makeUser("", { username: `${RUN}_w1` });

    const results = await searchUsersByUsername(me.id, `${RUN}_w`);
    expect(results.map((r) => r.username)).toEqual([real.username]);
  });

  it("returns at most 10 results", async () => {
    const me = await makeUser("l_me");
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        makeUser("", { username: `${RUN}_lim${String(i).padStart(2, "0")}` }),
      ),
    );
    expect(await searchUsersByUsername(me.id, `${RUN}_lim`)).toHaveLength(10);
  });

  it("annotates each result with the existing relation", async () => {
    const prefix = `${RUN}_rel`;
    const me = await makeUser("rel_me");
    const none = await makeUser("", { username: `${prefix}_a` });
    const sent = await makeUser("", { username: `${prefix}_b` });
    const received = await makeUser("", { username: `${prefix}_c` });
    const active = await makeUser("", { username: `${prefix}_d` });
    const declined = await makeUser("", { username: `${prefix}_e` });
    const blocked = await makeUser("", { username: `${prefix}_f` });

    const sentId = await challenge(me.id, sent.id);
    const receivedId = await challenge(received.id, me.id);
    const activeId = await activeRivalry(me.id, active.id);
    const declinedId = await challenge(me.id, declined.id);
    await respondToRivalryRequest(declined.id, declinedId, "decline");
    const blockedId = await challenge(me.id, blocked.id);
    await db.update(rivalries).set({ status: "blocked" }).where(eq(rivalries.id, blockedId));

    const results = await searchUsersByUsername(me.id, prefix);
    expect(results.map((r) => [r.id, r.relation, r.rivalryId])).toEqual([
      [none.id, "none", null],
      [sent.id, "pending_sent", sentId],
      [received.id, "pending_received", receivedId],
      [active.id, "active", activeId],
      [declined.id, "declined", declinedId],
      [blocked.id, "blocked", blockedId],
    ]);
  });
});

describe("sendRivalryRequest", () => {
  it("creates a pending request", async () => {
    const [a, b] = await Promise.all([makeUser("send"), makeUser("send")]);
    const result = await sendRivalryRequest(a.id, b.id);

    expect(result).toMatchObject({ ok: true, relation: "pending_sent" });
    if (!result.ok) return;
    const row = await rivalryRow(result.rivalryId);
    expect(row).toMatchObject({ status: "pending", requestedBy: a.id, acceptedAt: null });
  });

  it("rejects challenging yourself", async () => {
    const a = await makeUser("self");
    const result = await sendRivalryRequest(a.id, a.id);
    expect(result.ok).toBe(false);
    expect(await getUserRivalries(a.id)).toEqual({
      activeRivalries: [],
      incomingRequests: [],
      sentRequests: [],
    });
  });

  it("rejects unknown, placeholder and un-onboarded targets", async () => {
    const a = await makeUser("tgt");
    const placeholder = await makeUser("tgt", { isPlaceholder: true });
    const fresh = await makeUser("tgt", { onboarded: false });

    for (const target of [
      "11111111-1111-4111-8111-111111111111",
      "not-a-uuid",
      placeholder.id,
      fresh.id,
    ]) {
      const result = await sendRivalryRequest(a.id, target);
      expect(result, target).toEqual({ ok: false, error: "User not found" });
    }
  });

  it("rejects a sender who is not onboarded", async () => {
    const fresh = await makeUser("snd", { onboarded: false });
    const b = await makeUser("snd");
    expect((await sendRivalryRequest(fresh.id, b.id)).ok).toBe(false);
    expect(await rowsBetween(fresh.id, b.id)).toHaveLength(0);
  });

  it("does not create a second request while one is pending", async () => {
    const [a, b] = await Promise.all([makeUser("dup"), makeUser("dup")]);
    await challenge(a.id, b.id);

    expect(await sendRivalryRequest(a.id, b.id)).toEqual({
      ok: false,
      error: "Request already pending",
    });
    expect(await rowsBetween(a.id, b.id)).toHaveLength(1);
  });

  it("auto-accepts when the other user had already sent a challenge", async () => {
    const [a, b] = await Promise.all([makeUser("mut"), makeUser("mut")]);
    const id = await challenge(a.id, b.id);

    const result = await sendRivalryRequest(b.id, a.id);
    expect(result).toEqual({ ok: true, rivalryId: id, relation: "active", autoAccepted: true });

    const rows = await rowsBetween(a.id, b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].acceptedAt).toBeInstanceOf(Date);
    expect(rows[0].requestedBy).toBe(a.id);
  });

  it("ends with exactly one row when both users challenge at the same moment", async () => {
    const [a, b] = await Promise.all([makeUser("race"), makeUser("race")]);

    const results = await Promise.all([
      sendRivalryRequest(a.id, b.id),
      sendRivalryRequest(b.id, a.id),
    ]);

    expect(results.every((r) => r.ok)).toBe(true);
    const rows = await rowsBetween(a.id, b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
    expect(rows[0].acceptedAt).toBeInstanceOf(Date);
  });

  it('answers "Already rivals" for an active rivalry', async () => {
    const [a, b] = await Promise.all([makeUser("act"), makeUser("act")]);
    await activeRivalry(a.id, b.id);

    expect(await sendRivalryRequest(a.id, b.id)).toEqual({ ok: false, error: "Already rivals" });
    expect(await sendRivalryRequest(b.id, a.id)).toEqual({ ok: false, error: "Already rivals" });
  });

  it("refuses when the pair is blocked", async () => {
    const [a, b] = await Promise.all([makeUser("blk"), makeUser("blk")]);
    const id = await challenge(a.id, b.id);
    await db.update(rivalries).set({ status: "blocked" }).where(eq(rivalries.id, id));

    for (const [from, to] of [
      [a.id, b.id],
      [b.id, a.id],
    ]) {
      expect(await sendRivalryRequest(from, to)).toEqual({
        ok: false,
        error: "Cannot send request to this user",
      });
    }
    expect((await rivalryRow(id)).status).toBe("blocked");
  });
});

describe("respondToRivalryRequest", () => {
  it("accept makes the rivalry active and sets accepted_at", async () => {
    const [a, b] = await Promise.all([makeUser("acc"), makeUser("acc")]);
    const id = await challenge(a.id, b.id);
    const before = Date.now();

    expect(await respondToRivalryRequest(b.id, id, "accept")).toEqual({
      ok: true,
      rivalryId: id,
      relation: "active",
    });
    const row = await rivalryRow(id);
    expect(row.status).toBe("active");
    expect(row.acceptedAt!.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    expect(row.requestedBy).toBe(a.id);
  });

  it("the sender cannot accept or decline their own request", async () => {
    const [a, b] = await Promise.all([makeUser("own"), makeUser("own")]);
    const id = await challenge(a.id, b.id);

    expect((await respondToRivalryRequest(a.id, id, "accept")).ok).toBe(false);
    expect((await respondToRivalryRequest(a.id, id, "decline")).ok).toBe(false);
    expect(await rivalryRow(id)).toMatchObject({ status: "pending", acceptedAt: null });
  });

  it("a third user cannot accept, decline or cancel someone else's request", async () => {
    const [a, b, outsider] = await Promise.all([
      makeUser("out"),
      makeUser("out"),
      makeUser("out"),
    ]);
    const id = await challenge(a.id, b.id);

    expect(await respondToRivalryRequest(outsider.id, id, "accept")).toEqual({
      ok: false,
      error: "Request not found",
    });
    expect((await respondToRivalryRequest(outsider.id, id, "decline")).ok).toBe(false);
    expect((await cancelRivalryRequest(outsider.id, id)).ok).toBe(false);
    // The recipient cannot cancel either; only the sender can.
    expect((await cancelRivalryRequest(b.id, id)).ok).toBe(false);

    expect(await rivalryRow(id)).toMatchObject({ status: "pending", requestedBy: a.id });
  });

  it("rejects bad input and requests that are no longer pending", async () => {
    const [a, b] = await Promise.all([makeUser("bad"), makeUser("bad")]);
    const id = await challenge(a.id, b.id);

    expect((await respondToRivalryRequest(b.id, id, "maybe")).ok).toBe(false);
    expect((await respondToRivalryRequest(b.id, "not-a-uuid", "accept")).ok).toBe(false);
    expect(
      (await respondToRivalryRequest(b.id, "11111111-1111-4111-8111-111111111111", "accept")).ok,
    ).toBe(false);

    await respondToRivalryRequest(b.id, id, "accept");
    // Already active: it cannot be declined or accepted again.
    expect((await respondToRivalryRequest(b.id, id, "decline")).ok).toBe(false);
    expect((await rivalryRow(id)).status).toBe("active");
  });

  it("decline, then either side can challenge again on the same row", async () => {
    const [a, b] = await Promise.all([makeUser("dec"), makeUser("dec")]);
    const id = await challenge(a.id, b.id);
    const original = await rivalryRow(id);

    expect(await respondToRivalryRequest(b.id, id, "decline")).toEqual({
      ok: true,
      rivalryId: id,
      relation: "declined",
    });
    expect(await rivalryRow(id)).toMatchObject({ status: "declined", acceptedAt: null });
    // Declined requests are not listed for either user.
    expect((await getUserRivalries(a.id)).sentRequests).toHaveLength(0);
    expect((await getUserRivalries(b.id)).incomingRequests).toHaveLength(0);

    // This time the one who declined sends the challenge.
    const again = await sendRivalryRequest(b.id, a.id);
    expect(again).toEqual({ ok: true, rivalryId: id, relation: "pending_sent" });

    const reopened = await rivalryRow(id);
    expect(reopened).toMatchObject({ status: "pending", requestedBy: b.id, acceptedAt: null });
    expect([reopened.userAId, reopened.userBId]).toEqual([original.userAId, original.userBId]);
    // createdAt is reset from the app clock; the original came from the database
    // clock. Allow for skew between the two machines.
    expect(reopened.createdAt.getTime()).toBeGreaterThanOrEqual(original.createdAt.getTime() - 5_000);
    expect(await rowsBetween(a.id, b.id)).toHaveLength(1);

    // And now it is the original sender who has to answer.
    expect((await respondToRivalryRequest(b.id, id, "accept")).ok).toBe(false);
    expect((await respondToRivalryRequest(a.id, id, "accept")).ok).toBe(true);
  });
});

describe("cancelRivalryRequest", () => {
  it("the sender can cancel a pending request, which deletes the row", async () => {
    const [a, b] = await Promise.all([makeUser("can"), makeUser("can")]);
    const id = await challenge(a.id, b.id);

    expect(await cancelRivalryRequest(a.id, id)).toEqual({
      ok: true,
      rivalryId: id,
      relation: "none",
    });
    expect(await rivalryRow(id)).toBeUndefined();

    // Cancelling twice fails, and a fresh challenge works afterwards.
    expect((await cancelRivalryRequest(a.id, id)).ok).toBe(false);
    expect((await sendRivalryRequest(b.id, a.id)).ok).toBe(true);
  });

  it("cannot cancel an active rivalry", async () => {
    const [a, b] = await Promise.all([makeUser("cna"), makeUser("cna")]);
    const id = await activeRivalry(a.id, b.id);

    expect((await cancelRivalryRequest(a.id, id)).ok).toBe(false);
    expect((await rivalryRow(id)).status).toBe("active");
  });
});

describe("getUserRivalries", () => {
  it("splits rivalries into active, incoming and sent, with match counts", async () => {
    const me = await makeUser("list");
    const [rival, fan, target, declined, quiet] = await Promise.all([
      makeUser("rival"),
      makeUser("fan"),
      makeUser("target"),
      makeUser("declined"),
      makeUser("quiet"),
    ]);

    const activeId = await activeRivalry(me.id, rival.id);
    const quietId = await activeRivalry(quiet.id, me.id);
    const incomingId = await challenge(fan.id, me.id);
    const sentId = await challenge(me.id, target.id);
    const declinedId = await challenge(me.id, declined.id);
    await respondToRivalryRequest(declined.id, declinedId, "decline");

    // Two matches in one active rivalry, none in the other.
    await db.insert(matches).values(
      [1, 2].map((matchNo) => ({
        rivalryId: activeId,
        matchNo,
        source: "import" as const,
        userATeam: "Team A",
        userBTeam: "Team B",
        userAGoals: 2,
        userBGoals: 1,
      })),
    );

    const mine = await getUserRivalries(me.id);

    expect(mine.activeRivalries.map((r) => r.id).sort()).toEqual([activeId, quietId].sort());
    expect(mine.incomingRequests.map((r) => r.id)).toEqual([incomingId]);
    expect(mine.sentRequests.map((r) => r.id)).toEqual([sentId]);

    const active = mine.activeRivalries.find((r) => r.id === activeId)!;
    expect(active.matchCount).toBe(2);
    expect(active.opponent).toEqual({
      id: rival.id,
      username: rival.username,
      displayName: rival.displayName,
      imageUrl: null,
    });
    expect(active.acceptedAt).toBeInstanceOf(Date);
    expect(mine.activeRivalries.find((r) => r.id === quietId)!.matchCount).toBe(0);
    expect(mine.incomingRequests[0].opponent.id).toBe(fan.id);
    expect(mine.incomingRequests[0].matchCount).toBe(0);
    expect(mine.sentRequests[0].opponent.id).toBe(target.id);

    // The same rivalry seen from the other side.
    const theirs = await getUserRivalries(rival.id);
    expect(theirs.activeRivalries).toHaveLength(1);
    expect(theirs.activeRivalries[0]).toMatchObject({ id: activeId, matchCount: 2 });
    expect(theirs.activeRivalries[0].opponent.id).toBe(me.id);
    expect((await getUserRivalries(fan.id)).sentRequests.map((r) => r.id)).toEqual([incomingId]);
    expect((await getUserRivalries(target.id)).incomingRequests.map((r) => r.id)).toEqual([
      sentId,
    ]);
  });
});

describe("rivalry page access", () => {
  it("only members of an ACTIVE rivalry can load it", async () => {
    const [a, b, outsider] = await Promise.all([
      makeUser("page"),
      makeUser("page"),
      makeUser("page"),
    ]);
    const id = await challenge(a.id, b.id);

    // Pending: nobody can open it yet.
    expect(await getRivalryForMember(a.id, id)).toBeNull();
    expect(await isActiveRivalryMember(b.id, id)).toBe(false);

    await respondToRivalryRequest(b.id, id, "accept");

    const forA = await getRivalryForMember(a.id, id);
    expect(forA).toMatchObject({ id, matchCount: 0 });
    expect(forA!.me.username).toBe(a.username);
    expect(forA!.opponent.username).toBe(b.username);

    const forB = await getRivalryForMember(b.id, id);
    expect(forB!.me.username).toBe(b.username);
    expect(forB!.opponent.username).toBe(a.username);

    expect(await isActiveRivalryMember(a.id, id)).toBe(true);
    expect(await getRivalryForMember(outsider.id, id)).toBeNull();
    expect(await isActiveRivalryMember(outsider.id, id)).toBe(false);
    expect(await getRivalryForMember(a.id, "not-a-uuid")).toBeNull();
    expect(await getRivalryForMember(a.id, "11111111-1111-4111-8111-111111111111")).toBeNull();
  });
});
