import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  jsonb,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
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
    // Optional in-game ID, shown on the profile so rivals can add each other.
    efootballId: varchar("efootball_id", { length: 32 }),
    passwordHash: text("password_hash"),
    imageUrl: text("image_url"),
    isPlaceholder: boolean("is_placeholder").notNull().default(false),
    // false only for Google sign-ups that still hold a temporary g_<hex> username.
    onboarded: boolean("onboarded").notNull().default(true),
    // RBAC: only 'user' and 'admin'. Admins see /admin.
    role: text("role").notNull().default("user"),
    // Peer rivalry privacy: when false, non-rivals cannot see this player's
    // individual rivalries or match logs (career stats stay public).
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
    channel: text("channel").notNull(), // always 'email'
    identifier: text("identifier").notNull(), // email address
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

    // 1-tap match context (all optional).
    playstyleA: varchar("playstyle_a", { length: 32 }),
    playstyleB: varchar("playstyle_b", { length: 32 }),
    isExtraTime: boolean("is_extra_time").default(false),
    isPenalties: boolean("is_penalties").default(false),
    matchContext: varchar("match_context", { length: 32 }),

    // Soft delete: a non-null deleted_at hides the match everywhere.
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedBy: uuid("deleted_by").references(() => users.id, { onDelete: "set null" }),

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

/** Web Push subscriptions. The p256dh and auth keys are AES-256-GCM encrypted. */
export const pushSubscriptions = pgTable("push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dhEncrypted: text("p256dh_encrypted").notNull(),
  authEncrypted: text("auth_encrypted").notNull(),
  userAgent: varchar("user_agent", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
});

/** One row per (user, device fingerprint). The hash is computed in the browser. */
export const deviceSessions = pgTable(
  "device_sessions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fingerprintHash: varchar("fingerprint_hash", { length: 64 }).notNull(),
    ipHash: varchar("ip_hash", { length: 64 }),
    userAgent: varchar("user_agent", { length: 255 }),
    seenCount: integer("seen_count").notNull().default(1),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("device_sessions_user_fingerprint_idx").on(t.userId, t.fingerprintHash)],
);

