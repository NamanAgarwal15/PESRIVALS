// Integration tests for src/lib/auth-helpers.ts against the LOCAL TEST database.
// Every row created here is tracked and deleted again in afterAll.

import { randomBytes, randomInt } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { loginThrottle, oauthAccounts, users } from "@/db/schema";
import {
  type GoogleProfile,
  type SignUpInput,
  claimUsername,
  parseIdentifier,
  resolveGoogleUser,
  signUpUser,
  verifyCredentials,
} from "@/lib/auth-helpers";

const RUN = `t${randomBytes(3).toString("hex")}`; // e.g. "t3fa91c"
const PASSWORD = "correct-horse-battery-1";

const createdUserIds = new Set<string>();
const throttleKeys = new Set<string>();

let counter = 0;
const uname = (label: string) => `${RUN}_${label}${counter++}`.slice(0, 20);
const email = (label: string) => `${RUN}.${label}${counter++}@example.com`;
const indianMobile = () => `98${randomInt(0, 100_000_000).toString().padStart(8, "0")}`;

async function signUp(input: Partial<SignUpInput> & { username: string }) {
  // Since the email-or-phone rule, signups without an explicit recovery
  // channel get a default email so older tests keep exercising the happy path.
  const hasChannel = input.email !== undefined || input.phone !== undefined;
  const result = await signUpUser({
    displayName: "Test Player",
    password: PASSWORD,
    ...(hasChannel ? {} : { email: email("auto") }),
    ...input,
  });
  if (result.ok) createdUserIds.add(result.user.id);
  return result;
}

async function mustSignUp(input: Partial<SignUpInput> & { username: string }) {
  const result = await signUp(input);
  if (!result.ok) throw new Error(`sign-up failed: ${JSON.stringify(result.errors)}`);
  return result.user;
}

async function login(identifier: string, password: string) {
  const parsed = parseIdentifier(identifier);
  if (parsed) throttleKeys.add(parsed.throttleKey);
  return verifyCredentials(identifier, password);
}

async function google(profile: GoogleProfile) {
  const user = await resolveGoogleUser(profile);
  createdUserIds.add(user.id);
  return user;
}

const sub = () => `${RUN}-google-${randomBytes(6).toString("hex")}`;

async function userRow(id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row;
}

async function throttleRow(key: string) {
  const [row] = await db.select().from(loginThrottle).where(eq(loginThrottle.key, key));
  return row;
}

afterAll(async () => {
  // oauth_accounts rows go with their user (ON DELETE CASCADE).
  if (createdUserIds.size) {
    await db.delete(users).where(inArray(users.id, [...createdUserIds]));
  }
  // Safety net for anything a failed test created but did not track.
  await db.delete(users).where(like(users.username, `${RUN}\\_%`));
  await db
    .delete(oauthAccounts)
    .where(like(oauthAccounts.providerAccountId, `${RUN}-google-%`));
  if (throttleKeys.size) {
    await db.delete(loginThrottle).where(inArray(loginThrottle.key, [...throttleKeys]));
  }
});

