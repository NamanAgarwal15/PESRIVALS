// Codebase-sweep regression tests: shared helpers, input hardening, query bounds.
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { eq, inArray, like, or } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { matches, rivalries, users } from "@/db/schema";
import { sameOrigin } from "@/lib/request-origin";
import { geminiConfigured, generateGemini } from "@/lib/gemini-text";
import { sha256Hex } from "@/lib/hash";
import { sha256Hex as otpHash } from "@/lib/otp";
import { sha256 as resetHash } from "@/lib/password-reset";
import { sha256Hex as cacheHash } from "@/lib/extract-cache";
import { disputeMatch, saveMatchForUser } from "@/lib/match-helpers";
import type { ExtractedSide } from "@/lib/match-schema";
import { parseEfootballId } from "@/lib/profile";
import { isPushConfigured, sendPushToUser } from "@/lib/push";
import { canonicalPair } from "@/lib/rivalry-helpers";
import { stripUnsafe } from "@/lib/coach-chat";
import { sanitizeText } from "@/lib/career-lab";

describe("shared hash helper", () => {
  it("is one SHA-256 for strings and bytes, re-exported everywhere it was duplicated", () => {
    const expected = createHash("sha256").update("abc").digest("hex");
    for (const h of [sha256Hex, otpHash, resetHash, cacheHash]) expect(h("abc")).toBe(expected);
    expect(sha256Hex(new Uint8Array([97, 98, 99]))).toBe(expected);
  });
  it("coach text stripping and career sanitising agree", () => {
    const evil = "a<b>\u0007\n c\t<script>";
    expect(stripUnsafe(evil)).toBe(sanitizeText(evil, 1000));
    expect(stripUnsafe(evil)).not.toMatch(/[<>\u0000-\u001f]/);
  });
});

describe("shared Gemini text client", () => {
  const ok = (text: string) => ({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] }) }) as unknown as Response;
  it("walks keys/models, skips rejected output, never throws", async () => {
    vi.stubEnv("GEMINI_API_KEY_1", "k1");
    vi.stubEnv("GEMINI_API_KEY_2", "");
    expect(geminiConfigured()).toBe(true);
    let n = 0;
    const out = await generateGemini("{}", (t) => (t === "good" ? t : null), (async () => (++n < 3 ? ok("bad") : ok("good"))) as unknown as typeof fetch);
    expect(out).toBe("good");
    expect(n).toBe(3);
    expect(await generateGemini("{}", () => "x", (async () => { throw new Error("net"); }) as unknown as typeof fetch)).toBeNull();
    expect(await generateGemini("{}", () => "x", (async () => ({ ok: false, status: 500 })) as unknown as typeof fetch)).toBeNull();
    vi.stubEnv("GEMINI_API_KEY_1", "");
    expect(geminiConfigured()).toBe(false);
    expect(await generateGemini("{}", () => "x", (async () => ok("x")) as unknown as typeof fetch)).toBeNull();
    vi.unstubAllEnvs();
  });
});

