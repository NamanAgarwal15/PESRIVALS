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
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check("users_username_format", sql`${t.username} ~ '^[a-z0-9_]{3,20}$'`),
  ],
);

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
