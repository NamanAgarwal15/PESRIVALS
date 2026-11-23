// 30-day Rivalry Coach log retention, account-deletion cleanup, and the privacy notice.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { eq, inArray, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { adminAuditLogs, coachChatLogs, users } from "@/db/schema";
import { deleteAccount } from "@/lib/account";
import { getAdminCoachChatLogs } from "@/lib/admin-coach";
import { recordAudit } from "@/lib/audit";
import { COACH_LOG_RETENTION_DAYS, maybePruneCoachChatLogs, pruneExpiredCoachChatLogs } from "@/lib/coach-chat";

const RUN = `rt${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
let n = 0;
async function makeUser(label: string, extra: Partial<typeof users.$inferInsert> = {}) {
  const [row] = await db.insert(users).values({ username: `${RUN}_${label}${n++}`.slice(0, 20), displayName: label, updatedAt: new Date(), ...extra }).returning();
  ids.push(row.id);
  return row;
}
const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 3600_000);
const log = (userId: string, createdAt: Date, msg: string) =>
  db.insert(coachChatLogs).values({ userId, userMessage: msg, assistantReply: "r", source: "ai", createdAt });

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, ids));
  await db.delete(users).where(like(users.username, `${RUN}\\_%`));
});

describe("coach log retention", () => {
  it("keeps the window at 30 days and deletes only older rows", async () => {
    expect(COACH_LOG_RETENTION_DAYS).toBe(30);
    const u = await makeUser("a");
    await log(u.id, daysAgo(31), "old");
    await log(u.id, daysAgo(45), "older");
    await log(u.id, daysAgo(29), "recent");
    await log(u.id, new Date(), "today");
    const removed = await pruneExpiredCoachChatLogs();
    expect(removed).toBeGreaterThanOrEqual(2);
    const left = (await db.select().from(coachChatLogs).where(eq(coachChatLogs.userId, u.id))).map((r) => r.userMessage).sort();
    expect(left).toEqual(["recent", "today"]);
    expect(await pruneExpiredCoachChatLogs()).toBeGreaterThanOrEqual(0); // idempotent
  });

  it("honours a custom window, ignores nonsense windows, and respects an injected clock", async () => {
    const u = await makeUser("b");
    await log(u.id, daysAgo(10), "ten days");
    await pruneExpiredCoachChatLogs(7);
    expect(await db.select().from(coachChatLogs).where(eq(coachChatLogs.userId, u.id))).toHaveLength(0);
    await log(u.id, daysAgo(10), "again");
    await pruneExpiredCoachChatLogs(Number.NaN); // falls back to 30 days: keeps the 10-day-old row
    await pruneExpiredCoachChatLogs(-5);
    expect(await db.select().from(coachChatLogs).where(eq(coachChatLogs.userId, u.id))).toHaveLength(1);
    await pruneExpiredCoachChatLogs(30, new Date(Date.now() + 25 * 24 * 3600_000)); // 25 days later it is 35 days old
    expect(await db.select().from(coachChatLogs).where(eq(coachChatLogs.userId, u.id))).toHaveLength(0);
  });

  it("never touches admin_audit_logs", async () => {
    const admin = await makeUser("adm", { role: "admin" });
    await recordAudit(admin.id, "user.suspend", "user", admin.id);
    const before = (await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.actorUserId, admin.id))).length;
    await pruneExpiredCoachChatLogs(1, new Date(Date.now() + 400 * 24 * 3600_000));
    expect((await db.select().from(adminAuditLogs).where(eq(adminAuditLogs.actorUserId, admin.id))).length).toBe(before);
  });

  it("opportunistic pruning only runs on a small share of calls and the admin reader hides expired chats", async () => {
    const u = await makeUser("c");
    await log(u.id, daysAgo(40), "stale c");
    await maybePruneCoachChatLogs(0.5); // skipped
    expect(await db.select().from(coachChatLogs).where(eq(coachChatLogs.userId, u.id))).toHaveLength(1);
    await maybePruneCoachChatLogs(0.001); // runs
    expect(await db.select().from(coachChatLogs).where(eq(coachChatLogs.userId, u.id))).toHaveLength(0);

    await log(u.id, daysAgo(40), "stale again");
    const admin = await makeUser("rd", { role: "admin" });
    const page = await getAdminCoachChatLogs(admin.id, { username: u.username });
    if (!page.ok) throw new Error("denied");
    expect(page.rows.map((r) => r.userMessage)).not.toContain("stale again");
  });

  it("account deletion and user removal clear the user's coach chats", async () => {
    const u = await makeUser("del");
    await log(u.id, new Date(), "private question");
    expect(await deleteAccount(u.id)).toEqual({ ok: true });
    expect(await db.select().from(coachChatLogs).where(eq(coachChatLogs.userId, u.id))).toHaveLength(0);

    const v = await makeUser("cas");
    await log(v.id, new Date(), "cascade me");
    await db.delete(users).where(eq(users.id, v.id));
    expect(await db.select().from(coachChatLogs).where(eq(coachChatLogs.userId, v.id))).toHaveLength(0);
  });
});

describe("privacy notice", () => {
  const page = readFileSync("src/app/privacy/page.tsx", "utf8");
  it("discloses logging, moderation purpose, admin access, Gemini and the 30-day retention", () => {
    expect(page).toContain("Rivalry Coach chats");
    expect(page).toMatch(/message and the coach(&apos;|')s reply/);
    expect(page).toContain("anti-abuse moderation");
    expect(page).toContain("safety oversight");
    expect(page).toContain("quality of the service");
    expect(page).toContain("Site administrators can read them");
    expect(page).toContain("Google Gemini");
    expect(page).toContain("deleted automatically after 30 days");
    expect(page).toContain("immediately when you delete your account");
  });
  it("the route schedules cleanup after responding and the docs record the policy", () => {
    expect(readFileSync("src/app/api/coach/chat/route.ts", "utf8")).toContain("maybePruneCoachChatLogs");
    expect(readFileSync("docs/ASPIRED_SYSTEM_ARCHITECTURE.md", "utf8")).toContain("30-day");
  });
});