describe("input hardening", () => {
  it("parseEfootballId tolerates non-strings from a crafted client", () => {
    for (const bad of [undefined, null, 5, {}, ["a"]]) expect(parseEfootballId(bad).ok).toBe(false);
    expect(parseEfootballId(" AB-12 ")).toEqual({ ok: true, value: "AB-12" });
  });
  it("same-origin check rejects missing and foreign origins", () => {
    const req = (origin: string | null, host = "pesrivals.vercel.app") =>
      new Request("https://pesrivals.vercel.app/api/x", { method: "POST", headers: { ...(origin ? { origin } : {}), host } });
    expect(sameOrigin(req("https://pesrivals.vercel.app"))).toBe(true);
    expect(sameOrigin(req("https://evil.example"))).toBe(false);
    expect(sameOrigin(req(null))).toBe(false);
    expect(sameOrigin(req("not a url"))).toBe(false);
  });
  it("push sending with VAPID unset is a quiet no-op, not a crash", async () => {
    vi.stubEnv("VAPID_PUBLIC_KEY", "");
    vi.stubEnv("VAPID_PRIVATE_KEY", "");
    vi.stubEnv("VAPID_SUBJECT", "");
    expect(isPushConfigured()).toBe(false);
    expect(await sendPushToUser("00000000-0000-4000-8000-000000000000", { title: "t", body: "b", url: "/home" })).toEqual({ sent: 0, pruned: 0 });
    vi.unstubAllEnvs();
  });
  it("no routes leak raw error messages or stacks", () => {
    for (const f of [
      "src/app/api/account/export/route.ts", "src/app/api/coach/chat/route.ts", "src/app/api/push/subscribe/route.ts",
      "src/app/api/push/unsubscribe/route.ts", "src/app/api/security/fingerprint/route.ts", "src/app/api/rivalry/[id]/extract/route.ts",
    ]) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/error:\s*(err|e)\.(message|stack)|\.stack\b|JSON\.stringify\(err/);
      expect(src, f).toMatch(/apiUser/);
    }
  });
});

describe("match queries stay confirmed-only and soft-delete aware", () => {
  it("every stats/analytics query that reads matches filters deleted_at", () => {
    const need = ["src/lib/career-stats.ts", "src/lib/leaderboard.ts", "src/lib/player-profile.ts", "src/lib/career-lab.ts", "src/lib/account.ts", "src/lib/anti-sybil.ts", "src/lib/match-helpers.ts"];
    for (const f of need) expect(readFileSync(f, "utf8"), f).toMatch(/isNull\(matches\.deletedAt\)/);
    for (const f of ["src/lib/career-stats.ts", "src/lib/leaderboard.ts", "src/lib/player-profile.ts", "src/lib/career-lab.ts", "src/lib/account.ts"]) {
      expect(readFileSync(f, "utf8"), f).toMatch(/eq\(matches\.status, "confirmed"\)/);
    }
    expect(readFileSync("src/lib/leaderboard.ts", "utf8")).toMatch(/\.limit\(LEADERBOARD_MAX_MATCHES\)/);
  });
});

const RUN = `sw${randomBytes(3).toString("hex")}`;
const ids: string[] = [];
const SIDE: ExtractedSide = {
  team: "A", goals: 1, possession: 50, shots: 5, shots_on_target: 2, fouls: 1, offsides: 0, corners: 1,
  free_kicks: 1, passes: 50, successful_passes: 40, crosses: 1, interceptions: 1, tackles: 1, saves: 1,
};
afterAll(async () => {
  if (ids.length) {
    await db.delete(rivalries).where(or(inArray(rivalries.userAId, ids), inArray(rivalries.userBId, ids)));
    await db.delete(users).where(inArray(users.id, ids));
  }
  await db.delete(users).where(like(users.username, `${RUN}\\_%`));
});

describe("dispute with a malformed reason", () => {
  it("a non-string reason is ignored instead of throwing", async () => {
    const [p, q] = await Promise.all(["a", "b"].map(async (l, i) => {
      const [u] = await db.insert(users).values({ username: `${RUN}_${l}${i}`, displayName: l, updatedAt: new Date() }).returning();
      ids.push(u.id);
      return u;
    }));
    const [x, y] = canonicalPair(p.id, q.id);
    const [r] = await db.insert(rivalries).values({ userAId: x, userBId: y, status: "active", requestedBy: x, acceptedAt: new Date() }).returning();
    const saved = await saveMatchForUser(p.id, { rivalryId: r.id, mySide: "left", host: "home", extracted: { left: SIDE, right: { ...SIDE, team: "B" } } });
    if (!saved.ok) throw new Error(saved.error);
    const res = await disputeMatch(q.id, false, saved.matchId, { evil: true } as unknown as string);
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(matches).where(eq(matches.id, saved.matchId));
    expect(row.status).toBe("disputed");
    expect(row.remark).toBeNull();
  });
});
