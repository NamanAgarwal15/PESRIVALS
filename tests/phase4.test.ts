// Phase 4: crypto, push SSRF guard + storage, JWT revalidation window,
// match context, security headers, logger redaction, password blocklist.
import { randomBytes } from "node:crypto";
import { eq, inArray, like, or } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { matches, pushSubscriptions, rivalries, users } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { REVALIDATE_AFTER_SECONDS, isCommonPassword, needsRevalidation, passwordSchema } from "@/lib/auth-helpers";
import { saveMatchForUser } from "@/lib/match-helpers";
import type { ExtractedSide } from "@/lib/match-schema";
import { saveMatchInputSchema } from "@/lib/match-schema";
import {
  checkPushEndpoint,
  hasSubscription,
  isPrivateAddress,
  removeSubscription,
  saveSubscription,
  sendPushToUser,
  validatePushEndpoint,
} from "@/lib/push";
import { canonicalPair } from "@/lib/rivalry-helpers";
import { redact } from "@/lib/security-log";
import nextConfig from "../next.config";

const RUN = `p4${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
let n = 0;
async function makeUser(label: string) {
  const [row] = await db
    .insert(users)
    .values({ username: `${RUN}_${label}${n++}`.slice(0, 20), displayName: `N ${label}`, updatedAt: new Date() })
    .returning();
  ids.push(row.id);
  return row;
}
afterAll(async () => {
  if (ids.length) {
    await db.delete(rivalries).where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    await db.delete(users).where(inArray(users.id, ids)); // cascades push_subscriptions
  }
  await db.delete(users).where(like(users.username, `${RUN}\\_%`));
});

describe("AES-256-GCM", () => {
  it("round-trips, uses a random IV and rejects tampering", () => {
    const a = encryptSecret("BNc-secret-key");
    const b = encryptSecret("BNc-secret-key");
    expect(a).not.toBe(b);
    expect(a).not.toContain("BNc-secret-key");
    expect(decryptSecret(a)).toBe("BNc-secret-key");
    const parts = a.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
    expect(() => decryptSecret("garbage")).toThrow();
  });

  it("throws in production without a key, works with one", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PUSH_ENCRYPTION_KEY", "");
    expect(() => encryptSecret("x")).toThrow(/PUSH_ENCRYPTION_KEY/);
    vi.stubEnv("PUSH_ENCRYPTION_KEY", randomBytes(32).toString("base64"));
    expect(decryptSecret(encryptSecret("x"))).toBe("x");
    vi.stubEnv("PUSH_ENCRYPTION_KEY", "short");
    expect(() => encryptSecret("x")).toThrow();
    vi.unstubAllEnvs();
  });
});

describe("push endpoint SSRF guard", () => {
  it("accepts public https endpoints", () => {
    expect(validatePushEndpoint("https://fcm.googleapis.com/fcm/send/abc").ok).toBe(true);
    expect(validatePushEndpoint("https://updates.push.services.mozilla.com/wpush/v2/x").ok).toBe(true);
  });

  it("rejects http, credentials, local and private hosts", () => {
    for (const bad of [
      "http://fcm.googleapis.com/x",
      "https://localhost/x",
      "https://app.localhost/x",
      "https://127.0.0.1/x",
      "https://10.1.2.3/x",
      "https://172.16.0.1/x",
      "https://172.31.255.1/x",
      "https://192.168.1.1/x",
      "https://169.254.169.254/latest/meta-data",
      "https://0.0.0.0/x",
      "https://[::1]/x",
      "https://[fd00::1]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://user:pw@fcm.googleapis.com/x",
      "https://intranet/x",
      "https://printer.local/x",
      "ftp://example.com/x",
      "not a url",
      "",
      42,
      "https://example.com/" + "a".repeat(2100),
    ]) {
      expect(validatePushEndpoint(bad).ok, String(bad)).toBe(false);
    }
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  it("rejects hosts that resolve to private addresses and fails closed on DNS errors", async () => {
    const ep = "https://evil.example.com/x";
    expect((await checkPushEndpoint(ep, async () => [{ address: "10.0.0.5" }])).ok).toBe(false);
    expect((await checkPushEndpoint(ep, async () => [{ address: "8.8.8.8" }, { address: "127.0.0.1" }])).ok).toBe(false);
    expect((await checkPushEndpoint(ep, async () => { throw new Error("nxdomain"); })).ok).toBe(false);
    expect((await checkPushEndpoint(ep, async () => [])).ok).toBe(false);
    expect((await checkPushEndpoint(ep, async () => [{ address: "8.8.8.8" }])).ok).toBe(true);
  });
});

describe("push storage and sending", () => {
  it("stores keys encrypted, scopes removal to the owner, prunes 410", async () => {
    const owner = await makeUser("own");
    const other = await makeUser("oth");
    const endpoint = `https://push.example.com/${RUN}`;
    await saveSubscription(owner.id, endpoint, { p256dh: "P256DH-PLAIN-KEY", auth: "AUTH-PLAIN" }, "UA");
    const [row] = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint));
    expect(row.userId).toBe(owner.id);
    expect(row.p256dhEncrypted).not.toContain("P256DH-PLAIN-KEY");
    expect(row.authEncrypted).not.toContain("AUTH-PLAIN");
    expect(decryptSecret(row.p256dhEncrypted)).toBe("P256DH-PLAIN-KEY");

    expect(await removeSubscription(other.id, endpoint)).toBe(0); // not theirs
    expect(await hasSubscription(owner.id)).toBe(true);

    const sent: string[] = [];
    const ok = await sendPushToUser(owner.id, { title: "t", body: "b", url: "//evil.com" }, async (sub, body) => {
      sent.push(body);
      expect(sub.keys.p256dh).toBe("P256DH-PLAIN-KEY");
    });
    expect(ok.sent).toBe(1);
    expect(JSON.parse(sent[0]).url).toBe("/home"); // off-site paths are neutralised

    const gone = await sendPushToUser(owner.id, { title: "t", body: "b", url: "/home" }, async () => {
      throw Object.assign(new Error("gone"), { statusCode: 410 });
    });
    expect(gone.pruned).toBe(1);
    expect(await hasSubscription(owner.id)).toBe(false);

    // A transient failure keeps the subscription and never throws.
    await saveSubscription(owner.id, endpoint, { p256dh: "k1234567890", auth: "a12345678" }, null);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fail = await sendPushToUser(owner.id, { title: "t", body: "b", url: "/home" }, async () => {
      throw Object.assign(new Error("boom"), { statusCode: 500 });
    });
    err.mockRestore();
    expect(fail).toEqual({ sent: 0, pruned: 0 });
    expect(await removeSubscription(owner.id, endpoint)).toBe(1);
  });
});

