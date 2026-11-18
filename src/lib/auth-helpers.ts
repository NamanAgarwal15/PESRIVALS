// Auth logic that talks to the database. Framework-free on purpose (no
// next/* or next-auth imports) so it can be exercised directly by Vitest.

import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { z } from "zod";
import { db } from "@/db";
import { loginThrottle, oauthAccounts, users } from "@/db/schema";

export const GENERIC_LOGIN_ERROR = "Incorrect login details";

/** Shown when the database itself is unreachable during sign-up. */
export const GENERIC_SIGNUP_ERROR =
  "Could not create your account right now. Please try again in a moment.";

export const BCRYPT_COST = 12;
export const THROTTLE_MAX_FAILURES = 5;
export const THROTTLE_WINDOW_MINUTES = 15;
export const THROTTLE_LOCK_MINUTES = 15;

const DEFAULT_PHONE_COUNTRY = "IN";
const MAX_IDENTIFIER_LENGTH = 254;
const MAX_PASSWORD_LENGTH = 128;

// Hash of a random throwaway string. Compared against when the user is
// unknown or has no password, so those paths cost the same as a real check.
const DUMMY_PASSWORD_HASH =
  "$2b$12$gZJXc1hp3zqbDBXyysqhROkSllC/wsEq5rSaxyDd33K7aTt0hXcjW";

export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  "admin",
  "api",
  "app",
  "auth",
  "login",
  "logout",
  "signup",
  "signin",
  "register",
  "onboarding",
  "home",
  "settings",
  "profile",
  "user",
  "users",
  "me",
  "support",
  "help",
  "about",
  "root",
  "system",
  "null",
  "undefined",
  "rivalry",
  "rivalries",
  "match",
  "matches",
  "www",
  "administrator",
]);

/** The user fields that are threaded onto the JWT and the session. */
export type AuthUser = {
  id: string;
  username: string;
  displayName: string;
  onboarded: boolean;
  imageUrl: string | null;
  role: "user" | "admin";
  suspended: boolean;
  publicLeaderboard: boolean;
};

type UserRow = typeof users.$inferSelect;

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    onboarded: row.onboarded,
    imageUrl: row.imageUrl,
    role: row.role === "admin" ? "admin" : "user",
    suspended: row.suspended,
    publicLeaderboard: row.publicLeaderboard,
  };
}

/** True only when both Google OAuth variables are set. Safe to pass to the UI. */
export function isGoogleEnabled(): boolean {
  return Boolean(
    process.env.AUTH_GOOGLE_ID?.trim() && process.env.AUTH_GOOGLE_SECRET?.trim(),
  );
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Returns the phone number in E.164 form, or null if it is not a valid number. */
export function normalizePhone(input: string): string | null {
  const parsed = parsePhoneNumberFromString(input.trim(), DEFAULT_PHONE_COUNTRY);
  return parsed?.isValid() ? parsed.number : null;
}

export const usernameSchema = z
  .string({ error: "Enter a username" })
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9_]{3,20}$/,
    "Use 3 to 20 characters: lowercase letters, numbers or underscores",
  )
  // Login treats an all-digit identifier as a phone number, so an all-digit
  // username could never be used to log in.
  .refine((v) => !/^[0-9]+$/.test(v), "Username cannot be only numbers")
  .refine((v) => !RESERVED_USERNAMES.has(v), "That username is not available");

const blankToNull = (v: unknown) =>
  v === undefined || v === null || (typeof v === "string" && v.trim() === "")
    ? null
    : v;

export const signUpSchema = z.object({
  username: usernameSchema,
  displayName: z
    .string({ error: "Enter a display name" })
    .trim()
    .min(1, "Enter a display name")
    .max(40, "Display name can be at most 40 characters"),
  password: z
    .string({ error: "Enter a password" })
    .min(8, "Password must be at least 8 characters")
    .max(MAX_PASSWORD_LENGTH, `Password can be at most ${MAX_PASSWORD_LENGTH} characters`)
    .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), {
      message: "Password must include at least one letter and one number",
    })
    .refine(
      (v) => Buffer.byteLength(v, "utf8") <= MAX_PASSWORD_LENGTH,
      "Password is too long",
    ),
  email: z.preprocess(
    blankToNull,
    z
      .string()
      .trim()
      .toLowerCase()
      .max(254, "Enter a valid email address")
      .pipe(z.email("Enter a valid email address"))
      .nullable(),
  ),
  phone: z.preprocess(
    blankToNull,
    z
      .string()
      .transform((v, ctx) => {
        const e164 = normalizePhone(v);
        if (!e164) {
          ctx.addIssue({ code: "custom", message: "Enter a valid phone number" });
          return z.NEVER;
        }
        return e164;
      })
      .nullable(),
  ),
}).superRefine((data, ctx) => {
  // New signups must provide BOTH recovery channels. Existing live users who
  // signed up before this rule keep their accounts and can add the missing
  // channel from /home (Account Settings) — this only runs on new signups.
  if (!data.email) {
    ctx.addIssue({
      code: "custom",
      path: ["email"],
      message: "Enter an email address for account recovery.",
    });
  }
  if (!data.phone) {
    ctx.addIssue({
      code: "custom",
      path: ["phone"],
      message: "Enter a phone number for account recovery.",
    });
  }
});

