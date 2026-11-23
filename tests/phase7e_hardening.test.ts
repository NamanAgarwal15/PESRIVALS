// Phase 7E: hardening sweep. Decode concurrency cap, chat-only mute, DM filter + retention,
// clan chat reports, admin clan-war re-open, start-rivalry data, and a static OWASP audit of the routes.
// Uses the LOCAL TEST database. No network, no LLM. admin_audit_logs is only ever read.
import { randomBytes } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import sharp from "sharp";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import {
  adminAuditLogs, chatReports, clanChatMessages, clanChatReports, clanMembers, clanWars, clans, dmMessages, rateLimits, rivalries, users,
} from "@/db/schema";
import { getChatReports, getCompletedWars, reopenClanWar, resolveChatReport, setChatMute, setClanMessageHidden } from "@/lib/admin-chat";
import { isChatMuted } from "@/lib/chat-mute";
import { createClanWar, getClanWars, respondToClanWar, settleWarPairings } from "@/lib/clan-wars";
import { createClan, getClanMessages, pruneClanChat, sendClanMessage } from "@/lib/clans";
import { DM_RETENTION_DAYS, getThread, pruneDmMessages, sendMessage } from "@/lib/dm-chat";
import { extractMatchFromScreenshot } from "@/lib/gemini-extract";
import { reportClanMessage, reportDmMessage, reportGlobalMessage, sendGlobalMessage } from "@/lib/global-chat";
import { disputeMatch, saveMatchForUser } from "@/lib/match-helpers";
import type { ExtractedSide } from "@/lib/match-schema";
import { MAX_CONCURRENT_DECODES, decodeStats, resetDecodePeak, tryAcquireDecodeSlot } from "@/lib/ocr/limiter";
import { extractLocally } from "@/lib/ocr/local-extract";
import { canonicalPair, respondToRivalryRequest, sendRivalryRequest } from "@/lib/rivalry-helpers";

