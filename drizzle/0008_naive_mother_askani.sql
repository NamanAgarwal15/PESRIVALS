CREATE TABLE "user_insights" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"snapshot_hash" varchar(64) NOT NULL,
	"insights_json" jsonb NOT NULL,
	"source" varchar(16) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_insights" ADD CONSTRAINT "user_insights_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_insights_user_created_idx" ON "user_insights" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_insights_user_snapshot_idx" ON "user_insights" USING btree ("user_id","snapshot_hash");