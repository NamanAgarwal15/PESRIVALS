CREATE TABLE "clan_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clan_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clan_chat_body_length" CHECK (char_length("clan_chat_messages"."body") BETWEEN 1 AND 300)
);
--> statement-breakpoint
CREATE TABLE "clan_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"invited_by" uuid,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clan_invites_status" CHECK ("clan_invites"."status" IN ('pending','accepted','declined'))
);
--> statement-breakpoint
CREATE TABLE "clan_members" (
	"clan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(8) DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clan_members_clan_id_user_id_pk" PRIMARY KEY("clan_id","user_id"),
	CONSTRAINT "clan_members_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "clan_members_role" CHECK ("clan_members"."role" IN ('leader','officer','member'))
);
--> statement-breakpoint
CREATE TABLE "clan_war_pairings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"war_id" uuid NOT NULL,
	"slot_number" integer NOT NULL,
	"challenger_player_id" uuid NOT NULL,
	"defender_player_id" uuid NOT NULL,
	"match_id" uuid,
	"winner_player_id" uuid,
	"winner_clan_id" uuid,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	CONSTRAINT "clan_war_pairings_match_id_unique" UNIQUE("match_id"),
	CONSTRAINT "clan_war_pairings_slot_unique" UNIQUE("war_id","slot_number"),
	CONSTRAINT "clan_war_pairings_challenger_unique" UNIQUE("war_id","challenger_player_id"),
	CONSTRAINT "clan_war_pairings_defender_unique" UNIQUE("war_id","defender_player_id"),
	CONSTRAINT "clan_war_pairings_status" CHECK ("clan_war_pairings"."status" IN ('pending','completed')),
	CONSTRAINT "clan_war_pairings_distinct" CHECK ("clan_war_pairings"."challenger_player_id" <> "clan_war_pairings"."defender_player_id")
);
--> statement-breakpoint
CREATE TABLE "clan_wars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"challenger_clan_id" uuid NOT NULL,
	"defender_clan_id" uuid NOT NULL,
	"series_size" integer NOT NULL,
	"status" varchar(10) DEFAULT 'pending' NOT NULL,
	"challenger_wins" integer DEFAULT 0 NOT NULL,
	"defender_wins" integer DEFAULT 0 NOT NULL,
	"winner_clan_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "clan_wars_distinct" CHECK ("clan_wars"."challenger_clan_id" <> "clan_wars"."defender_clan_id"),
	CONSTRAINT "clan_wars_series" CHECK ("clan_wars"."series_size" IN (3, 5)),
	CONSTRAINT "clan_wars_status" CHECK ("clan_wars"."status" IN ('pending','active','completed','declined','cancelled')),
	CONSTRAINT "clan_wars_wins" CHECK ("clan_wars"."challenger_wins" >= 0 AND "clan_wars"."defender_wins" >= 0)
);
--> statement-breakpoint
CREATE TABLE "clans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(40) NOT NULL,
	"tag" varchar(6) NOT NULL,
	"description" varchar(200),
	"leader_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clans_name_unique" UNIQUE("name"),
	CONSTRAINT "clans_tag_unique" UNIQUE("tag"),
	CONSTRAINT "clans_tag_format" CHECK ("clans"."tag" ~ '^[A-Z0-9]{2,6}$')
);
--> statement-breakpoint
ALTER TABLE "clan_chat_messages" ADD CONSTRAINT "clan_chat_messages_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_chat_messages" ADD CONSTRAINT "clan_chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_invites" ADD CONSTRAINT "clan_invites_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_invites" ADD CONSTRAINT "clan_invites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_invites" ADD CONSTRAINT "clan_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_members" ADD CONSTRAINT "clan_members_clan_id_clans_id_fk" FOREIGN KEY ("clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_members" ADD CONSTRAINT "clan_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_war_pairings" ADD CONSTRAINT "clan_war_pairings_war_id_clan_wars_id_fk" FOREIGN KEY ("war_id") REFERENCES "public"."clan_wars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_war_pairings" ADD CONSTRAINT "clan_war_pairings_challenger_player_id_users_id_fk" FOREIGN KEY ("challenger_player_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_war_pairings" ADD CONSTRAINT "clan_war_pairings_defender_player_id_users_id_fk" FOREIGN KEY ("defender_player_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_war_pairings" ADD CONSTRAINT "clan_war_pairings_match_id_matches_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_war_pairings" ADD CONSTRAINT "clan_war_pairings_winner_player_id_users_id_fk" FOREIGN KEY ("winner_player_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_war_pairings" ADD CONSTRAINT "clan_war_pairings_winner_clan_id_clans_id_fk" FOREIGN KEY ("winner_clan_id") REFERENCES "public"."clans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_wars" ADD CONSTRAINT "clan_wars_challenger_clan_id_clans_id_fk" FOREIGN KEY ("challenger_clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_wars" ADD CONSTRAINT "clan_wars_defender_clan_id_clans_id_fk" FOREIGN KEY ("defender_clan_id") REFERENCES "public"."clans"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_wars" ADD CONSTRAINT "clan_wars_winner_clan_id_clans_id_fk" FOREIGN KEY ("winner_clan_id") REFERENCES "public"."clans"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_wars" ADD CONSTRAINT "clan_wars_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clans" ADD CONSTRAINT "clans_leader_id_users_id_fk" FOREIGN KEY ("leader_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clan_chat_clan_created_idx" ON "clan_chat_messages" USING btree ("clan_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "clan_invites_pending_unique" ON "clan_invites" USING btree ("clan_id","user_id") WHERE "clan_invites"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "clan_invites_user_status_idx" ON "clan_invites" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "clan_members_clan_idx" ON "clan_members" USING btree ("clan_id");--> statement-breakpoint
CREATE INDEX "clan_war_pairings_war_idx" ON "clan_war_pairings" USING btree ("war_id");--> statement-breakpoint
CREATE INDEX "clan_wars_challenger_idx" ON "clan_wars" USING btree ("challenger_clan_id","status");--> statement-breakpoint
CREATE INDEX "clan_wars_defender_idx" ON "clan_wars" USING btree ("defender_clan_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "clans_name_lower_unique" ON "clans" USING btree (lower("name"));