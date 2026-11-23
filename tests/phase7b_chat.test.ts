// Phase 7B: 1v1 chat access control, "Block Msgs Only (Keep Challenge Open)",
// input and rate-limit enforcement, plain-text rendering. Uses the LOCAL TEST database.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { and, eq, inArray, or } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { dmMessages, messageBlocks, rivalries, users } from "@/db/schema";
import { refreshSessionUser } from "@/lib/auth-helpers";
import { DM_MAX_LENGTH, DM_PAGE_SIZE, cleanMessage, getThread, sendMessage, setMessageBlock } from "@/lib/dm-chat";
import { LIMITS, clearUserRateLimits, consumeRateLimit } from "@/lib/rate-limit";
import { canonicalPair, respondToRivalryRequest, sendRivalryRequest } from "@/lib/rivalry-helpers";

const RUN = `p7b${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
let n = 0;
async function makeUser(label: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db.insert(users).values({ username: `${RUN}_${label}${n++}`.slice(0, 20), displayName: `N ${label}`, updatedAt: new Date(), ...extra }).returning();
  ids.push(row.id);
  return row;
}

afterAll(async () => {
  if (ids.length) {
    await db.delete(rivalries).where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    for (const id of ids) await clearUserRateLimits(id, ["dm", "dm-read", "invite"]);
    await db.delete(users).where(inArray(users.id, ids)); // cascades to messages and blocks
  }
});

describe("1v1 chat access control", () => {
  it("only the two participants ever see a thread; there is no thread id to guess", async () => {
    const [a, b, c] = await Promise.all([makeUser("a"), makeUser("b"), makeUser("c")]);
    expect((await sendMessage(a.id, b.username, "secret between a and b")).ok).toBe(true);

    const bView = await getThread(b.id, a.username);
    expect(bView.ok && bView.thread.messages.map((m) => m.body)).toEqual(["secret between a and b"]);

    // C asking for A's or B's thread only ever gets C's own (empty) thread with them.
    for (const peer of [a, b]) {
      const cView = await getThread(c.id, peer.username);
      expect(cView.ok && cView.thread.messages).toEqual([]);
    }
    // C's message to B lands in the C-B thread, not the A-B thread.
    await sendMessage(c.id, b.username, "from c");
    const abAgain = await getThread(a.id, b.username);
    expect(abAgain.ok && abAgain.thread.messages.map((m) => m.body)).toEqual(["secret between a and b"]);
    const [x, y] = canonicalPair(a.id, b.id);
    const stored = await db.select().from(dmMessages).where(and(eq(dmMessages.userAId, x), eq(dmMessages.userBId, y)));
    expect(stored).toHaveLength(1);

    // Routes take a username (not a thread id) and are guarded by apiUser.
    for (const f of ["src/app/api/chat/[username]/route.ts", "src/app/api/chat/[username]/block/route.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).toContain("apiUser(request");
      expect(src).not.toMatch(/threadId|conversationId/);
    }
  });

  it("refuses unknown, self, suspended and placeholder players with the same generic answer", async () => {
    const me = await makeUser("me");
    const suspended = await makeUser("sus", { suspended: true });
    const ghost = await makeUser("ghost", { isPlaceholder: true });
    for (const target of ["nobody_here_x", me.username, suspended.username, ghost.username, "BAD NAME!", 42]) {
      const t = await getThread(me.id, target);
      const s = await sendMessage(me.id, target, "hi");
      expect(t).toMatchObject({ ok: false, code: "not_found" });
      expect(s).toMatchObject({ ok: false, code: "not_found" });
    }
    expect(await refreshSessionUser(suspended.id)).toBeNull(); // suspended senders fail apiUser
  });

  it("returns at most one page of history, newest kept", async () => {
    const [a, b] = await Promise.all([makeUser("h1"), makeUser("h2")]);
    const [x, y] = canonicalPair(a.id, b.id);
    const base = Date.now() - 100_000;
    await db.insert(dmMessages).values(
      Array.from({ length: DM_PAGE_SIZE + 10 }, (_, i) => ({ userAId: x, userBId: y, senderId: a.id, body: `m${i}`, createdAt: new Date(base + i * 1000) })),
    );
    const t = await getThread(b.id, a.username);
    expect(t.ok && t.thread.messages).toHaveLength(DM_PAGE_SIZE);
    expect(t.ok && t.thread.messages.at(-1)?.body).toBe(`m${DM_PAGE_SIZE + 9}`);
  });
});

describe("Block Msgs Only (Keep Challenge Open)", () => {
  it("blocks and hides messages but leaves match challenges fully open", async () => {
    const [a, b] = await Promise.all([makeUser("ba"), makeUser("bb")]);
    await sendMessage(b.id, a.username, "before block");

    expect(await setMessageBlock(a.id, b.username, true)).toEqual({ ok: true, blocked: true });

    // B can no longer message A (explicit refusal, nothing stored) ...
    const refused = await sendMessage(b.id, a.username, "after block");
    expect(refused).toMatchObject({ ok: false, code: "blocked" });
    // ... and A no longer sees any of B's messages, old or new.
    const aView = await getThread(a.id, b.username);
    expect(aView.ok && aView.thread.iBlockedThem).toBe(true);
    expect(aView.ok && aView.thread.messages).toEqual([]);
    // B still sees their own message and knows messaging is off.
    const bView = await getThread(b.id, a.username);
    expect(bView.ok && bView.thread.theyBlockedMe).toBe(true);
    expect(bView.ok && bView.thread.messages.map((m) => m.body)).toEqual(["before block"]);

    // Challenges stay open in BOTH directions while the block is on.
    const sent = await sendRivalryRequest(b.id, a.id);
    expect(sent.ok).toBe(true);
    if (sent.ok) {
      const accepted = await respondToRivalryRequest(a.id, sent.rivalryId, "accept");
      expect(accepted.ok).toBe(true);
    }
    const [x, y] = canonicalPair(a.id, b.id);
    const [r] = await db.select().from(rivalries).where(and(eq(rivalries.userAId, x), eq(rivalries.userBId, y)));
    expect(r.status).toBe("active");

    // Unblocking restores the conversation (and B's old message reappears).
    await setMessageBlock(a.id, b.username, false);
    expect((await sendMessage(b.id, a.username, "friends again")).ok).toBe(true);
    const again = await getThread(a.id, b.username);
    expect(again.ok && again.thread.messages.map((m) => m.body)).toEqual(["before block", "friends again"]);
  });

  it("is isolated: challenge/rivalry/match code never reads message_blocks or chat", () => {
    for (const f of ["src/lib/rivalry-helpers.ts", "src/lib/rivalry-actions.ts", "src/lib/match-helpers.ts", "src/lib/match-actions.ts"]) {
      const src = readFileSync(f, "utf8");
      expect(src).not.toMatch(/messageBlocks|message_blocks|dm-chat|dmMessages/);
    }
  });

  it("block rows are per direction, idempotent and cascade with the user", async () => {
    const [a, b] = await Promise.all([makeUser("ca"), makeUser("cb")]);
    await setMessageBlock(a.id, b.username, true);
    await setMessageBlock(a.id, b.username, true); // idempotent
    expect(await db.select().from(messageBlocks).where(eq(messageBlocks.blockerId, a.id))).toHaveLength(1);
    expect(await db.select().from(messageBlocks).where(eq(messageBlocks.blockerId, b.id))).toHaveLength(0);
    await sendMessage(a.id, b.username, "x").catch(() => null);
    await db.delete(users).where(eq(users.id, a.id));
    expect(await db.select().from(messageBlocks).where(eq(messageBlocks.blockedId, b.id))).toHaveLength(0);
  });
});

describe("input validation, rate limits and plain-text rendering", () => {
  it("validates and cleans bodies", async () => {
    const [a, b] = await Promise.all([makeUser("va"), makeUser("vb")]);
    expect(await sendMessage(a.id, b.username, "   ")).toMatchObject({ ok: false, code: "invalid" });
    expect(await sendMessage(a.id, b.username, "x".repeat(DM_MAX_LENGTH + 1))).toMatchObject({ ok: false, code: "invalid" });
    expect(await sendMessage(a.id, b.username, { evil: true })).toMatchObject({ ok: false, code: "invalid" });
    expect(cleanMessage("hi\u0000‮ there​\n\n\n\nok")).toBe("hi there\n\nok");
    const ok = await sendMessage(a.id, b.username, "  gg‮  wp  ");
    expect(ok.ok && ok.message.body).toBe("gg wp");
  });

  it("rate limits per user (and per IP) once the window is full", async () => {
    const [a, b] = await Promise.all([makeUser("ra"), makeUser("rb")]);
    for (let i = 0; i < LIMITS.dmUser.max; i++) expect((await sendMessage(a.id, b.username, `m${i}`)).ok).toBe(true);
    expect(await sendMessage(a.id, b.username, "one too many")).toMatchObject({ ok: false, code: "rate_limited" });
    // A different user is unaffected; the IP bucket also bites.
    const c = await makeUser("rc");
    const ip = `203.0.113.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < LIMITS.dmIp.max; i++) await consumeRateLimit(`dm-ip:${ip}`, LIMITS.dmIp.max, LIMITS.dmIp.windowMinutes);
    expect(await sendMessage(c.id, b.username, "hi", ip)).toMatchObject({ ok: false, code: "rate_limited" });
    expect((await sendMessage(c.id, b.username, "hi")).ok).toBe(true);
  });

  it("renders message text as escaped text, never as HTML", () => {
    const evil = `<img src=x onerror=alert(1)><script>alert(2)</script>`;
    expect(cleanMessage(evil)).toBe(evil); // stored as plain text, not stripped into something odd
    const html = renderToStaticMarkup(createElement("p", null, evil));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
    for (const f of ["src/components/chat/dm-chat.tsx", "src/app/chat/[username]/page.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
  });
});
