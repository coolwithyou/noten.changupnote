ALTER TABLE "grant_aggregate_split_cases" DROP CONSTRAINT "grant_aggregate_split_cases_counts_check";--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "cost_cap_usd" numeric(12, 6) DEFAULT '12.000000' NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "max_attempts" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "available_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "leased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "worker_id" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "model" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "input_artifact_key" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "input_sha256" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "manifest_artifact_key" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "manifest_sha256" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "raw_response_artifact_key" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "raw_response_sha256" text;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "segment_count" integer;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "program_count" integer;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "external_calls_made" integer;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "input_tokens" integer;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "output_tokens" integer;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD COLUMN "cost_usd" numeric(12, 6);--> statement-breakpoint
CREATE INDEX "grant_aggregate_split_cases_claimable_idx" ON "grant_aggregate_split_cases" USING btree ("available_at","created_at") WHERE "grant_aggregate_split_cases"."status" = 'approved';--> statement-breakpoint
CREATE INDEX "grant_aggregate_split_cases_lease_expiry_idx" ON "grant_aggregate_split_cases" USING btree ("lease_expires_at") WHERE "grant_aggregate_split_cases"."status" = 'processing';--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_attempts_check" CHECK (
    "grant_aggregate_split_cases"."attempt_count" >= 0
    AND "grant_aggregate_split_cases"."max_attempts" > 0
    AND "grant_aggregate_split_cases"."attempt_count" <= "grant_aggregate_split_cases"."max_attempts"
  );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_lease_check" CHECK (
    (
      "grant_aggregate_split_cases"."status" = 'processing'
      AND "grant_aggregate_split_cases"."leased_at" IS NOT NULL
      AND "grant_aggregate_split_cases"."lease_expires_at" IS NOT NULL
      AND "grant_aggregate_split_cases"."worker_id" IS NOT NULL
    )
    OR (
      "grant_aggregate_split_cases"."status" <> 'processing'
      AND "grant_aggregate_split_cases"."leased_at" IS NULL
      AND "grant_aggregate_split_cases"."lease_expires_at" IS NULL
      AND "grant_aggregate_split_cases"."worker_id" IS NULL
    )
  );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_completion_check" CHECK (
    (
      "grant_aggregate_split_cases"."status" = 'completed'
      AND "grant_aggregate_split_cases"."completed_at" IS NOT NULL
      AND "grant_aggregate_split_cases"."model" IS NOT NULL
      AND "grant_aggregate_split_cases"."prompt_version" IS NOT NULL
      AND "grant_aggregate_split_cases"."input_artifact_key" IS NOT NULL
      AND "grant_aggregate_split_cases"."input_sha256" ~ '^[0-9a-f]{64}$'
      AND "grant_aggregate_split_cases"."manifest_artifact_key" IS NOT NULL
      AND "grant_aggregate_split_cases"."manifest_sha256" ~ '^[0-9a-f]{64}$'
      AND "grant_aggregate_split_cases"."raw_response_artifact_key" IS NOT NULL
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
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_usage_check" CHECK (
    ("grant_aggregate_split_cases"."segment_count" IS NULL OR "grant_aggregate_split_cases"."segment_count" > 0)
    AND ("grant_aggregate_split_cases"."program_count" IS NULL OR "grant_aggregate_split_cases"."program_count" > 1)
    AND ("grant_aggregate_split_cases"."external_calls_made" IS NULL OR "grant_aggregate_split_cases"."external_calls_made" > 0)
    AND ("grant_aggregate_split_cases"."input_tokens" IS NULL OR "grant_aggregate_split_cases"."input_tokens" >= 0)
    AND ("grant_aggregate_split_cases"."output_tokens" IS NULL OR "grant_aggregate_split_cases"."output_tokens" >= 0)
    AND ("grant_aggregate_split_cases"."cost_usd" IS NULL OR "grant_aggregate_split_cases"."cost_usd" >= 0)
  );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_counts_check" CHECK (
    "grant_aggregate_split_cases"."input_chars" > "grant_aggregate_split_cases"."input_cap_chars"
    AND "grant_aggregate_split_cases"."input_cap_chars" > 0
    AND "grant_aggregate_split_cases"."cost_cap_usd" > 0
    AND "grant_aggregate_split_cases"."chunk_count" > 0
    AND "grant_aggregate_split_cases"."attachment_count" >= 0
  );