/** Terms & leaderboard consent, required on new signups. */
export const agreeSchema = z.literal(true, {
  error:
    "Please agree to the Terms & Privacy Policy and the public leaderboard consent.",
});

/** Standalone password policy, reused by the reset-password flow. */
export const passwordSchema = z
  .string({ error: "Enter a password" })
  .min(8, "Password must be at least 8 characters")
  .max(128, "Password can be at most 128 characters")
  .refine((v) => /[a-zA-Z]/.test(v) && /[0-9]/.test(v), {
    message: "Password must include at least one letter and one number",
  });

// ---------------------------------------------------------------------------
// Account security overview (used by the /home card)
// ---------------------------------------------------------------------------

export type AccountSecurity = {
  email: string | null;
  phone: string | null;
  googleLinked: boolean;
  publicLeaderboard: boolean;
};

/** Recovery channels + Google link status for the logged-in user. */
export async function getAccountSecurity(userId: string): Promise<AccountSecurity | null> {
  const [row] = await db
    .select({ email: users.email, phone: users.phone, publicLeaderboard: users.publicLeaderboard })
    .from(users)
    .where(eq(users.id, userId));
  if (!row) return null;
  const [link] = await db
    .select({ id: oauthAccounts.id })
    .from(oauthAccounts)
    .where(and(eq(oauthAccounts.userId, userId), eq(oauthAccounts.provider, "google")));
  return { email: row.email, phone: row.phone, googleLinked: Boolean(link), publicLeaderboard: row.publicLeaderboard };
}

export type FieldErrors = Partial<Record<string, string>>;

function fieldErrorsFrom(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    out[field] ??= issue.message;
  }
  return out;
}

// Postgres unique_violation, whether thrown directly or wrapped by Drizzle.
function uniqueViolation(err: unknown): { constraint: string } | null {
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current; depth++) {
    const e = current as { code?: unknown; constraint?: unknown; cause?: unknown };
    if (e.code === "23505") {
      return { constraint: typeof e.constraint === "string" ? e.constraint : "" };
    }
    current = e.cause;
  }
  return null;
}

function duplicateFieldErrors(constraint: string): FieldErrors {
  if (constraint.includes("email")) {
    return { email: "That email is already in use" };
  }
  if (constraint.includes("phone")) {
    return { phone: "That phone number is already in use" };
  }
  return { username: "That username is already taken" };
}

// ---------------------------------------------------------------------------
// Sign-up
// ---------------------------------------------------------------------------

export type SignUpInput = {
  username: unknown;
  displayName: unknown;
  password: unknown;
  email?: unknown;
  phone?: unknown;
};

export type SignUpResult =
  | { ok: true; user: AuthUser }
  | { ok: false; errors: FieldErrors };

export async function signUpUser(input: SignUpInput): Promise<SignUpResult> {
  const parsed = signUpSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: fieldErrorsFrom(parsed.error) };
  }
  const { username, displayName, password, email, phone } = parsed.data;

  // Friendly per-field messages. The unique constraints below are what
  // actually guarantee uniqueness if two sign-ups race.
  let byUsername: { id: string }[] = [];
  let byEmail: { id: string }[] = [];
  let byPhone: { id: string }[] = [];
  try {
    [byUsername, byEmail, byPhone] = await Promise.all([
      db.select({ id: users.id }).from(users).where(eq(users.username, username)),
      email
        ? db.select({ id: users.id }).from(users).where(eq(users.email, email))
        : [],
      phone
        ? db.select({ id: users.id }).from(users).where(eq(users.phone, phone))
        : [],
    ]);
  } catch {
    // e.g. the database is unreachable or not migrated yet: show a clean
    // error instead of an unhandled server crash.
    return { ok: false, errors: { form: GENERIC_SIGNUP_ERROR } };
  }
  const errors: FieldErrors = {};
  if (byUsername.length) errors.username = "That username is already taken";
  if (byEmail.length) errors.email = "That email is already in use";
  if (byPhone.length) errors.phone = "That phone number is already in use";
  if (Object.keys(errors).length) return { ok: false, errors };

  const passwordHash = await bcrypt.hash(password, BCRYPT_COST);

  try {
    const [row] = await db
      .insert(users)
      .values({
        username,
        displayName,
        email,
        phone,
        passwordHash,
        onboarded: true,
        updatedAt: new Date(),
      })
      .returning();
    return { ok: true, user: toAuthUser(row) };
  } catch (err) {
    const dup = uniqueViolation(err);
    if (dup) return { ok: false, errors: duplicateFieldErrors(dup.constraint) };
    // Any other database failure becomes a clean form error too.
    return { ok: false, errors: { form: GENERIC_SIGNUP_ERROR } };
  }
}