describe("sign-up", () => {
  it("creates a user from a username only (recovery channel auto-filled by the helper), trimmed and lowercased", async () => {
    const name = uname("plain");
    const user = await mustSignUp({
      username: `  ${name.toUpperCase()}  `,
      displayName: "  Naman  ",
    });

    expect(user.username).toBe(name);
    expect(user.displayName).toBe("Naman");
    expect(user.onboarded).toBe(true);

    const row = await userRow(user.id);
    expect(row.email).not.toBeNull();
    expect(row.phone).toBeNull();
    expect(row.isPlaceholder).toBe(false);
    expect(row.passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
  });

  it("requires an email or phone for account recovery", async () => {
    const blank = await signUp({ username: uname("blank"), email: "   ", phone: "" });
    expect(blank.ok).toBe(false);
    if (blank.ok) return;
    expect(blank.errors.form).toBe(
      "Please enter either an email address or a phone number for account recovery.",
    );

    // Blank phone is still stored as null when an email is present.
    const user = await mustSignUp({ username: uname("blank2"), email: email("b2"), phone: "" });
    const row = await userRow(user.id);
    expect(row.email).not.toBeNull();
    expect(row.phone).toBeNull();
  });

  it("lowercases the email", async () => {
    const address = email("mixed");
    const user = await mustSignUp({
      username: uname("email"),
      email: `  ${address.toUpperCase()} `,
    });
    expect((await userRow(user.id)).email).toBe(address);
  });

  it("normalizes an Indian phone number to E.164", async () => {
    const mobile = indianMobile();
    const user = await mustSignUp({
      username: uname("phone"),
      phone: `${mobile.slice(0, 5)} ${mobile.slice(5)}`,
    });
    expect((await userRow(user.id)).phone).toBe(`+91${mobile}`);
  });

  it("keeps the country of a number written with a + prefix", async () => {
    const user = await mustSignUp({
      username: uname("intl"),
      phone: "+44 7400 123456",
    });
    expect((await userRow(user.id)).phone).toBe("+447400123456");
  });

  it("rejects invalid fields without creating a user", async () => {
    const name = uname("bad");
    const result = await signUp({
      username: name,
      displayName: "x".repeat(41),
      password: "short",
      email: "not-an-email",
      phone: "12345",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(Object.keys(result.errors).sort()).toEqual([
      "displayName",
      "email",
      "password",
      "phone",
    ]);
    expect(await db.select().from(users).where(eq(users.username, name))).toHaveLength(0);
  });

  it("rejects malformed usernames", async () => {
    for (const bad of ["ab", "has space", "dash-ed", "x".repeat(21), "émile"]) {
      const result = await signUp({ username: bad });
      expect(result.ok, bad).toBe(false);
    }
  });

  it("rejects reserved usernames, in any case", async () => {
    for (const reserved of ["admin", "Home", "  API ", "rivalries", "administrator"]) {
      const result = await signUp({ username: reserved });
      expect(result.ok, reserved).toBe(false);
      if (!result.ok) expect(result.errors.username).toBeTruthy();
    }
  });

  it("rejects all-digit usernames, which login would read as a phone number", async () => {
    const result = await signUp({ username: "1234567" });
    expect(result.ok).toBe(false);
  });

  it("rejects a duplicate username, email or phone", async () => {
    const name = uname("dup");
    const address = email("dup");
    const mobile = indianMobile();
    await mustSignUp({ username: name, email: address, phone: mobile });

    const sameUsername = await signUp({ username: name.toUpperCase() });
    expect(sameUsername.ok).toBe(false);
    if (!sameUsername.ok) expect(sameUsername.errors.username).toBeTruthy();

    const sameEmail = await signUp({
      username: uname("dup"),
      email: address.toUpperCase(),
    });
    expect(sameEmail.ok).toBe(false);
    if (!sameEmail.ok) expect(sameEmail.errors.email).toBeTruthy();

    const samePhone = await signUp({ username: uname("dup"), phone: `+91 ${mobile}` });
    expect(samePhone.ok).toBe(false);
    if (!samePhone.ok) expect(samePhone.errors.phone).toBeTruthy();
  });

  it("the database itself rejects an uppercase email or a non-E.164 phone", async () => {
    const insert = (extra: { email?: string; phone?: string }) =>
      db
        .insert(users)
        .values({ username: uname("chk"), displayName: "Check", ...extra })
        .returning({ id: users.id })
        .then((rows) => rows.forEach((r) => createdUserIds.add(r.id)));

    await expect(insert({ email: `${RUN}.UPPER@example.com` })).rejects.toThrow();
    await expect(insert({ phone: "9876543210" })).rejects.toThrow();
  });
});

describe("credentials login", () => {
  it("logs in by username, email or phone", async () => {
    const name = uname("login");
    const address = email("login");
    const mobile = indianMobile();
    const user = await mustSignUp({ username: name, email: address, phone: mobile });

    const attempts = [
      name,
      `  ${name.toUpperCase()} `,
      address,
      address.toUpperCase(),
      mobile,
      `${mobile.slice(0, 5)}-${mobile.slice(5)}`,
      `+91 ${mobile}`,
    ];
    for (const identifier of attempts) {
      const result = await login(identifier, PASSWORD);
      expect(result?.id, identifier).toBe(user.id);
    }
    expect(await login(name, PASSWORD)).toMatchObject({
      username: name,
      displayName: "Test Player",
      onboarded: true,
    });
  });

  it("returns null for a wrong password, an unknown user or empty input", async () => {
    const name = uname("wrong");
    await mustSignUp({ username: name });

    expect(await login(name, "not-the-password")).toBeNull();
    expect(await login(uname("ghost"), PASSWORD)).toBeNull();
    expect(await login(email("ghost"), PASSWORD)).toBeNull();
    expect(await login(indianMobile(), PASSWORD)).toBeNull();
    expect(await login(name, "")).toBeNull();
    expect(await login("", PASSWORD)).toBeNull();
  });

  it("returns null for a user that has no password (Google-only)", async () => {
    const created = await google({ sub: sub(), name: "No Password" });
    expect(await login(created.username, PASSWORD)).toBeNull();
  });

  it("clears the failure counter on a successful login", async () => {
    const name = uname("reset");
    await mustSignUp({ username: name });
    const key = `cred:${name}`;

    await login(name, "wrong-1");
    await login(name, "wrong-2");
    expect((await throttleRow(key)).failures).toBe(2);

    expect(await login(name, PASSWORD)).not.toBeNull();
    expect(await throttleRow(key)).toBeUndefined();
  });

  it("locks the identifier for 15 minutes after 5 failures", async () => {
    const name = uname("lock");
    const user = await mustSignUp({ username: name });
    const key = `cred:${name}`;

    for (let i = 1; i <= 4; i++) {
      expect(await login(name, `wrong-${i}`)).toBeNull();
    }
    const beforeLock = await throttleRow(key);
    expect(beforeLock.failures).toBe(4);
    expect(beforeLock.lockedUntil).toBeNull();

    expect(await login(name, "wrong-5")).toBeNull();
    const locked = await throttleRow(key);
    expect(locked.failures).toBe(5);
    expect(locked.lockedUntil).not.toBeNull();
    const minutesLocked = (locked.lockedUntil!.getTime() - Date.now()) / 60_000;
    expect(minutesLocked).toBeGreaterThan(14);
    expect(minutesLocked).toBeLessThanOrEqual(15.1);

    // Even the correct password is refused while locked, and it is not counted.
    expect(await login(name, PASSWORD)).toBeNull();
    expect((await throttleRow(key)).failures).toBe(5);

    // Once the lock has expired the correct password works and resets the row.
    await db
      .update(loginThrottle)
      .set({
        lockedUntil: new Date(Date.now() - 1_000),
        windowStartedAt: new Date(Date.now() - 16 * 60_000),
      })
      .where(eq(loginThrottle.key, key));
    expect((await login(name, PASSWORD))?.id).toBe(user.id);
    expect(await throttleRow(key)).toBeUndefined();
  });

  it("also throttles identifiers that do not belong to any user", async () => {
    const name = uname("nobody");
    for (let i = 1; i <= 5; i++) await login(name, `wrong-${i}`);
    expect((await throttleRow(`cred:${name}`)).lockedUntil).not.toBeNull();
  });

  it("starts a new window when the last failures are older than 15 minutes", async () => {
    const name = uname("window");
    await mustSignUp({ username: name });
    const key = `cred:${name}`;

    for (let i = 1; i <= 4; i++) await login(name, `wrong-${i}`);
    await db
      .update(loginThrottle)
      .set({ windowStartedAt: new Date(Date.now() - 16 * 60_000) })
      .where(eq(loginThrottle.key, key));

    await login(name, "wrong-again");
    const row = await throttleRow(key);
    expect(row.failures).toBe(1);
    expect(row.lockedUntil).toBeNull();
  });
});

describe("Google sign-in", () => {
  const linksFor = (userId: string) =>
    db.select().from(oauthAccounts).where(eq(oauthAccounts.userId, userId));

  it("creates a not-yet-onboarded user with a temporary g_<hex> username", async () => {
    const googleId = sub();
    const address = email("gnew");
    const user = await google({
      sub: googleId,
      email: address.toUpperCase(),
      emailVerified: true,
      name: "G".repeat(50),
      picture: "https://example.com/avatar.png",
    });

    expect(user.username).toMatch(/^g_[0-9a-f]{10}$/);
    expect(user.onboarded).toBe(false);
    expect(user.displayName).toBe("G".repeat(40));

    const row = await userRow(user.id);
    expect(row.email).toBe(address);
    expect(row.imageUrl).toBe("https://example.com/avatar.png");
    expect(row.passwordHash).toBeNull();

    const links = await linksFor(user.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ provider: "google", providerAccountId: googleId });
  });

  it("falls back to the display name Player and drops an unverified email", async () => {
    const user = await google({
      sub: sub(),
      email: email("gunverified"),
      emailVerified: false,
      name: "   ",
    });
    expect(user.displayName).toBe("Player");
    expect((await userRow(user.id)).email).toBeNull();
  });

  it("signs in as the linked user when the Google account is already known", async () => {
    const googleId = sub();
    const first = await google({ sub: googleId, name: "Repeat" });
    // Different email this time: the existing link must still win.
    const second = await google({
      sub: googleId,
      email: email("gchanged"),
      emailVerified: true,
      name: "Repeat",
    });

    expect(second.id).toBe(first.id);
    expect(await linksFor(first.id)).toHaveLength(1);
  });

  it("links to an existing user whose email matches a VERIFIED Google email", async () => {
    const address = email("glink");
    const existing = await mustSignUp({ username: uname("glink"), email: address });
    const googleId = sub();

    const user = await google({
      sub: googleId,
      email: address.toUpperCase(),
      emailVerified: true,
      name: "Linked",
    });

    expect(user.id).toBe(existing.id);
    expect(user.username).toBe(existing.username);
    expect(user.onboarded).toBe(true);
    const links = await linksFor(existing.id);
    expect(links).toHaveLength(1);
    expect(links[0].providerAccountId).toBe(googleId);

    // The password still works after linking.
    expect((await login(existing.username, PASSWORD))?.id).toBe(existing.id);
  });

  it("does NOT link on an unverified email, even if it matches", async () => {
    const address = email("gspoof");
    const existing = await mustSignUp({ username: uname("gspoof"), email: address });

    const user = await google({
      sub: sub(),
      email: address,
      emailVerified: false,
      name: "Spoofer",
    });

    expect(user.id).not.toBe(existing.id);
    expect(user.onboarded).toBe(false);
    expect((await userRow(user.id)).email).toBeNull();
    expect(await linksFor(existing.id)).toHaveLength(0);
  });
});

describe("onboarding", () => {
  it("lets a Google user claim a permanent username", async () => {
    const created = await google({ sub: sub(), name: "Onboard Me" });
    const before = await userRow(created.id);
    const wanted = uname("claim");

    const result = await claimUsername(created.id, `  ${wanted.toUpperCase()} `);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).toMatchObject({ id: created.id, username: wanted, onboarded: true });

    const after = await userRow(created.id);
    expect(after.username).toBe(wanted);
    expect(after.onboarded).toBe(true);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(before.updatedAt.getTime());
  });

  it("rejects reserved, malformed and taken usernames and keeps the user un-onboarded", async () => {
    const taken = await mustSignUp({ username: uname("taken") });
    const created = await google({ sub: sub(), name: "Picky" });

    for (const bad of ["settings", "ab", "no spaces", "12345", taken.username]) {
      const result = await claimUsername(created.id, bad);
      expect(result.ok, bad).toBe(false);
    }

    const row = await userRow(created.id);
    expect(row.username).toBe(created.username);
    expect(row.onboarded).toBe(false);
  });

  it("refuses to rename a user who is already onboarded", async () => {
    const user = await mustSignUp({ username: uname("done") });
    const result = await claimUsername(user.id, uname("again"));
    expect(result.ok).toBe(false);
    expect((await userRow(user.id)).username).toBe(user.username);
  });
});

describe("cleanup bookkeeping", () => {
  it("tracked every user this run created", async () => {
    const mine = await db
      .select({ id: users.id })
      .from(users)
      .where(and(like(users.username, `${RUN}\\_%`)));
    for (const row of mine) expect(createdUserIds.has(row.id)).toBe(true);
  });
});
