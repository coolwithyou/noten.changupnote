ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "promotion_status" text DEFAULT 'not_ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "staged_child_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "enqueued_child_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "children_staged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "children_enqueued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "active_feeder_bypass_reason" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "promotion_last_error_code" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "promotion_last_error_message" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD COLUMN "staged_grant_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD COLUMN "deep_analysis_job_id" uuid;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD COLUMN "deep_analysis_enqueued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD COLUMN "active_feeder_bypass_reason" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD COLUMN "promotion_last_error_code" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD COLUMN "promotion_last_error_message" text;--> statement-breakpoint
UPDATE "grant_aggregate_split_cases"
SET "promotion_status" = 'pending'
WHERE "materialization_status" = 'prepared';--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD CONSTRAINT "grant_aggregate_split_children_deep_analysis_job_id_grant_deep_analysis_jobs_id_fk" FOREIGN KEY ("deep_analysis_job_id") REFERENCES "public"."grant_deep_analysis_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grant_aggregate_split_cases_promotion_claimable_idx" ON "grant_aggregate_split_cases" USING btree ("promotion_status","updated_at") WHERE
      "grant_aggregate_split_cases"."materialization_status" = 'prepared'
      AND "grant_aggregate_split_cases"."promotion_status" IN ('pending', 'staged')
    ;--> statement-breakpoint
CREATE INDEX "grant_aggregate_split_children_deep_analysis_job_idx" ON "grant_aggregate_split_children" USING btree ("deep_analysis_job_id");--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_promotion_status_check" CHECK (
      "grant_aggregate_split_cases"."promotion_status" IN (
        'not_ready', 'pending', 'staged', 'enqueued', 'failed'
      )
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_promotion_readiness_check" CHECK (
      (
        "grant_aggregate_split_cases"."materialization_status" = 'prepared'
        AND "grant_aggregate_split_cases"."promotion_status" <> 'not_ready'
      )
      OR (
        "grant_aggregate_split_cases"."materialization_status" <> 'prepared'
        AND "grant_aggregate_split_cases"."promotion_status" = 'not_ready'
      )
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_promotion_counts_check" CHECK (
      "grant_aggregate_split_cases"."staged_child_count" >= 0
      AND "grant_aggregate_split_cases"."enqueued_child_count" >= 0
      AND "grant_aggregate_split_cases"."enqueued_child_count" <= "grant_aggregate_split_cases"."staged_child_count"
      AND "grant_aggregate_split_cases"."staged_child_count" <= "grant_aggregate_split_cases"."prepared_child_count"
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_promotion_staged_check" CHECK (
      (
        "grant_aggregate_split_cases"."promotion_status" IN ('staged', 'enqueued')
        AND "grant_aggregate_split_cases"."program_count" IS NOT NULL
        AND "grant_aggregate_split_cases"."staged_child_count" = "grant_aggregate_split_cases"."program_count"
        AND "grant_aggregate_split_cases"."children_staged_at" IS NOT NULL
      )
      OR (
        "grant_aggregate_split_cases"."promotion_status" NOT IN ('staged', 'enqueued')
        AND "grant_aggregate_split_cases"."staged_child_count" = 0
        AND "grant_aggregate_split_cases"."enqueued_child_count" = 0
        AND "grant_aggregate_split_cases"."children_staged_at" IS NULL
        AND "grant_aggregate_split_cases"."children_enqueued_at" IS NULL
      )
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_promotion_enqueued_check" CHECK (
      (
        "grant_aggregate_split_cases"."promotion_status" = 'enqueued'
        AND "grant_aggregate_split_cases"."enqueued_child_count" = "grant_aggregate_split_cases"."staged_child_count"
        AND "grant_aggregate_split_cases"."enqueued_child_count" > 1
        AND "grant_aggregate_split_cases"."children_enqueued_at" IS NOT NULL
      )
      OR (
        "grant_aggregate_split_cases"."promotion_status" <> 'enqueued'
        AND "grant_aggregate_split_cases"."children_enqueued_at" IS NULL
      )
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_promotion_bypass_evidence_check" CHECK (
      (
        "grant_aggregate_split_cases"."enqueued_child_count" > 0
        AND "grant_aggregate_split_cases"."active_feeder_bypass_reason" =
          'aggregate_split_staged_direct_enqueue'
      )
      OR (
        "grant_aggregate_split_cases"."enqueued_child_count" = 0
        AND "grant_aggregate_split_cases"."active_feeder_bypass_reason" IS NULL
      )
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD CONSTRAINT "grant_aggregate_split_children_staged_grant_check" CHECK (
    "grant_aggregate_split_children"."staged_grant_at" IS NULL
    OR "grant_aggregate_split_children"."status" = 'prepared'
  );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD CONSTRAINT "grant_aggregate_split_children_deep_analysis_enqueue_check" CHECK (
      (
        "grant_aggregate_split_children"."deep_analysis_job_id" IS NOT NULL
        AND "grant_aggregate_split_children"."staged_grant_at" IS NOT NULL
        AND "grant_aggregate_split_children"."deep_analysis_enqueued_at" IS NOT NULL
        AND "grant_aggregate_split_children"."active_feeder_bypass_reason" =
          'aggregate_split_staged_direct_enqueue'
      )
      OR (
        "grant_aggregate_split_children"."deep_analysis_job_id" IS NULL
        AND "grant_aggregate_split_children"."deep_analysis_enqueued_at" IS NULL
        AND "grant_aggregate_split_children"."active_feeder_bypass_reason" IS NULL
      )
    );
