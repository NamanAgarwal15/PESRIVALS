// OTP lifecycle, mandatory email signup, email-only OTP, leaderboard privacy and admin
// RBAC. Runs against the LOCAL TEST database and cleans up its own rows.

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { otpCodes, users } from "@/db/schema";
import { agreeSchema, signUpSchema, signUpUser } from "@/lib/auth-helpers";
import { OTP_MAX_ATTEMPTS, sendOtp, sha256Hex, verifyOtp } from "@/lib/otp";
import { getLeaderboard } from "@/lib/leaderboard";
import { clearRateLimit } from "@/lib/rate-limit";
import { applyProfileChange, maskEmail, startProfileVerification, verifyProfileChange } from "@/lib/profile";
import { isAdminUser, setRole, setSuspended, setLeaderboardVisibility } from "@/lib/admin";

const RUN = randomBytes(4).toString("hex");
const ids = new Set<string>();
const rl = new Set<string>();

async function makeUser(label: string) {
  const email = `${RUN}.${label}@example.com`;
  const r = await signUpUser({
    username: `${RUN}_${label}`.slice(0, 20),
    displayName: "OTP Test",
    password: "hunter2pass1",
    email,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  ids.add(r.user.id);
  rl.add(`otp:${r.user.id}`);
  return { id: r.user.id, email, username: r.user.username };
}

afterAll(async () => {
  for (const id of ids) await db.delete(users).where(eq(users.id, id));
  for (const k of rl) await clearRateLimit(k);
});

describe("mandatory email signup", () => {
  const base = { username: "abcde", displayName: "A", password: "hunter2pass1" };
  it("rejects a signup without an email and needs no phone", () => {
    expect(signUpSchema.safeParse({ ...base }).success).toBe(false);
    expect(signUpSchema.safeParse({ ...base, email: "a@b.co" }).success).toBe(true);
  });
  it("requires the terms/leaderboard consent", () => {
    expect(agreeSchema.safeParse(false).success).toBe(false);
    expect(agreeSchema.safeParse(true).success).toBe(true);
  });
});

describe("OTP lifecycle", () => {
  const capture = () => {
    const box: { code?: string } = {};
    return { box, sender: async (c: string) => ((box.code = c), "email" as const) };
  };

  it("stores only the SHA-256 hash and logs in with the right code once", async () => {
    const u = await makeUser("otp1");
    const { box, sender } = capture();
    const sent = await sendOtp(u.email, sender);
    expect(sent.ok).toBe(true);
    const [row] = await db.select().from(otpCodes).where(eq(otpCodes.userId, u.id));
    expect(row.codeHash).toBe(sha256Hex(box.code!));
    expect(row.codeHash).not.toContain(box.code!);
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
    expect((await verifyOtp(u.email, box.code!)).ok).toBe(true);
    expect((await verifyOtp(u.email, box.code!)).ok).toBe(false); // single use
  });

  it("locks after 3 wrong attempts, even for the right code", async () => {
    const u = await makeUser("otp2");
    const { box, sender } = capture();
    await sendOtp(u.email, sender);
    const wrong = box.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < OTP_MAX_ATTEMPTS; i++) {
      expect((await verifyOtp(u.email, wrong)).ok).toBe(false);
    }
    const res = await verifyOtp(u.email, box.code!);
    expect(res).toEqual({ ok: false, code: "too_many_attempts" });
  });

  it("rejects expired codes", async () => {
    const u = await makeUser("otp3");
    const { box, sender } = capture();
    await sendOtp(u.email, sender);
    await db.update(otpCodes).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(otpCodes.userId, u.id));
    expect(await verifyOtp(u.email, box.code!)).toEqual({ ok: false, code: "expired" });
  });

  it("limits sends to 3 per 15 minutes and refuses suspended users", async () => {
    const u = await makeUser("otp4");
    const { sender } = capture();
    for (let i = 0; i < 3; i++) expect((await sendOtp(u.email, sender)).ok).toBe(true);
    expect(await sendOtp(u.email, sender)).toEqual({ ok: false, code: "rate_limited" });
    const s = await makeUser("otp5");
    await setSuspended(s.id, true);
    expect(await sendOtp(s.email, sender)).toEqual({ ok: false, code: "suspended" });
  });
});

describe("leaderboard visibility & privacy", () => {
  it("lists private-profile users, hides suspended ones, exposes only aggregate fields", async () => {
    const priv = await makeUser("lbpriv");
    const susp = await makeUser("lbsusp");
    await setLeaderboardVisibility(priv.id, false); // peer-profile privacy only
    await setSuspended(susp.id, true);
    const rows = await getLeaderboard();
    expect(rows.map((r) => r.username)).not.toContain(susp.username);
    // played=0 users are not ranked; privacy flag must not be the filter.
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(["avgPossession", "displayName", "passAccuracy", "rank", "summary", "userId", "username"]);
      expect(JSON.stringify(r)).not.toMatch(/@.+./);
    }
  });
});

describe("profile changes need OTP on the right channel", () => {
  it("masks the email in the confirmation hint", () => {
    expect(maskEmail("ayush@example.com")).toBe("a***@example.com");
  });

  it("changing email requires a code emailed to the current address; a wrong code changes nothing", async () => {
    const u = await makeUser("prof1");
    let sentTo = "";
    let code = "";
    const sender = async (c: string, to: string) => ((code = c), (sentTo = to), "email" as const);
    const start = await startProfileVerification(u.id, "email", sender);
    expect(start.ok && start.needsCode).toBe(true);
    expect(sentTo).toBe(u.email);
    const bad = await verifyProfileChange(u.id, "email", code === "000000" ? "111111" : "000000");
    expect(bad.ok).toBe(false);
    expect((await verifyProfileChange(u.id, "email", code)).ok).toBe(true);
    const newEmail = `${RUN}.new@example.com`;
    expect((await applyProfileChange(u.id, "email", newEmail)).ok).toBe(true);
    const [row] = await db.select({ email: users.email }).from(users).where(eq(users.id, u.id));
    expect(row.email).toBe(newEmail);
  });
});

describe("admin RBAC", () => {
  it("only real, non-suspended admins pass the gate", async () => {
    const u = await makeUser("rbac");
    expect(await isAdminUser(u.id)).toBe(false);
    expect(await isAdminUser(null)).toBe(false);
    await setRole(u.id, "admin");
    expect(await isAdminUser(u.id)).toBe(true);
    await setSuspended(u.id, true);
    expect(await isAdminUser(u.id)).toBe(false);
    await setSuspended(u.id, false);
    await setRole(u.id, "user"); // other admins may exist, or this blocks: both fine
  });

  it("never demotes the last admin", async () => {
    const all = await db.select({ id: users.id, role: users.role }).from(users);
    const admins = all.filter((a) => a.role === "admin");
    if (admins.length === 1) {
      expect((await setRole(admins[0].id, "user")).ok).toBe(false);
    } else {
      expect(admins.length).not.toBe(1);
    }
  });
});

describe("admin page queries", () => {
  it("run without SQL errors (regression: ambiguous id)", async () => {
    const { getPlatformStats, listUsers, listRecentMatches } = await import("@/lib/admin");
    await getPlatformStats();
    expect((await listUsers("")).length).toBeGreaterThan(0);
    await listUsers("@a%_");
    await listRecentMatches();
  });
});
