// Phase 1: suspension across Google/JWT, eFootball ID validation, public
// career profiles vs peer rivalry privacy. LOCAL TEST database only.

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { matches, rivalries, users } from "@/db/schema";
import {
  isGoogleIdentitySuspended,
  refreshSessionUser,
  resolveGoogleUser,
  signUpUser,
} from "@/lib/auth-helpers";
import { canSeeRivalryDetail, getPlayerProfile, searchPlayers } from "@/lib/player-profile";
import { parseEfootballId, setEfootballId } from "@/lib/profile";

const RUN = randomBytes(4).toString("hex");
const ids = new Set<string>();
let n = 0;

async function makeUser(label: string) {
  const username = `${RUN}_${label}${n++}`.slice(0, 20);
  const email = `${username}@example.com`;
  const r = await signUpUser({ username, displayName: `Player ${label}`, password: "hunter2pass1", email });
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  ids.add(r.user.id);
  return { id: r.user.id, username, email };
}

afterAll(async () => {
  for (const id of ids) await db.delete(users).where(eq(users.id, id));
});

describe("suspension enforcement", () => {
  it("blocks a suspended user's Google identity (linked and by verified email)", async () => {
    const u = await makeUser("gsus");
    const sub = `sub_${RUN}`;
    // Link by verified email, then suspend.
    await resolveGoogleUser({ sub, email: u.email, emailVerified: true });
    expect(await isGoogleIdentitySuspended({ sub, email: u.email, emailVerified: true })).toBe(false);
    await db.update(users).set({ suspended: true }).where(eq(users.id, u.id));
    expect(await isGoogleIdentitySuspended({ sub, email: u.email, emailVerified: true })).toBe(true);
    // A different sub but the same verified email is blocked too.
    expect(await isGoogleIdentitySuspended({ sub: `other_${RUN}`, email: u.email, emailVerified: true })).toBe(true);
    // An unverified email does not match anyone.
    expect(await isGoogleIdentitySuspended({ sub: `x_${RUN}`, email: u.email, emailVerified: false })).toBe(false);
  });

  it("ends an existing session once the user is suspended or deleted", async () => {
    const u = await makeUser("jwtsus");
    expect((await refreshSessionUser(u.id))?.id).toBe(u.id);
    await db.update(users).set({ suspended: true }).where(eq(users.id, u.id));
    expect(await refreshSessionUser(u.id)).toBeNull();
    expect(await refreshSessionUser("00000000-0000-4000-8000-000000000000")).toBeNull();
  });

  it("reflects a role change on the very next refresh", async () => {
    const u = await makeUser("role");
    await db.update(users).set({ role: "admin" }).where(eq(users.id, u.id));
    expect((await refreshSessionUser(u.id))?.role).toBe("admin");
  });
});

describe("eFootball ID", () => {
  it("validates, trims and clears", async () => {
    expect(parseEfootballId("  AB-1234  ")).toEqual({ ok: true, value: "AB-1234" });
    expect(parseEfootballId("   ")).toEqual({ ok: true, value: null });
    expect(parseEfootballId("bad id!").ok).toBe(false);
    expect(parseEfootballId("x".repeat(25)).ok).toBe(false);
    const u = await makeUser("efid");
    expect((await setEfootballId(u.id, "123-456-789")).ok).toBe(true);
    const [row] = await db.select({ e: users.efootballId }).from(users).where(eq(users.id, u.id));
    expect(row.e).toBe("123-456-789");
    await setEfootballId(u.id, "");
    const [row2] = await db.select({ e: users.efootballId }).from(users).where(eq(users.id, u.id));
    expect(row2.e).toBeNull();
  });
});

describe("public career profile vs peer rivalry privacy", () => {
  it("applies the visibility rule", () => {
    const base = { isSelf: false, viewerRole: "user" as const, targetPublic: false };
    expect(canSeeRivalryDetail(base)).toBe(false);
    expect(canSeeRivalryDetail({ ...base, targetPublic: true })).toBe(true);
    expect(canSeeRivalryDetail({ ...base, viewerRole: "admin" })).toBe(true);
    expect(canSeeRivalryDetail({ ...base, isSelf: true })).toBe(true);
  });

  it("always shows career stats but gates rivalries and logs", async () => {
    const [t, r, v, a] = [
      await makeUser("tgt"),
      await makeUser("riv"),
      await makeUser("view"),
      await makeUser("adm"),
    ];
    const [low, high] = t.id < r.id ? [t, r] : [r, t];
    const [rv] = await db
      .insert(rivalries)
      .values({ userAId: low.id, userBId: high.id, status: "active", requestedBy: low.id, acceptedAt: new Date() })
      .returning();
    await db.insert(matches).values({
      rivalryId: rv.id,
      matchNo: 1,
      source: "import",
      userATeam: "A FC",
      userBTeam: "B FC",
      userAGoals: t.id === low.id ? 3 : 0,
      userBGoals: t.id === low.id ? 0 : 3,
    });
    await db.update(users).set({ publicLeaderboard: false }).where(eq(users.id, t.id));

    const asStranger = await getPlayerProfile({ id: v.id, role: "user" }, t.username);
    expect(asStranger?.career.summary.played).toBe(1);
    expect(asStranger?.career.summary.wins).toBe(1);
    expect(asStranger?.canSeeRivalries).toBe(false);
    expect(asStranger?.rivalries).toEqual([]);
    expect(asStranger?.recentMatches).toEqual([]);
    expect(JSON.stringify(asStranger)).not.toContain(r.username);

    const asRival = await getPlayerProfile({ id: r.id, role: "user" }, t.username);
    expect(asRival?.relation).toBe("active");
    expect(asRival?.rivalryId).toBe(rv.id);

    const asAdmin = await getPlayerProfile({ id: a.id, role: "admin" }, t.username);
    expect(asAdmin?.canSeeRivalries).toBe(true);
    expect(asAdmin?.rivalries).toHaveLength(1);
    expect(asAdmin?.recentMatches).toHaveLength(1);

    await db.update(users).set({ publicLeaderboard: true }).where(eq(users.id, t.id));
    const nowPublic = await getPlayerProfile({ id: v.id, role: "user" }, t.username);
    expect(nowPublic?.rivalries).toHaveLength(1);
    expect(nowPublic!.recentMatches[0].aGoals + nowPublic!.recentMatches[0].bGoals).toBe(3);
  });

  it("hides suspended and unknown players, and search never returns suspended ones", async () => {
    const s = await makeUser("psus");
    const v = await makeUser("pview");
    expect(await getPlayerProfile({ id: v.id, role: "user" }, s.username)).not.toBeNull();
    await db.update(users).set({ suspended: true }).where(eq(users.id, s.id));
    expect(await getPlayerProfile({ id: v.id, role: "user" }, s.username)).toBeNull();
    expect(await getPlayerProfile({ id: v.id, role: "user" }, "no_such_user_zz")).toBeNull();
    expect((await searchPlayers(s.username)).map((p) => p.username)).not.toContain(s.username);
    expect((await searchPlayers(v.username)).map((p) => p.username)).toContain(v.username);
  });
});