// ---------------------------------------------------------------------------
// Credentials login
// ---------------------------------------------------------------------------

export type ParsedIdentifier = {
  kind: "email" | "phone" | "username";
  /** Value to look up, or null when it can never match a user. */
  lookup: string | null;
  /** Row key in login_throttle. */
  throttleKey: string;
};

export function parseIdentifier(raw: string): ParsedIdentifier | null {
  const id = raw.trim();
  if (!id || id.length > MAX_IDENTIFIER_LENGTH) return null;

  if (id.includes("@")) {
    const email = id.toLowerCase();
    return { kind: "email", lookup: email, throttleKey: `cred:${email}` };
  }

  if (id.startsWith("+") || /^[0-9\s-]+$/.test(id)) {
    const e164 = normalizePhone(id);
    const normalized = e164 ?? id.replace(/[\s-]/g, "");
    return { kind: "phone", lookup: e164, throttleKey: `cred:${normalized}` };
  }

  const username = id.toLowerCase();
  return { kind: "username", lookup: username, throttleKey: `cred:${username}` };
}

async function isLocked(key: string): Promise<boolean> {
  const [row] = await db
    .select({ lockedUntil: loginThrottle.lockedUntil })
    .from(loginThrottle)
    .where(eq(loginThrottle.key, key));
  return Boolean(row?.lockedUntil && row.lockedUntil.getTime() > Date.now());
}

// One atomic statement: start or restart the window, count the failure, and
// lock the key once the limit is reached.
async function recordFailure(key: string): Promise<void> {
  const windowExpired = sql`${loginThrottle.windowStartedAt} < now() - make_interval(mins => ${THROTTLE_WINDOW_MINUTES})`;
  await db
    .insert(loginThrottle)
    .values({ key, failures: 1 })
    .onConflictDoUpdate({
      target: loginThrottle.key,
      set: {
        failures: sql`CASE WHEN ${windowExpired} THEN 1 ELSE ${loginThrottle.failures} + 1 END`,
        windowStartedAt: sql`CASE WHEN ${windowExpired} THEN now() ELSE ${loginThrottle.windowStartedAt} END`,
        lockedUntil: sql`CASE WHEN NOT (${windowExpired}) AND ${loginThrottle.failures} + 1 >= ${THROTTLE_MAX_FAILURES} THEN now() + make_interval(mins => ${THROTTLE_LOCK_MINUTES}) ELSE NULL END`,
      },
    });
}

async function clearThrottle(key: string): Promise<void> {
  await db.delete(loginThrottle).where(eq(loginThrottle.key, key));
}

async function findUserForLogin(id: ParsedIdentifier): Promise<UserRow | undefined> {
  if (!id.lookup) return undefined;
  const column =
    id.kind === "email"
      ? users.email
      : id.kind === "phone"
        ? users.phone
        : users.username;
  const [row] = await db.select().from(users).where(eq(column, id.lookup));
  return row;
}

/**
 * Checks an identifier (username, email or phone) and password.
 * Returns null for every kind of failure (unknown user, wrong password,
 * throttled) so callers cannot tell them apart.
 */
export async function verifyCredentials(
  identifier: unknown,
  password: unknown,
): Promise<AuthUser | null> {
  const parsed = typeof identifier === "string" ? parseIdentifier(identifier) : null;
  const candidate =
    typeof password === "string" &&
    password.length > 0 &&
    Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_LENGTH
      ? password
      : null;

  if (!parsed || candidate === null) {
    await bcrypt.compare("invalid", DUMMY_PASSWORD_HASH);
    return null;
  }

  if (await isLocked(parsed.throttleKey)) {
    await bcrypt.compare(candidate, DUMMY_PASSWORD_HASH);
    return null;
  }

  const user = await findUserForLogin(parsed);
  const matches = await bcrypt.compare(
    candidate,
    user?.passwordHash ?? DUMMY_PASSWORD_HASH,
  );

  if (!user?.passwordHash || !matches) {
    await recordFailure(parsed.throttleKey);
    return null;
  }
  if (user.suspended) {
    // Suspended accounts can never log in; keep the reason generic.
    await recordFailure(parsed.throttleKey);
    return null;
  }

  await clearThrottle(parsed.throttleKey);
  return toAuthUser(user);
}

