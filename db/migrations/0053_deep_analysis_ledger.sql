CREATE TABLE "grant_deep_analysis_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_sha256" text NOT NULL,
	"verdict" text NOT NULL,
	"item_results" jsonb NOT NULL,
	"artifact_key" text NOT NULL,
	"artifact_sha256" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "grant_deep_analysis_audits_verdict_check" CHECK (
    "grant_deep_analysis_audits"."verdict" IN ('concur', 'disagree', 'unsure', 'failed')
  ),
	CONSTRAINT "grant_deep_analysis_audits_attempt_check" CHECK (
    "grant_deep_analysis_audits"."attempt" > 0
  ),
	CONSTRAINT "grant_deep_analysis_audits_hash_check" CHECK (
    "grant_deep_analysis_audits"."input_sha256" ~ '^[0-9a-f]{64}$'
    AND "grant_deep_analysis_audits"."artifact_sha256" ~ '^[0-9a-f]{64}$'
  ),
	CONSTRAINT "grant_deep_analysis_audits_timing_check" CHECK (
    "grant_deep_analysis_audits"."completed_at" >= "grant_deep_analysis_audits"."started_at"
  )
);
--> statement-breakpoint
CREATE TABLE "grant_deep_analysis_axis_results" (
	"run_id" uuid NOT NULL,
	"dimension" "criterion_dimension" NOT NULL,
	"status" text NOT NULL,
	"confidence" real NOT NULL,
	"comment" text,
	"evidence_refs" jsonb NOT NULL,
	"criterion_semantic_hashes" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_deep_analysis_axis_results_run_id_dimension_pk" PRIMARY KEY("run_id","dimension"),
	CONSTRAINT "grant_deep_analysis_axis_results_status_check" CHECK (
    "grant_deep_analysis_axis_results"."status" IN (
      'condition_found', 'inspected_no_condition', 'ambiguous', 'input_missing', 'unassessed'
    )
  ),
	CONSTRAINT "grant_deep_analysis_axis_results_confidence_check" CHECK (
    "grant_deep_analysis_axis_results"."confidence" >= 0 AND "grant_deep_analysis_axis_results"."confidence" <= 1
  )
);
--> statement-breakpoint
CREATE TABLE "grant_deep_analysis_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"source_revision_sha256" text NOT NULL,
	"model_policy_version" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"worker_id" text,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_deep_analysis_jobs_status_check" CHECK (
    "grant_deep_analysis_jobs"."status" IN (
      'pending', 'leased', 'retry_wait', 'succeeded', 'blocked', 'dead_letter', 'canceled'
    )
  ),
	CONSTRAINT "grant_deep_analysis_jobs_source_hash_check" CHECK (
    "grant_deep_analysis_jobs"."source_revision_sha256" ~ '^[0-9a-f]{64}$'
  ),
	CONSTRAINT "grant_deep_analysis_jobs_attempts_check" CHECK (
    "grant_deep_analysis_jobs"."attempt_count" >= 0
    AND "grant_deep_analysis_jobs"."max_attempts" > 0
    AND "grant_deep_analysis_jobs"."attempt_count" <= "grant_deep_analysis_jobs"."max_attempts"
  ),
	CONSTRAINT "grant_deep_analysis_jobs_lease_check" CHECK (
    ("grant_deep_analysis_jobs"."status" = 'leased'
      AND "grant_deep_analysis_jobs"."leased_at" IS NOT NULL
      AND "grant_deep_analysis_jobs"."lease_expires_at" IS NOT NULL
      AND "grant_deep_analysis_jobs"."worker_id" IS NOT NULL)
    OR ("grant_deep_analysis_jobs"."status" <> 'leased')
  )
);
--> statement-breakpoint
CREATE TABLE "grant_deep_analysis_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" text NOT NULL,
	"job_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"source_revision_sha256" text NOT NULL,
	"attachment_manifest_sha256" text NOT NULL,
	"input_sha256" text NOT NULL,
	"input_artifact_key" text NOT NULL,
	"output_artifact_key" text,
	"raw_response_artifact_key" text,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model_policy_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"input_chars" integer NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"supersedes_run_id" uuid,
	"error_code" text,
	"error_message" text,
	CONSTRAINT "grant_deep_analysis_runs_status_check" CHECK (
    "grant_deep_analysis_runs"."status" IN ('running', 'passed', 'failed', 'blocked', 'stale', 'legacy_imported')
  ),
	CONSTRAINT "grant_deep_analysis_runs_hash_check" CHECK (
    "grant_deep_analysis_runs"."source_revision_sha256" ~ '^[0-9a-f]{64}$'
    AND "grant_deep_analysis_runs"."attachment_manifest_sha256" ~ '^[0-9a-f]{64}$'
    AND "grant_deep_analysis_runs"."input_sha256" ~ '^[0-9a-f]{64}$'
  ),
	CONSTRAINT "grant_deep_analysis_runs_nonnegative_usage" CHECK (
    "grant_deep_analysis_runs"."input_chars" >= 0
    AND ("grant_deep_analysis_runs"."input_tokens" IS NULL OR "grant_deep_analysis_runs"."input_tokens" >= 0)
    AND ("grant_deep_analysis_runs"."output_tokens" IS NULL OR "grant_deep_analysis_runs"."output_tokens" >= 0)
    AND ("grant_deep_analysis_runs"."cost_usd" IS NULL OR "grant_deep_analysis_runs"."cost_usd" >= 0)
  ),
	CONSTRAINT "grant_deep_analysis_runs_completion_check" CHECK (
    ("grant_deep_analysis_runs"."status" = 'running' AND "grant_deep_analysis_runs"."completed_at" IS NULL)
    OR ("grant_deep_analysis_runs"."status" <> 'running' AND "grant_deep_analysis_runs"."completed_at" IS NOT NULL)
  )
);
--> statement-breakpoint
CREATE TABLE "grant_deep_analysis_stage_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"stage" text NOT NULL,
	"status" text NOT NULL,
	"verifier_version" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_sha256" text NOT NULL,
	"artifact_key" text,
	"attempt" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_deep_analysis_stage_receipts_stage_check" CHECK (
    "grant_deep_analysis_stage_receipts"."stage" IN (
      'source_fresh', 'attachment_inventory_complete', 'attachment_archive_complete',
      'attachment_text_complete', 'input_coverage_verified', 'input_sealed',
      'model_call_passed', 'response_contract_valid', 'axis_coverage_complete',
      'evidence_grounded', 'independent_audit_passed', 'analysis_complete',
      'publication_complete', 'serving_complete', 'analysis_fresh'
    )
  ),
	CONSTRAINT "grant_deep_analysis_stage_receipts_status_check" CHECK (
    "grant_deep_analysis_stage_receipts"."status" IN (
      'pending', 'running', 'passed', 'failed', 'blocked', 'stale', 'not_applicable'
    )
  ),
	CONSTRAINT "grant_deep_analysis_stage_receipts_attempt_check" CHECK (
    "grant_deep_analysis_stage_receipts"."attempt" > 0
  ),
	CONSTRAINT "grant_deep_analysis_stage_receipts_evidence_hash_check" CHECK (
    "grant_deep_analysis_stage_receipts"."evidence_sha256" ~ '^[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
ALTER TABLE "analysis_lab_promotion_items" ADD COLUMN "deep_analysis_run_id" uuid;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_audits" ADD CONSTRAINT "grant_deep_analysis_audits_run_id_grant_deep_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grant_deep_analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_axis_results" ADD CONSTRAINT "grant_deep_analysis_axis_results_run_id_grant_deep_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grant_deep_analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_jobs" ADD CONSTRAINT "grant_deep_analysis_jobs_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_runs" ADD CONSTRAINT "grant_deep_analysis_runs_job_id_grant_deep_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."grant_deep_analysis_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_runs" ADD CONSTRAINT "grant_deep_analysis_runs_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_runs" ADD CONSTRAINT "grant_deep_analysis_runs_supersedes_run_id_grant_deep_analysis_runs_id_fk" FOREIGN KEY ("supersedes_run_id") REFERENCES "public"."grant_deep_analysis_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_stage_receipts" ADD CONSTRAINT "grant_deep_analysis_stage_receipts_run_id_grant_deep_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grant_deep_analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_deep_analysis_audits_run_attempt_idx" ON "grant_deep_analysis_audits" USING btree ("run_id","attempt");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_audits_verdict_completed_idx" ON "grant_deep_analysis_audits" USING btree ("verdict","completed_at");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_axis_results_status_idx" ON "grant_deep_analysis_axis_results" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_deep_analysis_jobs_identity_idx" ON "grant_deep_analysis_jobs" USING btree ("grant_id","source_revision_sha256","model_policy_version");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_jobs_grant_created_idx" ON "grant_deep_analysis_jobs" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_jobs_claimable_idx" ON "grant_deep_analysis_jobs" USING btree ("status","available_at","priority") WHERE "grant_deep_analysis_jobs"."status" IN ('pending', 'retry_wait');--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_jobs_lease_expiry_idx" ON "grant_deep_analysis_jobs" USING btree ("lease_expires_at") WHERE "grant_deep_analysis_jobs"."status" = 'leased';--> statement-breakpoint
CREATE UNIQUE INDEX "grant_deep_analysis_runs_run_id_idx" ON "grant_deep_analysis_runs" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_runs_job_started_idx" ON "grant_deep_analysis_runs" USING btree ("job_id","started_at");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_runs_grant_started_idx" ON "grant_deep_analysis_runs" USING btree ("grant_id","started_at");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_runs_status_idx" ON "grant_deep_analysis_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_runs_supersedes_idx" ON "grant_deep_analysis_runs" USING btree ("supersedes_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_deep_analysis_stage_receipts_run_stage_attempt_idx" ON "grant_deep_analysis_stage_receipts" USING btree ("run_id","stage","attempt");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_stage_receipts_run_stage_created_idx" ON "grant_deep_analysis_stage_receipts" USING btree ("run_id","stage","created_at");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_stage_receipts_stage_status_created_idx" ON "grant_deep_analysis_stage_receipts" USING btree ("stage","status","created_at");--> statement-breakpoint
ALTER TABLE "analysis_lab_promotion_items" ADD CONSTRAINT "analysis_lab_promotion_items_deep_analysis_run_id_grant_deep_analysis_runs_id_fk" FOREIGN KEY ("deep_analysis_run_id") REFERENCES "public"."grant_deep_analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "analysis_lab_promotion_items_deep_analysis_run_idx" ON "analysis_lab_promotion_items" USING btree ("deep_analysis_run_id");--> statement-breakpoint
CREATE FUNCTION "cunote_prevent_deep_analysis_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; insert a new attempt/run instead', TG_TABLE_NAME
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "grant_deep_analysis_stage_receipts_append_only"
BEFORE UPDATE OR DELETE ON "grant_deep_analysis_stage_receipts"
FOR EACH ROW EXECUTE FUNCTION "cunote_prevent_deep_analysis_mutation"();--> statement-breakpoint
CREATE TRIGGER "grant_deep_analysis_axis_results_append_only"
BEFORE UPDATE OR DELETE ON "grant_deep_analysis_axis_results"
FOR EACH ROW EXECUTE FUNCTION "cunote_prevent_deep_analysis_mutation"();--> statement-breakpoint
CREATE TRIGGER "grant_deep_analysis_audits_append_only"
BEFORE UPDATE OR DELETE ON "grant_deep_analysis_audits"
FOR EACH ROW EXECUTE FUNCTION "cunote_prevent_deep_analysis_mutation"();--> statement-breakpoint
CREATE FUNCTION "cunote_validate_deep_analysis_run_identity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "grant_deep_analysis_jobs" job
    WHERE job."id" = NEW."job_id"
      AND job."grant_id" = NEW."grant_id"
      AND job."source_revision_sha256" = NEW."source_revision_sha256"
      AND job."model_policy_version" = NEW."model_policy_version"
  ) THEN
    RAISE EXCEPTION 'deep analysis run identity does not match its job'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "grant_deep_analysis_runs_identity_guard"
BEFORE INSERT OR UPDATE OF
  "job_id", "grant_id", "source_revision_sha256", "model_policy_version"
ON "grant_deep_analysis_runs"
FOR EACH ROW EXECUTE FUNCTION "cunote_validate_deep_analysis_run_identity"();--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_stage_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_axis_results" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_audits" ENABLE ROW LEVEL SECURITY;
