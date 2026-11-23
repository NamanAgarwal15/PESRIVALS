// Phase 7C: global lobby chat, deterministic filter, reporting + admin moderation.
// Uses the LOCAL TEST database. No network, no LLM. Audit rows are only ever read here
// (admin_audit_logs is append-only; the actor FK is set-null when a test user is removed).
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { eq, inArray } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { adminAuditLogs, chatReports, globalChatMessages, users } from "@/db/schema";
import { getChatReports, resolveChatReport, setGlobalMessageHidden } from "@/lib/admin-chat";
import { refreshSessionUser } from "@/lib/auth-helpers";
import { checkChatText, normalizeChatText } from "@/lib/chat-filter";
import { sendMessage, setMessageBlock } from "@/lib/dm-chat";
import {
  GLOBAL_PAGE_SIZE, getGlobalMessages, pruneGlobalChat, reportDmMessage, reportGlobalMessage, sendGlobalMessage,
} from "@/lib/global-chat";
import { LIMITS, clearUserRateLimits, consumeRateLimit } from "@/lib/rate-limit";

const RUN = `p7c${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
let n = 0;
async function makeUser(label: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db.insert(users).values({ username: `${RUN}_${label}${n++}`.slice(0, 20), displayName: `N ${label}`, updatedAt: new Date(), ...extra }).returning();
  ids.push(row.id);
  return row;
}

afterAll(async () => {
  if (ids.length) {
    for (const id of ids) await clearUserRateLimits(id, ["gc", "gc-read", "gc-strike", "report", "dm"]);
    await db.delete(users).where(inArray(users.id, ids)); // cascades to messages, reports and blocks
  }
});

describe("deterministic filter (no LLM, no network)", () => {
  const blocked = (t: string, reason?: string) => {
    const r = checkChatText(t);
    expect(r.ok, t).toBe(false);
    if (!r.ok && reason) expect(r.reason, t).toBe(reason);
  };
  it("normalizes unicode, zero-width and bidi tricks", () => {
    expect(normalizeChatText("ｇｇ​ ‮wp\u0000  ")).toBe("gg wp");
    expect(normalizeChatText("ﬁnal")).toBe("final");
  });
  it("blocks profanity including evasions", () => {
    for (const t of ["fuck you", "f u c k", "f.u.c.k off", "fuuuuck", "ｆｕｃｋ", "sh1t", "b!tch", "FUCK", "motherfucker", "fuсk"]) blocked(t, "profanity");
  });
  it("blocks harassment phrases", () => {
    blocked("go kill yourself", "harassment");
    blocked("k i l l  y o u r s e l f", "harassment");
  });
  it("blocks links in every common shape", () => {
    for (const t of ["see http://evil.example/x", "https://x.io", "www.bad.com", "join discord.gg/abc", "bit.ly/x", "evil[.]com", "evil (dot) com", "evil dot com", "1.2.3.4", "t.me/scam"]) blocked(t, "link");
  });
  it("blocks floods and duplicate bursts, but allows normal banter", () => {
    blocked("aaaaaaaaaaaaaaaa", "flood");
    blocked("buy buy buy buy buy buy buy", "flood");
    blocked("xyxyxyxyxyxyxyxyxy", "flood");
    expect(checkChatText("good game!", ["Good  GAME!"])).toMatchObject({ ok: false, reason: "duplicate" });
    for (const t of ["gg wp", "Great match, rematch tonight?", "Nigeria vs Brazil tonight", "class assignment done", "Scunthorpe fan here", "I scored 3.5 goals avg", "see you at 9.30"]) {
      expect(checkChatText(t), t).toMatchObject({ ok: true });
    }
    expect(checkChatText("")).toMatchObject({ ok: false, reason: "empty" });
    expect(checkChatText("x ".repeat(200))).toMatchObject({ ok: false, reason: "too_long" });
    expect(checkChatText(42)).toMatchObject({ ok: false });
  });
  it("is pure: moderation code never reaches a network or LLM client", () => {
    expect(readFileSync("src/lib/chat-filter.ts", "utf8")).not.toMatch(/^import /m);
    for (const f of ["src/lib/chat-filter.ts", "src/lib/global-chat.ts", "src/lib/admin-chat.ts", "src/app/api/chat/global/route.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/gemini|generativelanguage|fetch\(/i);
    }
  });
});

describe("global send / read", () => {
  it("stores clean messages, refuses filtered ones without storing, and strikes lead to a cool-off", async () => {
    const a = await makeUser("a");
    const ok = await sendGlobalMessage(a.id, "  gg   wp  ");
    expect(ok.ok && ok.message.body).toBe("gg wp");
    const count = async () => (await db.select().from(globalChatMessages).where(eq(globalChatMessages.senderId, a.id))).length;
    const before = await count();
    for (const bad of ["fuck this", "http://x.com", "aaaaaaaaaaaaaaaaaa"]) {
      expect(await sendGlobalMessage(a.id, bad)).toMatchObject({ ok: false, code: "filtered" });
    }
    expect(await count()).toBe(before);
    await sendGlobalMessage(a.id, "shit");
    await sendGlobalMessage(a.id, "shit");
    expect(await sendGlobalMessage(a.id, "hello again")).toMatchObject({ ok: false, code: "rate_limited" });
    const b = await makeUser("b");
    expect((await sendGlobalMessage(b.id, "same thing")).ok).toBe(true);
    expect(await sendGlobalMessage(b.id, "Same  thing!")).toMatchObject({ ok: false, code: "filtered" });
  });

  it("rate limits per user and per IP", async () => {
    const a = await makeUser("ra");
    for (let i = 0; i < LIMITS.globalUser.max; i++) expect((await sendGlobalMessage(a.id, `message number ${i} here`)).ok).toBe(true);
    expect(await sendGlobalMessage(a.id, "one more please")).toMatchObject({ ok: false, code: "rate_limited" });
    const c = await makeUser("rc");
    const ip = `198.51.100.${Math.floor(Math.random() * 200)}`;
    for (let i = 0; i < LIMITS.globalIp.max; i++) await consumeRateLimit(`gc-ip:${ip}`, LIMITS.globalIp.max, LIMITS.globalIp.windowMinutes);
    expect(await sendGlobalMessage(c.id, "from a busy ip", ip)).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("serves at most one page and excludes hidden, expired and suspended-sender rows", async () => {
    const [viewer, talker, sus] = await Promise.all([makeUser("v"), makeUser("t"), makeUser("s")]);
    const base = Date.now() - 60_000;
    await db.insert(globalChatMessages).values(
      Array.from({ length: GLOBAL_PAGE_SIZE + 5 }, (_, i) => ({ senderId: talker.id, body: `${RUN} m${i}`, createdAt: new Date(base + i * 100) })),
    );
    await db.insert(globalChatMessages).values({ senderId: talker.id, body: `${RUN} hidden one`, hidden: true });
    await db.insert(globalChatMessages).values({ senderId: talker.id, body: `${RUN} expired`, createdAt: new Date(Date.now() - 80 * 3_600_000) });
    await db.insert(globalChatMessages).values({ senderId: sus.id, body: `${RUN} from suspended` });
    await db.update(users).set({ suspended: true }).where(eq(users.id, sus.id));

    const list = await getGlobalMessages(viewer.id);
    expect(list.length).toBeLessThanOrEqual(GLOBAL_PAGE_SIZE);
    const mine = list.filter((m) => m.body.startsWith(RUN));
    expect(mine.length).toBeGreaterThan(0);
    for (const word of ["hidden one", "expired", "from suspended"]) expect(mine.some((m) => m.body.includes(word))).toBe(false);
  });

  it("hides a blocked player's lobby messages from the blocker only, and never touches challenges", async () => {
    const [a, b, c] = await Promise.all([makeUser("ba"), makeUser("bb"), makeUser("bc")]);
    await sendGlobalMessage(b.id, `${RUN} from b to everyone`);
    expect((await getGlobalMessages(a.id)).some((m) => m.username === b.username)).toBe(true);
    await setMessageBlock(a.id, b.username, true);
    expect((await getGlobalMessages(a.id)).some((m) => m.username === b.username)).toBe(false);
    expect((await getGlobalMessages(c.id)).some((m) => m.username === b.username)).toBe(true);
    expect((await getGlobalMessages(b.id)).some((m) => m.mine)).toBe(true);
    for (const f of ["src/lib/rivalry-helpers.ts", "src/lib/rivalry-actions.ts", "src/lib/match-helpers.ts"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/global-chat|globalChatMessages|messageBlocks/);
    }
  });

  it("requires an existing, non-suspended account (apiUser) on every route", async () => {
    const sus = await makeUser("susp", { suspended: true });
    expect(await refreshSessionUser(sus.id)).toBeNull();
    for (const f of ["src/app/api/chat/global/route.ts", "src/app/api/chat/global/report/route.ts", "src/app/api/chat/[username]/report/route.ts"]) {
      expect(readFileSync(f, "utf8")).toContain("apiUser(request");
    }
    expect(readFileSync("src/app/lobby/page.tsx", "utf8")).toContain('redirect("/login")');
  });
});

describe("reporting and admin moderation", () => {
  it("creates one report per reporter per message, validates input, and rejects self-reports", async () => {
    const [sender, reporter] = await Promise.all([makeUser("rs"), makeUser("rr")]);
    const sent = await sendGlobalMessage(sender.id, "a perfectly fine message");
    if (!sent.ok) throw new Error("setup");
    const id = sent.message.id;
    expect(await reportGlobalMessage(reporter.id, { messageId: id, reason: "spam" })).toEqual({ ok: true });
    expect(await reportGlobalMessage(reporter.id, { messageId: id, reason: "hate" })).toEqual({ ok: true }); // idempotent
    expect(await db.select().from(chatReports).where(eq(chatReports.globalMessageId, id))).toHaveLength(1);
    expect(await reportGlobalMessage(reporter.id, { messageId: id, reason: "nope" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await reportGlobalMessage(reporter.id, { messageId: "not-a-uuid", reason: "spam" })).toMatchObject({ ok: false });
    expect(await reportGlobalMessage(reporter.id, { messageId: crypto.randomUUID(), reason: "spam" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await reportGlobalMessage(sender.id, { messageId: id, reason: "spam" })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("rate limits report spam", async () => {
    const [s, r] = await Promise.all([makeUser("ps"), makeUser("pr")]);
    const rows = await db.insert(globalChatMessages).values(Array.from({ length: LIMITS.reportUser.max + 1 }, (_, i) => ({ senderId: s.id, body: `${RUN} r${i}` }))).returning();
    for (let i = 0; i < LIMITS.reportUser.max; i++) expect((await reportGlobalMessage(r.id, { messageId: rows[i].id, reason: "spam" })).ok).toBe(true);
    expect(await reportGlobalMessage(r.id, { messageId: rows[LIMITS.reportUser.max].id, reason: "spam" })).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("reports 1v1 messages only from the other participant's thread", async () => {
    const [a, b, c] = await Promise.all([makeUser("da"), makeUser("db"), makeUser("dc")]);
    const sent = await sendMessage(b.id, a.username, "private rude thing");
    if (!sent.ok) throw new Error("setup");
    expect(await reportDmMessage(a.id, b.username, { messageId: sent.message.id, reason: "harassment" })).toEqual({ ok: true });
    expect(await reportDmMessage(c.id, b.username, { messageId: sent.message.id, reason: "spam" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await reportDmMessage(c.id, a.username, { messageId: sent.message.id, reason: "spam" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await reportDmMessage(b.id, a.username, { messageId: sent.message.id, reason: "spam" })).toMatchObject({ ok: false, code: "not_found" });
    expect(await db.select().from(chatReports).where(eq(chatReports.dmMessageId, sent.message.id))).toHaveLength(1);
  });

  it("only admins can view the queue or hide messages; hide and resolve are audited", async () => {
    const [admin, user, sender, reporter] = await Promise.all([makeUser("adm", { role: "admin" }), makeUser("usr"), makeUser("snd"), makeUser("rep")]);
    const sent = await sendGlobalMessage(sender.id, "borderline but reported message");
    if (!sent.ok) throw new Error("setup");
    await reportGlobalMessage(reporter.id, { messageId: sent.message.id, reason: "harassment" });

    expect(await getChatReports(user.id)).toEqual({ ok: false, error: "Forbidden" });
    expect(await setGlobalMessageHidden(user.id, sent.message.id, true)).toEqual({ ok: false, error: "Forbidden" });
    const [still] = await db.select().from(globalChatMessages).where(eq(globalChatMessages.id, sent.message.id));
    expect(still.hidden).toBe(false);

    const queue = await getChatReports(admin.id);
    expect(queue.ok && queue.rows.some((r) => r.messageId === sent.message.id && r.body === "borderline but reported message")).toBe(true);

    expect(await setGlobalMessageHidden(admin.id, sent.message.id, true)).toEqual({ ok: true });
    const [hidden] = await db.select().from(globalChatMessages).where(eq(globalChatMessages.id, sent.message.id));
    expect(hidden.hidden).toBe(true);
    expect((await getGlobalMessages(user.id)).some((m) => m.id === sent.message.id)).toBe(false);
    const [report] = await db.select().from(chatReports).where(eq(chatReports.globalMessageId, sent.message.id));
    expect(report.status).toBe("reviewed");

    expect(await setGlobalMessageHidden(admin.id, sent.message.id, false)).toEqual({ ok: true });
    expect(await resolveChatReport(admin.id, report.id, "dismissed")).toEqual({ ok: true });
    expect(await resolveChatReport(user.id, report.id, "reviewed")).toEqual({ ok: false, error: "Forbidden" });

    const audit = await db.select({ action: adminAuditLogs.action }).from(adminAuditLogs).where(eq(adminAuditLogs.actorUserId, admin.id));
    const actions = audit.map((a) => a.action);
    for (const a of ["chat.reports_viewed", "chat.hide_message", "chat.unhide_message", "chat.report_dismissed"]) expect(actions).toContain(a);

    const actionsSrc = readFileSync("src/lib/admin-actions.ts", "utf8");
    expect(actionsSrc).toMatch(/adminHideChatMessageAction[\s\S]*?requireAdmin\(\)/);
    expect(actionsSrc).toMatch(/adminResolveChatReportAction[\s\S]*?requireAdmin\(\)/);
    expect(readFileSync("src/app/admin/page.tsx", "utf8")).toContain("isAdminUser(adminId)");
  });

  it("prunes expired lobby rows but keeps ones under an open report", async () => {
    const [s, r] = await Promise.all([makeUser("pru"), makeUser("prr")]);
    const old = new Date(Date.now() - 100 * 3_600_000);
    const [gone, kept] = await db.insert(globalChatMessages).values([{ senderId: s.id, body: "old unreported", createdAt: old }, { senderId: s.id, body: "old reported", createdAt: old }]).returning();
    await db.insert(chatReports).values({ reporterId: r.id, reportedUserId: s.id, globalMessageId: kept.id, reason: "spam" });
    await pruneGlobalChat();
    expect(await db.select().from(globalChatMessages).where(eq(globalChatMessages.id, gone.id))).toHaveLength(0);
    expect(await db.select().from(globalChatMessages).where(eq(globalChatMessages.id, kept.id))).toHaveLength(1);
  });
});

describe("plain-text rendering", () => {
  it("renders hostile text as escaped text and never uses raw HTML", () => {
    const evil = `<img src=x onerror=alert(1)><script>alert(2)</script>`;
    const html = renderToStaticMarkup(createElement("p", null, evil));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    for (const f of ["src/components/chat/lobby-chat.tsx", "src/components/chat/dm-chat.tsx", "src/components/admin/chat-report-queue.tsx"]) {
      expect(readFileSync(f, "utf8")).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
    }
  });
});
