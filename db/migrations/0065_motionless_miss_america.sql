CREATE TABLE IF NOT EXISTS "admin_pipeline_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"grant_id" uuid,
	"source" "grant_source" NOT NULL,
	"source_id" text NOT NULL,
	"grant_title" text NOT NULL,
	"action" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'admin_pipeline_actions_admin_user_id_admin_users_id_fk'
			AND conrelid = 'public.admin_pipeline_actions'::regclass
	) THEN
		ALTER TABLE "admin_pipeline_actions"
			ADD CONSTRAINT "admin_pipeline_actions_admin_user_id_admin_users_id_fk"
			FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id")
			ON DELETE restrict ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'admin_pipeline_actions_grant_id_grants_id_fk'
			AND conrelid = 'public.admin_pipeline_actions'::regclass
	) THEN
		ALTER TABLE "admin_pipeline_actions"
			ADD CONSTRAINT "admin_pipeline_actions_grant_id_grants_id_fk"
			FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id")
			ON DELETE set null ON UPDATE no action;
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'admin_pipeline_actions_action_check'
			AND conrelid = 'public.admin_pipeline_actions'::regclass
	) THEN
		ALTER TABLE "admin_pipeline_actions"
			ADD CONSTRAINT "admin_pipeline_actions_action_check"
			CHECK ("action" in ('mark_reviewed', 'reconvert'));
	END IF;
END $$;--> statement-breakpoint
DO $$ BEGIN
	IF NOT EXISTS (
		SELECT 1 FROM pg_constraint
		WHERE conname = 'admin_pipeline_actions_status_check'
			AND conrelid = 'public.admin_pipeline_actions'::regclass
	) THEN
		ALTER TABLE "admin_pipeline_actions"
			ADD CONSTRAINT "admin_pipeline_actions_status_check"
			CHECK ("status" in ('queued', 'succeeded', 'partial', 'failed'));
	END IF;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "admin_pipeline_actions_request_target_idx" ON "admin_pipeline_actions" USING btree ("request_id","grant_id","action");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_pipeline_actions_grant_created_idx" ON "admin_pipeline_actions" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_pipeline_actions_admin_created_idx" ON "admin_pipeline_actions" USING btree ("admin_user_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_pipeline_actions_status_created_idx" ON "admin_pipeline_actions" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "extraction_log_grant_ts_idx" ON "extraction_log" USING btree ("grant_id","ts");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "grant_criteria_needs_review_grant_idx" ON "grant_criteria" USING btree ("grant_id") WHERE "grant_criteria"."needs_review" = true;
