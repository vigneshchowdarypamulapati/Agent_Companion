ALTER TABLE "users" DROP CONSTRAINT "users_email_unique";--> statement-breakpoint
ALTER TABLE "pairing_codes" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "device_code" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "device_name" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD COLUMN "redeemed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "clerk_user_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "pairing_codes" ADD CONSTRAINT "pairing_codes_device_code_unique" UNIQUE("device_code");--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id");