describe("60-second JWT revalidation", () => {
  it("re-checks only after the window", () => {
    const now = 1_000_000;
    expect(REVALIDATE_AFTER_SECONDS).toBe(60);
    expect(needsRevalidation(undefined, now)).toBe(true);
    expect(needsRevalidation(now - 59_000, now)).toBe(false);
    expect(needsRevalidation(now - 60_000, now)).toBe(true);
    expect(needsRevalidation(now + 5_000, now)).toBe(true); // clock skew: re-check
    expect(needsRevalidation(Number.NaN, now)).toBe(true);
  });
});

describe("match context", () => {
  const SIDE: ExtractedSide = {
    team: "A", goals: 1, possession: 50, shots: 5, shots_on_target: 2, fouls: 1, offsides: 0, corners: 1,
    free_kicks: 1, passes: 50, successful_passes: 40, crosses: 1, interceptions: 1, tackles: 1, saves: 1,
  };
  const base = { extracted: { left: SIDE, right: { ...SIDE, team: "B", possession: 50 } }, mySide: "left", host: "home" };

  it("validates allowed values only", () => {
    const rivalryId = "00000000-0000-4000-8000-000000000001";
    expect(saveMatchInputSchema.safeParse({ ...base, rivalryId, myPlaystyle: "Out Wide", matchContext: "Cup" }).success).toBe(true);
    expect(saveMatchInputSchema.safeParse({ ...base, rivalryId, myPlaystyle: "Tiki Taka" }).success).toBe(false);
    expect(saveMatchInputSchema.safeParse({ ...base, rivalryId, matchContext: "<script>" }).success).toBe(false);
    const empty = saveMatchInputSchema.parse({ ...base, rivalryId });
    expect(empty).toMatchObject({ myPlaystyle: null, opponentPlaystyle: null, matchContext: null, isExtraTime: false });
  });

  it("maps playstyles to the right user slot and mirrors penalties", async () => {
    const [p, q] = await Promise.all([makeUser("ma"), makeUser("mb")]);
    const [aId, bId] = canonicalPair(p.id, q.id);
    const [r] = await db.insert(rivalries).values({ userAId: aId, userBId: bId, status: "active", requestedBy: aId, acceptedAt: new Date() }).returning();
    const res = await saveMatchForUser(p.id, {
      ...base, rivalryId: r.id, decidedOnPens: true, isExtraTime: true,
      myPlaystyle: "Quick Counter", opponentPlaystyle: "Long Ball", matchContext: "Rematch",
    });
    if (!res.ok) throw new Error(res.error);
    const [m] = await db.select().from(matches).where(eq(matches.id, res.matchId));
    const iAmA = p.id === aId;
    expect(m.playstyleA).toBe(iAmA ? "Quick Counter" : "Long Ball");
    expect(m.playstyleB).toBe(iAmA ? "Long Ball" : "Quick Counter");
    expect(m).toMatchObject({ matchContext: "Rematch", isPenalties: true, isExtraTime: true });
    expect(res.opponentId).toBe(q.id);
  });
});

describe("security headers (A02)", () => {
  it("sets the hardened header set on every route", async () => {
    const rules = await nextConfig.headers!();
    const map = new Map(rules[0].headers.map((h) => [h.key, h.value]));
    expect(map.get("Strict-Transport-Security")).toMatch(/max-age=\d{8,}/);
    expect(map.get("X-Content-Type-Options")).toBe("nosniff");
    expect(map.get("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    const perms = map.get("Permissions-Policy")!;
    for (const f of ["camera=()", "microphone=()", "geolocation=()", "payment=()"]) expect(perms).toContain(f);
    const csp = map.get("Content-Security-Policy")!;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("worker-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("object-src 'none'");
  });
});

describe("security logger and password policy", () => {
  it("redacts secrets and PII, keeps only the endpoint host", () => {
    const out = redact({ userId: "u1", password: "x", token: "t", email: "a@b.c", ip: "1.2.3.4", p256dh: "k", endpoint: "https://fcm.googleapis.com/fcm/send/SECRET", reason: "r", nested: { apiKey: "z", ok: 1 } });
    expect(out).toMatchObject({ userId: "u1", password: "[redacted]", token: "[redacted]", email: "[redacted]", ip: "[redacted]", p256dh: "[redacted]", reason: "r" });
    expect(String(out.endpoint)).toBe("fcm.googleapis.com/…");
    expect(out.nested).toEqual({ apiKey: "[redacted]", ok: 1 });
  });

  it("blocks common passwords", () => {
    expect(isCommonPassword("Password123")).toBe(true);
    expect(passwordSchema.safeParse("password123").success).toBe(false);
    expect(passwordSchema.safeParse("hunter2pass1").success).toBe(true);
  });
});
