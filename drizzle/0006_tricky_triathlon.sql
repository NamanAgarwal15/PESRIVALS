CREATE TABLE "admin_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_user_id" uuid,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" varchar(64) NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "device_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"fingerprint_hash" varchar(64) NOT NULL,
	"ip_hash" varchar(64),
	"user_agent" varchar(255),
	"seen_count" integer DEFAULT 1 NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sybil_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"flag_type" varchar(32) NOT NULL,
	"severity" varchar(16) NOT NULL,
	"primary_user_id" uuid NOT NULL,
	"related_user_id" uuid,
	"rivalry_id" uuid,
	"fingerprint_hash" varchar(64),
	"reason" text NOT NULL,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"resolved_by" uuid,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "matches" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "admin_audit_logs" ADD CONSTRAINT "admin_audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_sessions" ADD CONSTRAINT "device_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sybil_flags" ADD CONSTRAINT "sybil_flags_primary_user_id_users_id_fk" FOREIGN KEY ("primary_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sybil_flags" ADD CONSTRAINT "sybil_flags_related_user_id_users_id_fk" FOREIGN KEY ("related_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sybil_flags" ADD CONSTRAINT "sybil_flags_rivalry_id_rivalries_id_fk" FOREIGN KEY ("rivalry_id") REFERENCES "public"."rivalries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sybil_flags" ADD CONSTRAINT "sybil_flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_sessions_user_fingerprint_idx" ON "device_sessions" USING btree ("user_id","fingerprint_hash");--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;