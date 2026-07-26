CREATE TABLE "grant_aggregate_split_children" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"split_case_id" uuid NOT NULL,
	"parent_grant_id" uuid NOT NULL,
	"stable_key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"source" "grant_source" NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"agency_primary" text,
	"grant_projection" jsonb NOT NULL,
	"grant_projection_sha256" text NOT NULL,
	"manifest_sha256" text NOT NULL,
	"source_revision_sha256" text NOT NULL,
	"raw_payload_sha256" text NOT NULL,
	"attachment_manifest_sha256" text,
	"input_artifact_key" text,
	"input_sha256" text,
	"input_chars" integer,
	"prepared_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_aggregate_split_children_status_check" CHECK (
    "grant_aggregate_split_children"."status" IN ('pending', 'prepared', 'failed')
  ),
	CONSTRAINT "grant_aggregate_split_children_ordinal_check" CHECK (
    "grant_aggregate_split_children"."ordinal" >= 0
  ),
	CONSTRAINT "grant_aggregate_split_children_identity_hash_check" CHECK (
    "grant_aggregate_split_children"."grant_projection_sha256" ~ '^[0-9a-f]{64}$'
    AND "grant_aggregate_split_children"."manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "grant_aggregate_split_children"."source_revision_sha256" ~ '^[0-9a-f]{64}$'
    AND "grant_aggregate_split_children"."raw_payload_sha256" ~ '^[0-9a-f]{64}$'
  ),
	CONSTRAINT "grant_aggregate_split_children_prepared_check" CHECK (
    (
      "grant_aggregate_split_children"."status" = 'prepared'
      AND "grant_aggregate_split_children"."prepared_at" IS NOT NULL
      AND "grant_aggregate_split_children"."attachment_manifest_sha256" IS NOT NULL
      AND "grant_aggregate_split_children"."attachment_manifest_sha256" ~ '^[0-9a-f]{64}$'
      AND "grant_aggregate_split_children"."input_artifact_key" IS NOT NULL
      AND "grant_aggregate_split_children"."input_sha256" IS NOT NULL
      AND "grant_aggregate_split_children"."input_sha256" ~ '^[0-9a-f]{64}$'
      AND "grant_aggregate_split_children"."input_chars" IS NOT NULL
      AND "grant_aggregate_split_children"."input_chars" > 0
    )
    OR (
      "grant_aggregate_split_children"."status" <> 'prepared'
      AND "grant_aggregate_split_children"."prepared_at" IS NULL
    )
  )
);
--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" DROP CONSTRAINT "grant_aggregate_split_cases_completion_check";--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "materialization_status" text DEFAULT 'not_ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "materialization_attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "materialization_max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "materialization_available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "materialization_leased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "materialization_lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "materialization_worker_id" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "prepared_child_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "children_prepared_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "materialization_last_error_code" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "materialization_last_error_message" text;--> statement-breakpoint
UPDATE "grant_aggregate_split_cases"
SET
  "materialization_status" = 'pending',
  "materialization_available_at" = COALESCE("completed_at", "updated_at", now())
