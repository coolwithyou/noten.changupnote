CREATE TABLE "analysis_lab_legacy_question_migration_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_db_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"criterion_id" uuid NOT NULL,
	"legacy_question_id" uuid NOT NULL,
	"migrated_question_id" uuid,
	"plan_sha256" text NOT NULL,
	"operation_sha256" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"before_sha256" text NOT NULL,
	"after_snapshot" jsonb,
	"after_sha256" text,
	"status" text DEFAULT 'prepared' NOT NULL,
	"error" text,
	"applied_at" timestamp with time zone,
	"rolled_back_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_lab_legacy_question_migration_status_check" CHECK (
		"analysis_lab_legacy_question_migration_items"."status" IN (
			'prepared', 'applying', 'applied', 'failed', 'rolling_back', 'rolled_back'
		)
	)
);
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" ADD CONSTRAINT "analysis_lab_legacy_question_migration_release_db_id_fk" FOREIGN KEY ("release_db_id") REFERENCES "public"."analysis_lab_promotion_releases"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" ADD CONSTRAINT "analysis_lab_legacy_question_migration_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" ADD CONSTRAINT "analysis_lab_legacy_question_migration_criterion_id_fk" FOREIGN KEY ("criterion_id") REFERENCES "public"."grant_criteria"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" ADD CONSTRAINT "analysis_lab_legacy_question_migration_legacy_question_id_fk" FOREIGN KEY ("legacy_question_id") REFERENCES "public"."grant_confirmation_questions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" ADD CONSTRAINT "analysis_lab_legacy_question_migration_migrated_question_id_fk" FOREIGN KEY ("migrated_question_id") REFERENCES "public"."grant_confirmation_questions"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_lab_legacy_question_migration_release_question_idx" ON "analysis_lab_legacy_question_migration_items" USING btree ("release_db_id", "legacy_question_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_lab_legacy_question_migration_active_legacy_idx" ON "analysis_lab_legacy_question_migration_items" USING btree ("legacy_question_id") WHERE "status" IN ('prepared', 'applying', 'applied', 'rolling_back');
--> statement-breakpoint
CREATE INDEX "analysis_lab_legacy_question_migration_release_status_idx" ON "analysis_lab_legacy_question_migration_items" USING btree ("release_db_id", "status");
--> statement-breakpoint
CREATE INDEX "analysis_lab_legacy_question_migration_grant_idx" ON "analysis_lab_legacy_question_migration_items" USING btree ("grant_id");
--> statement-breakpoint
CREATE INDEX "analysis_lab_legacy_question_migration_criterion_idx" ON "analysis_lab_legacy_question_migration_items" USING btree ("criterion_id");
--> statement-breakpoint
CREATE INDEX "analysis_lab_legacy_question_migration_migrated_question_idx" ON "analysis_lab_legacy_question_migration_items" USING btree ("migrated_question_id");
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" FORCE ROW LEVEL SECURITY;
