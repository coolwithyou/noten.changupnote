CREATE TABLE "analysis_lab_promotion_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_db_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"plan_sha256" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"before_sha256" text NOT NULL,
	"after_snapshot" jsonb,
	"after_sha256" text,
	"status" text DEFAULT 'prepared' NOT NULL,
	"error" text,
	"applied_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_lab_promotion_items_status_check" CHECK (
    "analysis_lab_promotion_items"."status" IN ('prepared', 'applying', 'applied', 'failed', 'rolling_back', 'rolled_back')
  )
);
--> statement-breakpoint
CREATE TABLE "analysis_lab_promotion_releases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_id" text NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"manifest_sha256" text NOT NULL,
	"release_plan_sha256" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"git_commit" text NOT NULL,
	"build_digest" text NOT NULL,
	"status" text DEFAULT 'prepared' NOT NULL,
	"gate_summary" jsonb,
	"created_by" text NOT NULL,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"approval_artifact_sha256" text,
	"executed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	CONSTRAINT "analysis_lab_promotion_releases_positive_revision" CHECK ("analysis_lab_promotion_releases"."revision" > 0),
	CONSTRAINT "analysis_lab_promotion_releases_status_check" CHECK (
    "analysis_lab_promotion_releases"."status" IN (
      'prepared', 'approved', 'canary_running', 'canary_passed', 'applying', 'active',
      'partial_failed', 'rolling_back', 'rolled_back'
    )
  )
);
--> statement-breakpoint
DROP INDEX "grant_confirmation_questions_grant_stable_key_idx";--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD COLUMN "definition_sha256" text DEFAULT 'legacy-v0' NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD COLUMN "supersedes_question_id" uuid;--> statement-breakpoint
ALTER TABLE "analysis_lab_promotion_items" ADD CONSTRAINT "analysis_lab_promotion_items_release_db_id_analysis_lab_promotion_releases_id_fk" FOREIGN KEY ("release_db_id") REFERENCES "public"."analysis_lab_promotion_releases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analysis_lab_promotion_items" ADD CONSTRAINT "analysis_lab_promotion_items_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_lab_promotion_items_release_grant_idx" ON "analysis_lab_promotion_items" USING btree ("release_db_id","grant_id");--> statement-breakpoint
CREATE INDEX "analysis_lab_promotion_items_release_status_idx" ON "analysis_lab_promotion_items" USING btree ("release_db_id","status");--> statement-breakpoint
CREATE INDEX "analysis_lab_promotion_items_grant_idx" ON "analysis_lab_promotion_items" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_lab_promotion_releases_release_id_idx" ON "analysis_lab_promotion_releases" USING btree ("release_id");--> statement-breakpoint
CREATE INDEX "analysis_lab_promotion_releases_status_idx" ON "analysis_lab_promotion_releases" USING btree ("status");--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD CONSTRAINT "grant_confirmation_questions_supersedes_question_id_grant_confirmation_questions_id_fk" FOREIGN KEY ("supersedes_question_id") REFERENCES "public"."grant_confirmation_questions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_confirmation_questions_grant_definition_idx" ON "grant_confirmation_questions" USING btree ("grant_id","criterion_stable_key","definition_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_confirmation_questions_active_stable_key_idx" ON "grant_confirmation_questions" USING btree ("grant_id","criterion_stable_key") WHERE "grant_confirmation_questions"."invalidated_at" IS NULL;--> statement-breakpoint
CREATE INDEX "grant_confirmation_questions_supersedes_idx" ON "grant_confirmation_questions" USING btree ("supersedes_question_id");--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD CONSTRAINT "grant_confirmation_questions_positive_version" CHECK ("grant_confirmation_questions"."version" > 0);