WHERE "status" = 'completed';--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD CONSTRAINT "grant_aggregate_split_children_split_case_id_grant_aggregate_split_cases_id_fk" FOREIGN KEY ("split_case_id") REFERENCES "public"."grant_aggregate_split_cases"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ADD CONSTRAINT "grant_aggregate_split_children_parent_grant_id_grants_id_fk" FOREIGN KEY ("parent_grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_aggregate_split_children_identity_idx" ON "grant_aggregate_split_children" USING btree ("split_case_id","stable_key");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_aggregate_split_children_ordinal_idx" ON "grant_aggregate_split_children" USING btree ("split_case_id","ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_aggregate_split_children_source_id_idx" ON "grant_aggregate_split_children" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "grant_aggregate_split_children_parent_idx" ON "grant_aggregate_split_children" USING btree ("parent_grant_id");--> statement-breakpoint
CREATE INDEX "grant_aggregate_split_children_case_status_idx" ON "grant_aggregate_split_children" USING btree ("split_case_id","status","ordinal");--> statement-breakpoint
CREATE INDEX "grant_aggregate_split_cases_materialization_claimable_idx" ON "grant_aggregate_split_cases" USING btree ("materialization_available_at","created_at") WHERE
      "grant_aggregate_split_cases"."status" = 'completed'
      AND "grant_aggregate_split_cases"."materialization_status" = 'pending'
    ;--> statement-breakpoint
CREATE INDEX "grant_aggregate_split_cases_materialization_lease_expiry_idx" ON "grant_aggregate_split_cases" USING btree ("materialization_lease_expires_at") WHERE "grant_aggregate_split_cases"."materialization_status" = 'processing';--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_materialization_status_check" CHECK (
      "grant_aggregate_split_cases"."materialization_status" IN (
        'not_ready', 'pending', 'processing', 'prepared', 'failed'
      )
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_materialization_attempts_check" CHECK (
      "grant_aggregate_split_cases"."materialization_attempt_count" >= 0
      AND "grant_aggregate_split_cases"."materialization_max_attempts" > 0
      AND "grant_aggregate_split_cases"."materialization_attempt_count" <= "grant_aggregate_split_cases"."materialization_max_attempts"
      AND "grant_aggregate_split_cases"."prepared_child_count" >= 0
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_materialization_readiness_check" CHECK (
      (
        "grant_aggregate_split_cases"."status" = 'completed'
        AND "grant_aggregate_split_cases"."materialization_status" <> 'not_ready'
      )
      OR (
        "grant_aggregate_split_cases"."status" <> 'completed'
        AND "grant_aggregate_split_cases"."materialization_status" = 'not_ready'
      )
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_materialization_lease_check" CHECK (
      (
        "grant_aggregate_split_cases"."materialization_status" = 'processing'
        AND "grant_aggregate_split_cases"."materialization_leased_at" IS NOT NULL
        AND "grant_aggregate_split_cases"."materialization_lease_expires_at" IS NOT NULL
        AND "grant_aggregate_split_cases"."materialization_worker_id" IS NOT NULL
      )
      OR (
        "grant_aggregate_split_cases"."materialization_status" <> 'processing'
        AND "grant_aggregate_split_cases"."materialization_leased_at" IS NULL
        AND "grant_aggregate_split_cases"."materialization_lease_expires_at" IS NULL
        AND "grant_aggregate_split_cases"."materialization_worker_id" IS NULL
      )
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_materialization_prepared_check" CHECK (
      (
        "grant_aggregate_split_cases"."materialization_status" = 'prepared'
        AND "grant_aggregate_split_cases"."children_prepared_at" IS NOT NULL
        AND "grant_aggregate_split_cases"."program_count" IS NOT NULL
        AND "grant_aggregate_split_cases"."prepared_child_count" = "grant_aggregate_split_cases"."program_count"
        AND "grant_aggregate_split_cases"."prepared_child_count" > 1
      )
      OR (
        "grant_aggregate_split_cases"."materialization_status" <> 'prepared'
        AND "grant_aggregate_split_cases"."children_prepared_at" IS NULL
      )
    );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_completion_check" CHECK (
    (
      "grant_aggregate_split_cases"."status" = 'completed'
      AND "grant_aggregate_split_cases"."completed_at" IS NOT NULL
      AND "grant_aggregate_split_cases"."model" IS NOT NULL
      AND "grant_aggregate_split_cases"."prompt_version" IS NOT NULL
      AND "grant_aggregate_split_cases"."input_artifact_key" IS NOT NULL
      AND "grant_aggregate_split_cases"."input_sha256" IS NOT NULL
      AND "grant_aggregate_split_cases"."input_sha256" ~ '^[0-9a-f]{64}$'
      AND "grant_aggregate_split_cases"."manifest_artifact_key" IS NOT NULL
      AND "grant_aggregate_split_cases"."manifest_sha256" IS NOT NULL
      AND "grant_aggregate_split_cases"."manifest_sha256" ~ '^[0-9a-f]{64}$'
      AND "grant_aggregate_split_cases"."raw_response_artifact_key" IS NOT NULL
      AND "grant_aggregate_split_cases"."raw_response_sha256" IS NOT NULL
      AND "grant_aggregate_split_cases"."raw_response_sha256" ~ '^[0-9a-f]{64}$'
      AND "grant_aggregate_split_cases"."segment_count" > 0
      AND "grant_aggregate_split_cases"."program_count" > 1
      AND "grant_aggregate_split_cases"."external_calls_made" > 0
    )
    OR (
      "grant_aggregate_split_cases"."status" <> 'completed'
      AND "grant_aggregate_split_cases"."completed_at" IS NULL
    )
  );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_children" ENABLE ROW LEVEL SECURITY;
