CREATE TABLE "dm_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_a_id" uuid NOT NULL,
	"user_b_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dm_messages_user_order" CHECK ("dm_messages"."user_a_id" < "dm_messages"."user_b_id"),
	CONSTRAINT "dm_messages_sender_member" CHECK ("dm_messages"."sender_id" = "dm_messages"."user_a_id" OR "dm_messages"."sender_id" = "dm_messages"."user_b_id"),
	CONSTRAINT "dm_messages_body_length" CHECK (char_length("dm_messages"."body") BETWEEN 1 AND 500)
);
--> statement-breakpoint
CREATE TABLE "message_blocks" (
	"blocker_id" uuid NOT NULL,
	"blocked_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "message_blocks_blocker_id_blocked_id_pk" PRIMARY KEY("blocker_id","blocked_id"),
	CONSTRAINT "message_blocks_not_self" CHECK ("message_blocks"."blocker_id" <> "message_blocks"."blocked_id")
);
--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_user_a_id_users_id_fk" FOREIGN KEY ("user_a_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_user_b_id_users_id_fk" FOREIGN KEY ("user_b_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dm_messages" ADD CONSTRAINT "dm_messages_sender_id_users_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_blocks" ADD CONSTRAINT "message_blocks_blocker_id_users_id_fk" FOREIGN KEY ("blocker_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "message_blocks" ADD CONSTRAINT "message_blocks_blocked_id_users_id_fk" FOREIGN KEY ("blocked_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dm_messages_pair_created_idx" ON "dm_messages" USING btree ("user_a_id","user_b_id","created_at");--> statement-breakpoint
CREATE INDEX "message_blocks_blocked_idx" ON "message_blocks" USING btree ("blocked_id");