// ---------------------------------------------------------------------------
// Google OAuth
// ---------------------------------------------------------------------------

export type GoogleProfile = {
  /** Google's stable account id (`sub`). */
  sub: string;
  email?: string | null;
  emailVerified?: boolean;
  name?: string | null;
  picture?: string | null;
};

const GOOGLE = "google";

async function findUserByOauth(providerAccountId: string) {
  const [row] = await db
    .select({ user: users })
    .from(oauthAccounts)
    .innerJoin(users, eq(users.id, oauthAccounts.userId))
    .where(
      and(
        eq(oauthAccounts.provider, GOOGLE),
        eq(oauthAccounts.providerAccountId, providerAccountId),
      ),
    );
  return row?.user;
}

/**
 * Maps a Google sign-in to a PESRIVALS user:
 *  1. an existing oauth_accounts link wins;
 *  2. else a VERIFIED Google email that matches users.email gets linked;
 *  3. else a new, not-yet-onboarded user is created with a g_<hex> username.
 */
export async function resolveGoogleUser(profile: GoogleProfile): Promise<AuthUser> {
  if (!profile.sub) throw new Error("Google profile has no account id");

  const linked = await findUserByOauth(profile.sub);
  if (linked) return toAuthUser(linked);

  const verifiedEmail =
    profile.emailVerified === true && profile.email
      ? profile.email.trim().toLowerCase()
      : null;

  if (verifiedEmail) {
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, verifiedEmail));
    if (existing) {
      await db
        .insert(oauthAccounts)
        .values({
          userId: existing.id,
          provider: GOOGLE,
          providerAccountId: profile.sub,
        })
        .onConflictDoNothing();
      // If another request linked this Google account first, honour that link.
      return toAuthUser((await findUserByOauth(profile.sub)) ?? existing);
    }
  }

  const displayName = (profile.name?.trim() || "Player").slice(0, 40);

  for (let attempt = 0; attempt < 5; attempt++) {
    let created: UserRow;
    try {
      [created] = await db
        .insert(users)
        .values({
          username: `g_${randomBytes(5).toString("hex")}`,
          displayName,
          email: verifiedEmail,
          imageUrl: profile.picture ?? null,
          onboarded: false,
          updatedAt: new Date(),
        })
        .returning();
    } catch (err) {
      const dup = uniqueViolation(err);
      if (!dup) throw err;
      if (dup.constraint.includes("email")) {
        // The email was registered a moment ago: take the linking path instead.
        return resolveGoogleUser(profile);
      }
      continue; // temporary username collision: pick another one
    }

    const inserted = await db
      .insert(oauthAccounts)
      .values({
        userId: created.id,
        provider: GOOGLE,
        providerAccountId: profile.sub,
      })
      .onConflictDoNothing()
      .returning({ id: oauthAccounts.id });

    if (inserted.length) return toAuthUser(created);

    // A parallel sign-in linked this Google account first: drop our duplicate.
    await db.delete(users).where(eq(users.id, created.id));
    const winner = await findUserByOauth(profile.sub);
    if (winner) return toAuthUser(winner);
  }

  throw new Error("Could not create a user for this Google account");
}

// ---------------------------------------------------------------------------
// Onboarding and session refresh
// ---------------------------------------------------------------------------

export type ClaimUsernameResult =
  | { ok: true; user: AuthUser }
  | { ok: false; error: string };

/** Lets a not-yet-onboarded user swap their temporary username for a real one. */
export async function claimUsername(
  userId: string,
  username: unknown,
): Promise<ClaimUsernameResult> {
  const parsed = usernameSchema.safeParse(username);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid username" };
  }

  try {
    const [row] = await db
      .update(users)
      .set({ username: parsed.data, onboarded: true, updatedAt: new Date() })
      .where(and(eq(users.id, userId), eq(users.onboarded, false)))
      .returning();
    if (!row) return { ok: false, error: "This account is already set up" };
    return { ok: true, user: toAuthUser(row) };
  } catch (err) {
    if (uniqueViolation(err)) {
      return { ok: false, error: "That username is already taken" };
    }
    throw err;
  }
}

export async function getAuthUserById(id: string): Promise<AuthUser | null> {
  const [row] = await db.select().from(users).where(eq(users.id, id));
  return row ? toAuthUser(row) : null;
}
