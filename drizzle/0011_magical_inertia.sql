CREATE TABLE "chat_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reported_user_id" uuid NOT NULL,
	"global_message_id" uuid,
	"dm_message_id" uuid,
	"reason" varchar(16) NOT NULL,
	"status" varchar(12) DEFAULT 'open' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_reports_reporter_global_unique" UNIQUE("reporter_id","global_message_id"),
	CONSTRAINT "chat_reports_reporter_dm_unique" UNIQUE("reporter_id","dm_message_id"),
	CONSTRAINT "chat_reports_one_target" CHECK (("chat_reports"."global_message_id" IS NULL) <> ("chat_reports"."dm_message_id" IS NULL)),
	CONSTRAINT "chat_reports_reason" CHECK ("chat_reports"."reason" IN ('spam','harassment','hate','links','other')),
	CONSTRAINT "chat_reports_status" CHECK ("chat_reports"."status" IN ('open','reviewed','dismissed')),
	CONSTRAINT "chat_reports_not_self" CHECK ("chat_reports"."reporter_id" <> "chat_reports"."reported_user_id")
);
--> statement-breakpoint
CREATE TABLE "global_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"hidden" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "global_chat_body_length" CHECK (char_length("global_chat_messages"."body") BETWEEN 1 AND 300)
);
--> statement-breakpoint
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reporter_id_users_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reported_user_id_users_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_global_message_id_global_chat_messages_id_fk" FOREIGN KEY ("global_message_id") REFERENCES "public"."global_chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_dm_message_id_dm_messages_id_fk" FOREIGN KEY ("dm_message_id") REFERENCES "public"."dm_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_reports" ADD CONSTRAINT "chat_reports_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "global_chat_messages" ADD CONSTRAINT "global_chat_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_reports_status_created_idx" ON "chat_reports" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "global_chat_created_idx" ON "global_chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "global_chat_sender_created_idx" ON "global_chat_messages" USING btree ("sender_id","created_at");