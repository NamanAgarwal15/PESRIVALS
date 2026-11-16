CREATE TABLE "login_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"window_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_accounts_provider_account_unique" UNIQUE("provider","provider_account_id")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "onboarded" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_email_lowercase" CHECK ("users"."email" IS NULL OR "users"."email" = lower("users"."email"));--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_phone_e164" CHECK ("users"."phone" IS NULL OR "users"."phone" ~ '^\+[1-9][0-9]{7,14}$');