CREATE TABLE "clan_chat_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reported_user_id" uuid NOT NULL,
	"clan_message_id" uuid NOT NULL,
	"reason" varchar(16) NOT NULL,
	"status" varchar(12) DEFAULT 'open' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clan_chat_reports_reporter_message_unique" UNIQUE("reporter_id","clan_message_id"),
	CONSTRAINT "clan_chat_reports_reason" CHECK ("clan_chat_reports"."reason" IN ('spam','harassment','hate','links','other')),
	CONSTRAINT "clan_chat_reports_status" CHECK ("clan_chat_reports"."status" IN ('open','reviewed','dismissed')),
	CONSTRAINT "clan_chat_reports_not_self" CHECK ("clan_chat_reports"."reporter_id" <> "clan_chat_reports"."reported_user_id")
);
--> statement-breakpoint
ALTER TABLE "clan_chat_messages" ADD COLUMN "hidden" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "chat_muted_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clan_chat_reports" ADD CONSTRAINT "clan_chat_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_chat_reports" ADD CONSTRAINT "clan_chat_reports_reported_user_id_users_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_chat_reports" ADD CONSTRAINT "clan_chat_reports_clan_message_id_clan_chat_messages_id_fk" FOREIGN KEY ("clan_message_id") REFERENCES "public"."clan_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clan_chat_reports" ADD CONSTRAINT "clan_chat_reports_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clan_chat_reports_status_created_idx" ON "clan_chat_reports" USING btree ("status","created_at");