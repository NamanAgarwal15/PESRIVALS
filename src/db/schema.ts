import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

export const rivalryStatus = pgEnum("rivalry_status", [
  "pending",
  "active",
  "declined",
  "blocked",
]);

export const matchSource = pgEnum("match_source", ["import", "screenshot"]);

export const matchStatus = pgEnum("match_status", [
  "confirmed",
  "pending",
  "disputed",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    username: text("username").notNull().unique(),
    displayName: text("display_name").notNull(),
    email: text("email").unique(),
    phone: text("phone").unique(),
    passwordHash: text("password_hash"),
    imageUrl: text("image_url"),
    isPlaceholder: boolean("is_placeholder").notNull().default(false),
    // false only for Google sign-ups that still hold a temporary g_<hex> username.
    onboarded: boolean("onboarded").notNull().default(true),
    // RBAC: only 'user' and 'admin'. Admins see /admin.
    role: text("role").notNull().default("user"),
    // Aggregated career stats may appear on the public leaderboard.
    publicLeaderboard: boolean("public_leaderboard").notNull().default(true),
    // Suspended accounts cannot log in and are hidden from the leaderboard.
    suspended: boolean("suspended").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("users_username_format", sql`${t.username} ~ '^[a-z0-9_]{3,20}$'`),
    check(
      "users_email_lowercase",
      sql`${t.email} IS NULL OR ${t.email} = lower(${t.email})`,
    ),
    check(
      "users_phone_e164",
      sql`${t.phone} IS NULL OR ${t.phone} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
  ],
);

// One row per external identity (e.g. a Google account) linked to a user.
export const oauthAccounts = pgTable(
  "oauth_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerAccountId: text("provider_account_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("oauth_accounts_provider_account_unique").on(
      t.provider,
      t.providerAccountId,
    ),
  ],
);

// Brute-force counter for credentials login, keyed by "cred:<identifier>".
export const loginThrottle = pgTable("login_throttle", {
  key: text("key").primaryKey(),
  failures: integer("failures").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
});

// Generic DB-backed rate limiter, keyed like "signup:ip:1.2.3.4".
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStartedAt: timestamp("window_started_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// Single-use password reset tokens. Only the SHA-256 hash of the token is
// stored; the raw token exists solely in the reset link sent to the user.
export const passwordResetTokens = pgTable(
  "password_reset_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("password_reset_tokens_hash_idx").on(t.tokenHash)],
);

// One-time 6-digit login/recovery codes. Only the SHA-256 hash of the code is
// stored; max 3 verification attempts, 10 minute expiry, single use.
export const otpCodes = pgTable(
  "otp_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // 'email' | 'phone'
    identifier: text("identifier").notNull(), // email address or E.164 phone
    codeHash: text("code_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    attempts: integer("attempts").notNull().default(0),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("otp_codes_identifier_idx").on(t.identifier)],
);

// Small key/value settings store (e.g. the global announcement banner).
export const siteSettings = pgTable("site_settings", {
  key: text("key").primaryKey(),
  value: text("value"),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

// A pair of users can have only one rivalry. The lower uuid is ALWAYS user_a
// (enforced by rivalries_user_order), so (user_a_id, user_b_id) is canonical.
export const rivalries = pgTable(
  "rivalries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userAId: uuid("user_a_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userBId: uuid("user_b_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: rivalryStatus("status").notNull().default("pending"),
    requestedBy: uuid("requested_by")
      .notNull()
      .references(() => users.id),
    aPublic: boolean("a_public").notNull().default(false),
    bPublic: boolean("b_public").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  },
  (t) => [
    unique("rivalries_user_pair_unique").on(t.userAId, t.userBId),
    check("rivalries_user_order", sql`${t.userAId} < ${t.userBId}`),
    check(
      "rivalries_requested_by_member",
      sql`${t.requestedBy} = ${t.userAId} OR ${t.requestedBy} = ${t.userBId}`,
    ),
  ],
);

// user_a / user_b on a match always mean the rivalry's canonical user_a / user_b.
export const matches = pgTable(
  "matches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    rivalryId: uuid("rivalry_id")
      .notNull()
      .references(() => rivalries.id, { onDelete: "cascade" }),
    matchNo: integer("match_no").notNull(),
    playedAt: date("played_at"),
    hostUserId: uuid("host_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdBy: uuid("created_by").references(() => users.id, {
      onDelete: "set null",
    }),
    source: matchSource("source").notNull(),
    status: matchStatus("status").notNull().default("confirmed"),
    needsReview: boolean("needs_review").notNull().default(false),
    sourceSheetRow: integer("source_sheet_row"),
    userATeam: text("user_a_team").notNull(),
    userBTeam: text("user_b_team").notNull(),
    userAGoals: smallint("user_a_goals").notNull(),
    userBGoals: smallint("user_b_goals").notNull(),
    decidedOnPens: boolean("decided_on_pens").notNull().default(false),
    remark: text("remark"),

    // Stats: all nullable, one column per side.
    userAPossession: smallint("user_a_possession"),
    userBPossession: smallint("user_b_possession"),
    userAShots: smallint("user_a_shots"),
    userBShots: smallint("user_b_shots"),
    userAShotsOnTarget: smallint("user_a_shots_on_target"),
    userBShotsOnTarget: smallint("user_b_shots_on_target"),
    userAFouls: smallint("user_a_fouls"),
    userBFouls: smallint("user_b_fouls"),
    userAOffsides: smallint("user_a_offsides"),
    userBOffsides: smallint("user_b_offsides"),
    userACorners: smallint("user_a_corners"),
    userBCorners: smallint("user_b_corners"),
    userAFreeKicks: smallint("user_a_free_kicks"),
    userBFreeKicks: smallint("user_b_free_kicks"),
    userAPasses: smallint("user_a_passes"),
    userBPasses: smallint("user_b_passes"),
    userASuccessfulPasses: smallint("user_a_successful_passes"),
    userBSuccessfulPasses: smallint("user_b_successful_passes"),
    userACrosses: smallint("user_a_crosses"),
    userBCrosses: smallint("user_b_crosses"),
    userAInterceptions: smallint("user_a_interceptions"),
    userBInterceptions: smallint("user_b_interceptions"),
    userATackles: smallint("user_a_tackles"),
    userBTackles: smallint("user_b_tackles"),
    userASaves: smallint("user_a_saves"),
    userBSaves: smallint("user_b_saves"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("matches_rivalry_match_no_unique").on(t.rivalryId, t.matchNo),
    index("matches_rivalry_played_at_idx").on(t.rivalryId, t.playedAt),
    check(
      "matches_goals_range",
      sql`${t.userAGoals} BETWEEN 0 AND 99 AND ${t.userBGoals} BETWEEN 0 AND 99`,
    ),
    check(
      "matches_user_a_possession_range",
      sql`${t.userAPossession} BETWEEN 0 AND 100`,
    ),
    check(
      "matches_user_b_possession_range",
      sql`${t.userBPossession} BETWEEN 0 AND 100`,
    ),
    check(
      "matches_user_a_shots_on_target_lte_shots",
      sql`${t.userAShotsOnTarget} <= ${t.userAShots}`,
    ),
    check(
      "matches_user_b_shots_on_target_lte_shots",
      sql`${t.userBShotsOnTarget} <= ${t.userBShots}`,
    ),
    check(
      "matches_user_a_successful_passes_lte_passes",
      sql`${t.userASuccessfulPasses} <= ${t.userAPasses}`,
    ),
    check(
      "matches_user_b_successful_passes_lte_passes",
      sql`${t.userBSuccessfulPasses} <= ${t.userBPasses}`,
    ),
  ],
);
