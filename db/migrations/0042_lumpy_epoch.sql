CREATE TYPE "public"."codef_two_way_state" AS ENUM('pending_approval', 'completing', 'done', 'failed', 'expired');--> statement-breakpoint
CREATE TABLE "codef_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"access_token" text NOT NULL,
	"token_type" text DEFAULT 'bearer' NOT NULL,
	"obtained_at_ms" bigint NOT NULL,
	"expires_in_sec" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "codef_two_way_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"biz_no" text NOT NULL,
	"user_id" uuid,
	"product_scope" text DEFAULT 'l1_bundle' NOT NULL,
	"state" "codef_two_way_state" NOT NULL,
	"request_snapshot" jsonb,
	"two_way_info" jsonb,
	"error_code" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "codef_two_way_sessions" ADD CONSTRAINT "codef_two_way_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "codef_two_way_sessions_biz_no_idx" ON "codef_two_way_sessions" USING btree ("biz_no");--> statement-breakpoint
CREATE INDEX "codef_two_way_sessions_expires_at_idx" ON "codef_two_way_sessions" USING btree ("expires_at");