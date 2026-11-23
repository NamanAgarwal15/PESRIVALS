CREATE TABLE "coach_chat_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"rivalry_id" uuid,
	"user_message" text NOT NULL,
	"assistant_reply" text NOT NULL,
	"source" varchar(16) NOT NULL,
	"flagged" boolean DEFAULT false NOT NULL,
	"flag_reason" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "coach_chat_logs" ADD CONSTRAINT "coach_chat_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "coach_chat_logs" ADD CONSTRAINT "coach_chat_logs_rivalry_id_rivalries_id_fk" FOREIGN KEY ("rivalry_id") REFERENCES "public"."rivalries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "coach_chat_logs_user_created_idx" ON "coach_chat_logs" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "coach_chat_logs_flagged_created_idx" ON "coach_chat_logs" USING btree ("flagged","created_at");