/** Anti-sybil anomalies. Always reviewed by an admin; never an automatic ban. */
export const sybilFlags = pgTable("sybil_flags", {
  id: uuid("id").primaryKey().defaultRandom(),
  flagType: varchar("flag_type", { length: 32 }).notNull(),
  severity: varchar("severity", { length: 16 }).notNull(),
  primaryUserId: uuid("primary_user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  relatedUserId: uuid("related_user_id").references(() => users.id, { onDelete: "set null" }),
  rivalryId: uuid("rivalry_id").references(() => rivalries.id, { onDelete: "set null" }),
  fingerprintHash: varchar("fingerprint_hash", { length: 64 }),
  reason: text("reason").notNull(),
  status: varchar("status", { length: 16 }).notNull().default("open"),
  resolvedBy: uuid("resolved_by").references(() => users.id, { onDelete: "set null" }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only record of admin actions (the app only ever inserts and reads). */
export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  action: varchar("action", { length: 64 }).notNull(),
  targetType: varchar("target_type", { length: 32 }).notNull(),
  targetId: varchar("target_id", { length: 64 }).notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Cached coaching insights per user. One row per (user, snapshot of their
 * confirmed matches), so a page refresh without new matches never regenerates.
 */
export const userInsights = pgTable(
  "user_insights",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    snapshotHash: varchar("snapshot_hash", { length: 64 }).notNull(),
    // Array of { id, title, body, category, generatedAt }.
    insightsJson: jsonb("insights_json").notNull(),
    // 'ai' or 'deterministic'.
    source: varchar("source", { length: 16 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_insights_user_created_idx").on(t.userId, t.createdAt),
    uniqueIndex("user_insights_user_snapshot_idx").on(t.userId, t.snapshotHash),
  ],
);

/** Every Rivalry Coach exchange (sanitised), kept so admins can review abuse and quality. */
export const coachChatLogs = pgTable(
  "coach_chat_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    rivalryId: uuid("rivalry_id").references(() => rivalries.id, { onDelete: "set null" }),
    userMessage: text("user_message").notNull(),
    assistantReply: text("assistant_reply").notNull(),
    // 'ai' | 'deterministic' | 'guard'
    source: varchar("source", { length: 16 }).notNull(),
    flagged: boolean("flagged").notNull().default(false),
    flagReason: varchar("flag_reason", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("coach_chat_logs_user_created_idx").on(t.userId, t.createdAt),
    index("coach_chat_logs_flagged_created_idx").on(t.flagged, t.createdAt),
  ],
);

/**
 * 1v1 player chat. There is no client-visible thread id: a thread is the
 * canonical pair (lower uuid = user_a, as for rivalries), derived on the server
 * from the session user and the other player, so there is nothing to guess (no IDOR).
 */
export const dmMessages = pgTable(
  "dm_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userAId: uuid("user_a_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    userBId: uuid("user_b_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("dm_messages_user_order", sql`${t.userAId} < ${t.userBId}`),
    check("dm_messages_sender_member", sql`${t.senderId} = ${t.userAId} OR ${t.senderId} = ${t.userBId}`),
    check("dm_messages_body_length", sql`char_length(${t.body}) BETWEEN 1 AND 500`),
    index("dm_messages_pair_created_idx").on(t.userAId, t.userBId, t.createdAt),
  ],
);

/**
 * "Block Msgs Only (Keep Challenge Open)": blocker no longer receives messages from
 * blocked. This table is read by chat code ONLY; rivalry/challenge code never looks at it.
 */
export const messageBlocks = pgTable(
  "message_blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.blockerId, t.blockedId] }),
    check("message_blocks_not_self", sql`${t.blockerId} <> ${t.blockedId}`),
    index("message_blocks_blocked_idx").on(t.blockedId),
  ],
);

/** Global lobby chat. Short-lived: rows older than the retention window (and not under report) are pruned. */
export const globalChatMessages = pgTable(
  "global_chat_messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    senderId: uuid("sender_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    body: text("body").notNull(),
    // Set by an admin from the report queue; hidden rows are never served.
    hidden: boolean("hidden").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("global_chat_body_length", sql`char_length(${t.body}) BETWEEN 1 AND 300`),
    index("global_chat_created_idx").on(t.createdAt),
    index("global_chat_sender_created_idx").on(t.senderId, t.createdAt),
  ],
);

/** Player reports of abusive chat messages (global lobby or 1v1 DM). Reviewed by admins only. */
export const chatReports = pgTable(
  "chat_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // The author of the reported message (denormalised for the queue).
    reportedUserId: uuid("reported_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Exactly one of the two message ids is set.
    globalMessageId: uuid("global_message_id").references(() => globalChatMessages.id, { onDelete: "cascade" }),
    dmMessageId: uuid("dm_message_id").references(() => dmMessages.id, { onDelete: "cascade" }),
    // 'spam' | 'harassment' | 'hate' | 'links' | 'other'
    reason: varchar("reason", { length: 16 }).notNull(),
    // 'open' | 'reviewed' | 'dismissed'
    status: varchar("status", { length: 12 }).notNull().default("open"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check("chat_reports_one_target", sql`(${t.globalMessageId} IS NULL) <> (${t.dmMessageId} IS NULL)`),
    check("chat_reports_reason", sql`${t.reason} IN ('spam','harassment','hate','links','other')`),
    check("chat_reports_status", sql`${t.status} IN ('open','reviewed','dismissed')`),
    check("chat_reports_not_self", sql`${t.reporterId} <> ${t.reportedUserId}`),
    // One report per reporter per message: report spam is impossible.
    unique("chat_reports_reporter_global_unique").on(t.reporterId, t.globalMessageId),
    unique("chat_reports_reporter_dm_unique").on(t.reporterId, t.dmMessageId),
    index("chat_reports_status_created_idx").on(t.status, t.createdAt),
  ],
);