const RUN = `p7e${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
let n = 0;
let tagCounter = 0;
const tagN = () => `${RUN.slice(-3)}${(tagCounter++).toString(36).padStart(3, "0")}`.toUpperCase();
const uniq = (label: string) => `${label} ${RUN} ${n++}`.slice(0, 40);

async function makeUser(label: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db.insert(users).values({ username: `${RUN}_${n++}${label}`.toLowerCase().slice(0, 20), displayName: `N ${label}`, updatedAt: new Date(), ...extra }).returning();
  ids.push(row.id);
  return row;
}
async function makeClan(label: string, extra = 0) {
  const leader = await makeUser(`${label}l`);
  const tag = tagN();
  const res = await createClan(leader.id, { name: uniq(label), tag });
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
async function playMatch(me: { id: string }, rivalryId: string, mine: number, theirs: number) {
  const res = await saveMatchForUser(me.id, {
    rivalryId, mySide: "left", host: "home",
    extracted: { left: { ...SIDE, goals: mine, shots: Math.max(5, mine), shots_on_target: Math.max(3, mine) }, right: { ...SIDE, team: "B", goals: theirs, shots: Math.max(5, theirs), shots_on_target: Math.max(3, theirs) } },
  });
  if (!res.ok) throw new Error(res.error);
  return res.matchId;
}
const auditActions = async (actorId: string) => (await db.select({ a: adminAuditLogs.action }).from(adminAuditLogs).where(eq(adminAuditLogs.actorUserId, actorId))).map((r) => r.a);

afterAll(async () => {
  if (ids.length) {
    await db.delete(rivalries).where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    await db.delete(rateLimits).where(sql`split_part(${rateLimits.key}, ':', 2) IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`);
    await db.delete(users).where(inArray(users.id, ids));
  }
}, 120_000);

describe("A10: sharp decode concurrency cap", () => {
  const blank = async () => new Uint8Array(await sharp({ create: { width: 1280, height: 720, channels: 3, background: "#222" } }).png().toBuffer());
  beforeEach(() => vi.stubEnv("GEMINI_API_KEY_1", "test-key-1-not-real"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("hands out at most MAX slots and releases exactly once", () => {
    expect(MAX_CONCURRENT_DECODES).toBe(3);
    const held = Array.from({ length: MAX_CONCURRENT_DECODES }, () => tryAcquireDecodeSlot());
    expect(held.every(Boolean)).toBe(true);
    expect(tryAcquireDecodeSlot()).toBeNull();
    held[0]!();
    held[0]!(); // double release is a no-op
    const again = tryAcquireDecodeSlot();
    expect(again).not.toBeNull();
    expect(tryAcquireDecodeSlot()).toBeNull();
    for (const r of [...held.slice(1), again]) r!();
    expect(decodeStats().active).toBe(0);
  });

  it("never runs more than the cap in parallel and reports busy instead of queueing", async () => {
    const png = await blank();
    resetDecodePeak();
    const results = await Promise.all(Array.from({ length: 6 }, () => extractLocally(png)));
    const busy = results.filter((r) => !r.ok && r.reason === "busy");
    expect(busy).toHaveLength(6 - MAX_CONCURRENT_DECODES);
    expect(decodeStats().peak).toBeLessThanOrEqual(MAX_CONCURRENT_DECODES);
    expect(decodeStats().active).toBe(0); // every slot was released, even for failed decodes
  });

  it("falls back to Gemini (one request, no crash) while overloaded", async () => {
    vi.stubEnv("LOCAL_OCR", "on");
    const payload = { candidates: [{ content: { parts: [{ text: JSON.stringify({ is_valid_efootball_stats_screen: false, rejection_reason: "test", left: null, right: null }) }] } }] };
    const spy = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }) as unknown as Response);
    vi.stubGlobal("fetch", spy);
    const held = Array.from({ length: MAX_CONCURRENT_DECODES }, () => tryAcquireDecodeSlot());
    const r = await extractMatchFromScreenshot({ bytes: await blank() });
    for (const h of held) h!();
    expect(spy).toHaveBeenCalledTimes(1); // fallback path, not an error
    expect(r.ok).toBe(false);
  });
});

describe("chat-only mute", () => {
  it("blocks sending in DM, lobby and clan chat, but not challenges, matches, reading or reporting", async () => {
    const admin = await makeUser("adm", { role: "admin" });
    const muted = await makeUser("mut");
    const other = await makeUser("oth");
    const C = await makeClan("mc", 1);
    await db.insert(clanMembers).values({ clanId: C.clan.id, userId: muted.id, role: "member" });
    const lobbyMsg = await sendGlobalMessage(other.id, "hello from a normal player");
    const dmFromOther = await sendMessage(other.id, muted.username, "hi there friend");
    if (!lobbyMsg.ok || !dmFromOther.ok) throw new Error("setup");

    expect(await setChatMute(admin.id, muted.id, "24h")).toMatchObject({ ok: true });
    expect(await isChatMuted(muted.id)).toBe(true);
    expect(await sendMessage(muted.id, other.username, "can you hear me")).toMatchObject({ ok: false, code: "muted" });
    expect(await sendGlobalMessage(muted.id, "can you hear me")).toMatchObject({ ok: false, code: "muted" });
    expect(await sendClanMessage(muted.id, C.tag, "can you hear me")).toMatchObject({ ok: false, code: "muted" });
    expect(await db.select().from(dmMessages).where(eq(dmMessages.senderId, muted.id))).toHaveLength(0);

    // Everything that is not sending chat keeps working.
    expect((await getThread(muted.id, other.username)).ok).toBe(true);
    expect((await getClanMessages(muted.id, C.tag)).ok).toBe(true);
    expect(await reportGlobalMessage(muted.id, { messageId: lobbyMsg.message.id, reason: "spam" })).toEqual({ ok: true });
    expect(await reportDmMessage(muted.id, other.username, { messageId: dmFromOther.message.id, reason: "spam" })).toEqual({ ok: true });
    const sent = await sendRivalryRequest(muted.id, other.id);
    expect(sent.ok).toBe(true);
    if (sent.ok) expect((await respondToRivalryRequest(other.id, sent.rivalryId, "accept")).ok).toBe(true);
    const [x, y] = canonicalPair(muted.id, other.id);
    const [rv] = await db.select().from(rivalries).where(and(eq(rivalries.userAId, x), eq(rivalries.userBId, y)));
    expect(rv.status).toBe("active");
    await playMatch(muted, rv.id, 2, 1); // match upload still works

    // Unmute restores sending; an expired mute is not a mute; "permanent" is far in the future.
    expect(await setChatMute(admin.id, muted.id, "unmute")).toMatchObject({ ok: true, until: null });
    expect((await sendMessage(muted.id, other.username, "back again")).ok).toBe(true);
    await db.update(users).set({ chatMutedUntil: new Date(Date.now() - 1000) }).where(eq(users.id, muted.id));
    expect(await isChatMuted(muted.id)).toBe(false);
    const perm = await setChatMute(admin.id, muted.id, "permanent");
    expect(perm.ok && perm.until && perm.until.getFullYear()).toBe(2100);
    expect(await isChatMuted(muted.id)).toBe(true);
    const actions = await auditActions(admin.id);
    expect(actions).toContain("user.chat_mute");
    expect(actions).toContain("user.chat_unmute");
  });

  it("is admin-only, validated, and never self-applied", async () => {
    const [admin, user, target] = await Promise.all([makeUser("adm2", { role: "admin" }), makeUser("usr"), makeUser("tgt")]);
    const suspendedAdmin = await makeUser("sadm", { role: "admin", suspended: true });
    expect(await setChatMute(user.id, target.id, "24h")).toEqual({ ok: false, error: "Forbidden" });
    expect(await setChatMute(suspendedAdmin.id, target.id, "24h")).toEqual({ ok: false, error: "Forbidden" });
    expect(await isChatMuted(target.id)).toBe(false);
    expect(await setChatMute(admin.id, target.id, "forever")).toMatchObject({ ok: false });
    expect(await setChatMute(admin.id, "not-a-uuid", "24h")).toMatchObject({ ok: false });
    expect(await setChatMute(admin.id, admin.id, "24h")).toMatchObject({ ok: false });
    expect(await setChatMute(admin.id, crypto.randomUUID(), "24h")).toMatchObject({ ok: false, error: "User not found" });
    expect(readFileSync("src/lib/admin-actions.ts", "utf8")).toMatch(/adminSetChatMuteAction[\s\S]*?requireAdmin\(\)/);
  });
});

describe("1v1 DM filter parity and retention", () => {
  it("applies the lobby filter to DMs (links, abuse, floods, duplicates) and keeps normal chat intact", async () => {
    const [a, b] = await Promise.all([makeUser("dma"), makeUser("dmb")]);
    for (const bad of ["click http://evil.example/win", "free skins at discord.gg/abc", "fuck you", "aaaaaaaaaaaaaaaaaa"]) {
      expect(await sendMessage(a.id, b.username, bad), bad).toMatchObject({ ok: false, code: "filtered" });
    }
    expect(await db.select().from(dmMessages).where(eq(dmMessages.senderId, a.id))).toHaveLength(0);
    // Strike cool-off after 5 blocked messages, even for clean text.
    await sendMessage(a.id, b.username, "shit");
    expect(await sendMessage(a.id, b.username, "all good now")).toMatchObject({ ok: false, code: "rate_limited" });

    const c = await makeUser("dmc");
    const long = Array.from({ length: 90 }, (_, i) => `w${i}`).join(" ").slice(0, 480); // above the lobby's 300, within the DM's 500
    expect((await sendMessage(c.id, b.username, long)).ok).toBe(true);
    const multi = await sendMessage(c.id, b.username, "line one\nline two");
    expect(multi.ok && multi.message.body).toBe("line one\nline two"); // stored text keeps line breaks
    expect(await sendMessage(c.id, b.username, "Line  one\nline two!")).toMatchObject({ ok: false, code: "filtered" }); // duplicate burst
    expect(await sendMessage(c.id, b.username, "x".repeat(501))).toMatchObject({ ok: false, code: "invalid" });
  });

  it("prunes DMs older than the retention window but keeps recent ones and ones under an open report", async () => {
    const [a, b] = await Promise.all([makeUser("pra"), makeUser("prb")]);
    const [x, y] = canonicalPair(a.id, b.id);
    const old = new Date(Date.now() - (DM_RETENTION_DAYS + 2) * 86_400_000);
    const [gone, kept, fresh] = await db
      .insert(dmMessages)
      .values([
        { userAId: x, userBId: y, senderId: a.id, body: "old unreported", createdAt: old },
        { userAId: x, userBId: y, senderId: a.id, body: "old reported", createdAt: old },
        { userAId: x, userBId: y, senderId: a.id, body: "recent" },
      ])
      .returning();
    await db.insert(chatReports).values({ reporterId: b.id, reportedUserId: a.id, dmMessageId: kept.id, reason: "spam" });
    await pruneDmMessages();
    const left = (await db.select({ id: dmMessages.id }).from(dmMessages).where(inArray(dmMessages.id, [gone.id, kept.id, fresh.id]))).map((r) => r.id);
    expect(left.sort()).toEqual([kept.id, fresh.id].sort());
    expect(readFileSync("src/app/api/chat/[username]/route.ts", "utf8")).toContain("maybePruneDmMessages");
  });
});

describe("clan chat reports and admin moderation", () => {
  it("lets members report other members' messages only, idempotently", async () => {
    const A = await makeClan("rca", 2);
    const B = await makeClan("rcb", 1);
    const sent = await sendClanMessage(A.members[0].id, A.tag, "a message worth reporting");
    if (!sent.ok) throw new Error("setup");
    const id = sent.message.id;
    expect(await reportClanMessage(A.members[1].id, A.tag, { messageId: id, reason: "harassment" })).toEqual({ ok: true });
    expect(await reportClanMessage(A.members[1].id, A.tag, { messageId: id, reason: "spam" })).toEqual({ ok: true });
    expect(await db.select().from(clanChatReports).where(eq(clanChatReports.clanMessageId, id))).toHaveLength(1);
    expect(await reportClanMessage(A.members[0].id, A.tag, { messageId: id, reason: "spam" })).toMatchObject({ ok: false, code: "invalid" }); // own message
    expect(await reportClanMessage(B.leader.id, A.tag, { messageId: id, reason: "spam" })).toMatchObject({ ok: false, code: "not_found" }); // other clan
    expect(await reportClanMessage(B.leader.id, B.tag, { messageId: id, reason: "spam" })).toMatchObject({ ok: false, code: "not_found" }); // wrong clan's message
    expect(await reportClanMessage(A.members[1].id, A.tag, { messageId: id, reason: "nope" })).toMatchObject({ ok: false, code: "invalid" });
    expect(await reportClanMessage((await makeUser("nobody")).id, A.tag, { messageId: id, reason: "spam" })).toMatchObject({ ok: false, code: "not_found" });
  });

  it("shows clan reports to admins only, hides messages with an audit trail, and keeps reported messages through pruning", async () => {
    const [admin, user] = await Promise.all([makeUser("adm3", { role: "admin" }), makeUser("usr3")]);
    const A = await makeClan("rcc", 2);
    const sent = await sendClanMessage(A.members[0].id, A.tag, "borderline clan message");
    if (!sent.ok) throw new Error("setup");
    await reportClanMessage(A.members[1].id, A.tag, { messageId: sent.message.id, reason: "other" });

    expect(await getChatReports(user.id)).toEqual({ ok: false, error: "Forbidden" });
    expect(await setClanMessageHidden(user.id, sent.message.id, true)).toEqual({ ok: false, error: "Forbidden" });
    const queue = await getChatReports(admin.id);
    const row = queue.ok ? queue.rows.find((r) => r.messageId === sent.message.id) : undefined;
    expect(row).toMatchObject({ kind: "clan", body: "borderline clan message", reported: A.members[0].username });

    // An old message under an open report survives pruning; an old unreported one does not.
    const old = new Date(Date.now() - 20 * 86_400_000);
    const [oldReported, oldPlain] = await db
      .insert(clanChatMessages)
      .values([{ clanId: A.clan.id, senderId: A.members[0].id, body: "old reported", createdAt: old }, { clanId: A.clan.id, senderId: A.members[0].id, body: "old plain", createdAt: old }])
      .returning();
    await db.insert(clanChatReports).values({ reporterId: A.members[1].id, reportedUserId: A.members[0].id, clanMessageId: oldReported.id, reason: "spam" });
    await pruneClanChat();
    expect(await db.select().from(clanChatMessages).where(eq(clanChatMessages.id, oldReported.id))).toHaveLength(1);
    expect(await db.select().from(clanChatMessages).where(eq(clanChatMessages.id, oldPlain.id))).toHaveLength(0);

    expect(await setClanMessageHidden(admin.id, sent.message.id, true)).toEqual({ ok: true });
    const seen = await getClanMessages(A.leader.id, A.tag);
    expect(seen.ok && seen.messages.some((m) => m.id === sent.message.id)).toBe(false); // hidden for everyone
    const [rep] = await db.select().from(clanChatReports).where(eq(clanChatReports.clanMessageId, sent.message.id));
    expect(rep.status).toBe("reviewed");
    expect(await setClanMessageHidden(admin.id, sent.message.id, false)).toEqual({ ok: true });

    const [open] = await db.select().from(clanChatReports).where(eq(clanChatReports.clanMessageId, oldReported.id));
    expect(await resolveChatReport(user.id, open.id, "dismissed")).toEqual({ ok: false, error: "Forbidden" });
    expect(await resolveChatReport(admin.id, open.id, "dismissed")).toEqual({ ok: true });
    const actions = await auditActions(admin.id);
    for (const a of ["chat.reports_viewed", "chat.hide_clan_message", "chat.unhide_clan_message", "chat.report_dismissed"]) expect(actions).toContain(a);
    expect(readFileSync("src/lib/admin-actions.ts", "utf8")).toMatch(/adminHideChatMessageAction[\s\S]*?requireAdmin\(\)/);
  });
});

describe("clan wars: admin re-open and start-rivalry data", () => {
  async function completedWar() {
    const A = await makeClan("wra", 3);
    const B = await makeClan("wrb", 3);
    const aPlayers = [A.leader, ...A.members].slice(0, 3);
    const bPlayers = [B.leader, ...B.members].slice(0, 3);
    const created = await createClanWar(A.leader.id, { defenderTag: B.tag, seriesSize: 3, pairings: aPlayers.map((p, i) => ({ mine: p.username, theirs: bPlayers[i].username })) });
    if (!created.ok) throw new Error(created.error);
    // Before any rivalry exists, the pairing data says so.
    const before = await getClanWars(A.clan.id, "leader");
    expect(before[0].pairings.every((p) => p.rivalry === "none")).toBe(true);
    const rivals = [];
    for (let i = 0; i < 3; i++) rivals.push(await rivalryBetween(aPlayers[i], bPlayers[i]));
    expect((await getClanWars(A.clan.id, "leader"))[0].pairings.every((p) => p.rivalry === "active")).toBe(true);
    expect(await respondToClanWar(B.leader.id, created.warId, "accept")).toEqual({ ok: true });
    const m1 = await playMatch(aPlayers[0], rivals[0].id, 2, 0);
    await playMatch(aPlayers[1], rivals[1].id, 1, 0);
    const done = (await db.select().from(clanWars).where(eq(clanWars.id, created.warId)))[0];
    expect(done).toMatchObject({ status: "completed", winnerClanId: A.clan.id });
    return { A, B, aPlayers, bPlayers, warId: created.warId, m1 };
  }

  it("lets only a verified admin re-open a completed war, re-checks the slots, and audits it", async () => {
    const [admin, user] = await Promise.all([makeUser("adm4", { role: "admin" }), makeUser("usr4")]);
    const w = await completedWar();
    // The deciding match is disputed AFTER completion: the war stays frozen until an admin acts.
    expect((await disputeMatch(w.bPlayers[0].id, false, w.m1)).ok).toBe(true);
    expect((await db.select().from(clanWars).where(eq(clanWars.id, w.warId)))[0].status).toBe("completed");

    expect((await getCompletedWars(admin.id)).some((r) => r.id === w.warId)).toBe(true);
    expect(await getCompletedWars(user.id)).toEqual([]);
    expect(await reopenClanWar(user.id, w.warId)).toEqual({ ok: false, error: "Forbidden" });
    expect((await db.select().from(clanWars).where(eq(clanWars.id, w.warId)))[0].status).toBe("completed");
    expect(await reopenClanWar(admin.id, "not-a-uuid")).toMatchObject({ ok: false });

    expect(await reopenClanWar(admin.id, w.warId, "deciding match disputed")).toMatchObject({ ok: true, status: "active" });
    const war = (await db.select().from(clanWars).where(eq(clanWars.id, w.warId)))[0];
    expect(war).toMatchObject({ status: "active", winnerClanId: null, completedAt: null, challengerWins: 1, defenderWins: 0 });
    expect(await reopenClanWar(admin.id, w.warId)).toMatchObject({ ok: false }); // only completed wars
    expect(await auditActions(admin.id)).toContain("clan_war.reopen");

    // If the evidence still decides the series, settling completes it again by itself.
    await settleWarPairings(w.warId);
    expect((await db.select().from(clanWars).where(eq(clanWars.id, w.warId)))[0].status).toBe("active");
    expect(readFileSync("src/lib/admin-actions.ts", "utf8")).toMatch(/adminReopenClanWarAction[\s\S]*?requireAdmin\(\)/);
  });
});

// ---------------------------------------------------------------------------
// OWASP 2025 static audit of every route and of the client bundle sources
// ---------------------------------------------------------------------------
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}
const slash = (p: string) => p.replace(/\\/g, "/");

describe("OWASP 2025 cyber-sweep (static)", () => {
  const routes = walk("src/app/api").map(slash).filter((f) => f.endsWith("/route.ts"));
  // NextAuth owns its own CSRF/session handling; /health is a public liveness probe.
  const own = routes.filter((f) => !f.includes("[...nextauth]") && !f.endsWith("/health/route.ts"));

  it("finds the expected route set (a new route must be reviewed here)", () => {
    expect(routes).toHaveLength(20);
    expect(own).toHaveLength(18);
  });

  it("A01/A07: every handler is behind apiUser, and every mutating handler requires same-origin", () => {
    for (const f of own) {
      const src = readFileSync(f, "utf8");
      const handlers = src.split(/export async function /).slice(1);
      expect(handlers.length, f).toBeGreaterThan(0);
      for (const h of handlers) {
        const method = h.slice(0, h.indexOf("("));
        expect(h, `${f} ${method}`).toContain("apiUser(request");
        if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
          expect(h, `${f} ${method} must pass mutating=true`).toContain("apiUser(request, true)");
        }
      }
    }
  });

  it("A05: no raw SQL strings, no raw HTML rendering, no inline event handler strings in app code", () => {
    const files = walk("src").map(slash).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/sql\.raw\(/);
      if (!f.startsWith("src/components/ui/")) expect(src, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=/);
    }
  });

  it("A02/A04: no secret reaches the client or an API response", () => {
    const files = walk("src").map(slash).filter((f) => /\.(ts|tsx)$/.test(f));
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/NEXT_PUBLIC_[A-Z_]+/g)) expect(m[0], f).toBe("NEXT_PUBLIC_SITE_URL"); // public by design
    }
    for (const f of own) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\.stack\b/);
      expect(src, f).not.toMatch(/error:\s*(err|e)\.message/);
      // VAPID_PUBLIC_KEY is public by design (the browser needs it to subscribe); everything else stays server-side.
      expect(src, f).not.toMatch(/process\.env\.(?!VAPID_PUBLIC_KEY\b)(GEMINI|DATABASE|AUTH|VAPID|[A-Z_]*SECRET|[A-Z_]*KEY)/);
    }
    // The extract route logs the error NAME only, never its message.
    expect(readFileSync("src/app/api/rivalry/[id]/extract/route.ts", "utf8")).not.toMatch(/err\.message/);
  });

  it("A06/A10: bounded reads, validated bodies, size caps and rate limits on the new chat/clan surfaces", () => {
    const limits = (f: string) => (readFileSync(f, "utf8").match(/\.limit\(/g) ?? []).length;
    expect(limits("src/lib/dm-chat.ts")).toBeGreaterThanOrEqual(2);
    expect(limits("src/lib/global-chat.ts")).toBeGreaterThanOrEqual(2);
    expect(limits("src/lib/clans.ts")).toBeGreaterThanOrEqual(6);
    for (const f of own.filter((x) => /\/(chat|clans|clan-wars|clan-invites)\b/.test(x))) {
      const src = readFileSync(f, "utf8");
      if (/export async function (POST|PUT)/.test(src)) {
        expect(src, f).toMatch(/readJson\(|content-length|safeParse|request\.json\(\)\.catch/);
      }
    }
    // One quota consumption per upload, and local OCR remains off unless explicitly switched on.
    const route = readFileSync("src/app/api/rivalry/[id]/extract/route.ts", "utf8");
    expect(route.match(/consumeRateLimit\(\s*`extract:/g)).toHaveLength(1);
    expect(readFileSync("src/lib/ocr/local-extract.ts", "utf8")).toContain('env.LOCAL_OCR === "on"');
  });

  it("every chat send path checks the mute in the database", () => {
    expect(readFileSync("src/lib/dm-chat.ts", "utf8")).toContain("isChatMuted(meId)");
    expect(readFileSync("src/lib/global-chat.ts", "utf8")).toContain("isChatMuted(meId)");
    expect(readFileSync("src/lib/clans.ts", "utf8")).toContain("isChatMuted(actorId)");
  });
});
