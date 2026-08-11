ALTER TABLE "devices" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "devices" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "pairing_codes" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "daemon_device_id" SET DATA TYPE text;