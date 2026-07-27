ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "exposure_status" text DEFAULT 'not_ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "exposure_release_id" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "exposed_child_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "children_visible_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "serving_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "visibility_rolled_back_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "exposure_actor" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "exposure_last_error_code" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "exposure_last_error_message" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_exposure_status_check" CHECK (
      "grant_aggregate_split_cases"."exposure_status" IN ('not_ready', 'verifying', 'visible', 'rolled_back')
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_exposure_state_check" CHECK (
      (
        "grant_aggregate_split_cases"."exposure_status" = 'not_ready'
        AND "grant_aggregate_split_cases"."exposure_release_id" IS NULL
        AND "grant_aggregate_split_cases"."exposed_child_count" = 0
        AND "grant_aggregate_split_cases"."children_visible_at" IS NULL
        AND "grant_aggregate_split_cases"."serving_verified_at" IS NULL
        AND "grant_aggregate_split_cases"."visibility_rolled_back_at" IS NULL
        AND "grant_aggregate_split_cases"."exposure_actor" IS NULL
        AND "grant_aggregate_split_cases"."exposure_last_error_code" IS NULL
        AND "grant_aggregate_split_cases"."exposure_last_error_message" IS NULL
      )
      OR (
        "grant_aggregate_split_cases"."exposure_status" = 'verifying'
        AND "grant_aggregate_split_cases"."promotion_status" = 'enqueued'
        AND "grant_aggregate_split_cases"."exposure_release_id" IS NOT NULL
        AND "grant_aggregate_split_cases"."program_count" IS NOT NULL
        AND "grant_aggregate_split_cases"."exposed_child_count" = "grant_aggregate_split_cases"."program_count"
        AND "grant_aggregate_split_cases"."children_visible_at" IS NOT NULL
        AND "grant_aggregate_split_cases"."serving_verified_at" IS NULL
        AND "grant_aggregate_split_cases"."visibility_rolled_back_at" IS NULL
        AND "grant_aggregate_split_cases"."exposure_actor" IS NOT NULL
        AND "grant_aggregate_split_cases"."exposure_last_error_code" IS NULL
        AND "grant_aggregate_split_cases"."exposure_last_error_message" IS NULL
      )
      OR (
        "grant_aggregate_split_cases"."exposure_status" = 'visible'
        AND "grant_aggregate_split_cases"."promotion_status" = 'enqueued'
        AND "grant_aggregate_split_cases"."exposure_release_id" IS NOT NULL
        AND "grant_aggregate_split_cases"."program_count" IS NOT NULL
        AND "grant_aggregate_split_cases"."exposed_child_count" = "grant_aggregate_split_cases"."program_count"
        AND "grant_aggregate_split_cases"."children_visible_at" IS NOT NULL
        AND "grant_aggregate_split_cases"."serving_verified_at" IS NOT NULL
        AND "grant_aggregate_split_cases"."visibility_rolled_back_at" IS NULL
        AND "grant_aggregate_split_cases"."exposure_actor" IS NOT NULL
        AND "grant_aggregate_split_cases"."exposure_last_error_code" IS NULL
        AND "grant_aggregate_split_cases"."exposure_last_error_message" IS NULL
      )
      OR (
        "grant_aggregate_split_cases"."exposure_status" = 'rolled_back'
        AND "grant_aggregate_split_cases"."promotion_status" = 'enqueued'
        AND "grant_aggregate_split_cases"."exposure_release_id" IS NOT NULL
        AND "grant_aggregate_split_cases"."exposed_child_count" = 0
        AND "grant_aggregate_split_cases"."children_visible_at" IS NOT NULL
        AND "grant_aggregate_split_cases"."serving_verified_at" IS NULL
        AND "grant_aggregate_split_cases"."visibility_rolled_back_at" IS NOT NULL
        AND "grant_aggregate_split_cases"."exposure_actor" IS NOT NULL
        AND "grant_aggregate_split_cases"."exposure_last_error_code" IS NOT NULL
        AND "grant_aggregate_split_cases"."exposure_last_error_message" IS NOT NULL
      )
    );