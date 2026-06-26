CREATE TYPE "public"."app_device_platform" AS ENUM('ios', 'android');--> statement-breakpoint
CREATE TABLE "app_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" text NOT NULL,
	"platform" "app_device_platform" NOT NULL,
	"push_token" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_settings" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"deadline_reminder" boolean DEFAULT true NOT NULL,
	"new_match" boolean DEFAULT true NOT NULL,
	"quiet_hours_start" text,
	"quiet_hours_end" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app_devices" ADD CONSTRAINT "app_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_settings" ADD CONSTRAINT "notification_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "app_devices_user_device_idx" ON "app_devices" USING btree ("user_id","device_id");