ALTER TABLE "users" DROP CONSTRAINT "users_phone_unique";--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_phone_e164";--> statement-breakpoint
ALTER TABLE "rivalries" DROP COLUMN "a_public";--> statement-breakpoint
ALTER TABLE "rivalries" DROP COLUMN "b_public";--> statement-breakpoint
ALTER TABLE "users" DROP COLUMN "phone";--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "efootball_id" varchar(32);
