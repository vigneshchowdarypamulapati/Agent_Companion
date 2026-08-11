CREATE TABLE "devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" bigint NOT NULL,
	"push_subscription" jsonb,
	CONSTRAINT "devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "pairing_codes" (
	"code" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" bigint NOT NULL,
	"consumed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "session_events" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"event" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"daemon_device_id" uuid NOT NULL,
	"project_path" text NOT NULL,
	"status" text NOT NULL,
	"started_at" bigint NOT NULL,
	"last_event_at" bigint NOT NULL,
	"dismissed" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE INDEX "devices_user_id_idx" ON "devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_events_session_id_idx" ON "session_events" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");