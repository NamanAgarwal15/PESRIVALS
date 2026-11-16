CREATE TYPE "public"."match_source" AS ENUM('import', 'screenshot');--> statement-breakpoint
CREATE TYPE "public"."match_status" AS ENUM('confirmed', 'pending', 'disputed');--> statement-breakpoint
CREATE TYPE "public"."rivalry_status" AS ENUM('pending', 'active', 'declined', 'blocked');--> statement-breakpoint
CREATE TABLE "matches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rivalry_id" uuid NOT NULL,
	"match_no" integer NOT NULL,
	"played_at" date,
	"host_user_id" uuid,
	"created_by" uuid,
	"source" "match_source" NOT NULL,
	"status" "match_status" DEFAULT 'confirmed' NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"source_sheet_row" integer,
	"user_a_team" text NOT NULL,
	"user_b_team" text NOT NULL,
	"user_a_goals" smallint NOT NULL,
	"user_b_goals" smallint NOT NULL,
	"decided_on_pens" boolean DEFAULT false NOT NULL,
	"remark" text,
	"user_a_possession" smallint,
	"user_b_possession" smallint,
	"user_a_shots" smallint,
	"user_b_shots" smallint,
	"user_a_shots_on_target" smallint,
	"user_b_shots_on_target" smallint,
	"user_a_fouls" smallint,
	"user_b_fouls" smallint,
	"user_a_offsides" smallint,
	"user_b_offsides" smallint,
	"user_a_corners" smallint,
	"user_b_corners" smallint,
	"user_a_free_kicks" smallint,
	"user_b_free_kicks" smallint,
	"user_a_passes" smallint,
	"user_b_passes" smallint,
	"user_a_successful_passes" smallint,
	"user_b_successful_passes" smallint,
	"user_a_crosses" smallint,
	"user_b_crosses" smallint,
	"user_a_interceptions" smallint,
	"user_b_interceptions" smallint,
	"user_a_tackles" smallint,
	"user_b_tackles" smallint,
	"user_a_saves" smallint,
	"user_b_saves" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "matches_rivalry_match_no_unique" UNIQUE("rivalry_id","match_no"),
	CONSTRAINT "matches_goals_range" CHECK ("matches"."user_a_goals" BETWEEN 0 AND 99 AND "matches"."user_b_goals" BETWEEN 0 AND 99),
	CONSTRAINT "matches_user_a_possession_range" CHECK ("matches"."user_a_possession" BETWEEN 0 AND 100),
	CONSTRAINT "matches_user_b_possession_range" CHECK ("matches"."user_b_possession" BETWEEN 0 AND 100),
	CONSTRAINT "matches_user_a_shots_on_target_lte_shots" CHECK ("matches"."user_a_shots_on_target" <= "matches"."user_a_shots"),
	CONSTRAINT "matches_user_b_shots_on_target_lte_shots" CHECK ("matches"."user_b_shots_on_target" <= "matches"."user_b_shots"),
	CONSTRAINT "matches_user_a_successful_passes_lte_passes" CHECK ("matches"."user_a_successful_passes" <= "matches"."user_a_passes"),
	CONSTRAINT "matches_user_b_successful_passes_lte_passes" CHECK ("matches"."user_b_successful_passes" <= "matches"."user_b_passes")
);
--> statement-breakpoint
CREATE TABLE "rivalries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_a_id" uuid NOT NULL,
	"user_b_id" uuid NOT NULL,
	"status" "rivalry_status" DEFAULT 'pending' NOT NULL,
	"requested_by" uuid NOT NULL,
	"a_public" boolean DEFAULT false NOT NULL,
	"b_public" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "rivalries_user_pair_unique" UNIQUE("user_a_id","user_b_id"),
	CONSTRAINT "rivalries_user_order" CHECK ("rivalries"."user_a_id" < "rivalries"."user_b_id"),
	CONSTRAINT "rivalries_requested_by_member" CHECK ("rivalries"."requested_by" = "rivalries"."user_a_id" OR "rivalries"."requested_by" = "rivalries"."user_b_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"username" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"phone" text,
	"password_hash" text,
	"image_url" text,
	"is_placeholder" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_username_unique" UNIQUE("username"),
	CONSTRAINT "users_email_unique" UNIQUE("email"),
	CONSTRAINT "users_phone_unique" UNIQUE("phone"),
	CONSTRAINT "users_username_format" CHECK ("users"."username" ~ '^[a-z0-9_]{3,20}$')
);
--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_rivalry_id_rivalries_id_fk" FOREIGN KEY ("rivalry_id") REFERENCES "public"."rivalries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_host_user_id_users_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rivalries" ADD CONSTRAINT "rivalries_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rivalries" ADD CONSTRAINT "rivalries_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "rivalries" ADD CONSTRAINT "rivalries_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "matches_rivalry_played_at_idx" ON "matches" USING btree ("rivalry_id","played_at");