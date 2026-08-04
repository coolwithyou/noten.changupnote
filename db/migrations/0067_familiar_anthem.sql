CREATE TABLE "grant_application_precompute_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"surface_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"deep_analysis_run_id" uuid,
	"source_sha256" text NOT NULL,
	"analysis_version" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"result_status" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"leased_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	"worker_id" text,
	"last_error_code" text,
	"last_error_message" text,
	"result_artifact_id" uuid,
	"result_summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_count" integer,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_usd" numeric(12, 6),
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_application_precompute_jobs_status_check" CHECK (
    "grant_application_precompute_jobs"."status" IN (
      'pending', 'leased', 'retry_wait', 'succeeded', 'blocked', 'dead_letter', 'canceled'
    )
  ),
	CONSTRAINT "grant_application_precompute_jobs_result_status_check" CHECK (
    "grant_application_precompute_jobs"."result_status" IS NULL OR "grant_application_precompute_jobs"."result_status" IN (
      'complete', 'partial', 'review_required', 'not_applicable', 'failed'
    )
  ),
	CONSTRAINT "grant_application_precompute_jobs_source_hash_check" CHECK (
    "grant_application_precompute_jobs"."source_sha256" ~ '^[0-9a-f]{64}$'
  ),
	CONSTRAINT "grant_application_precompute_jobs_attempts_check" CHECK (
    "grant_application_precompute_jobs"."attempt_count" >= 0
    AND "grant_application_precompute_jobs"."max_attempts" > 0
    AND "grant_application_precompute_jobs"."attempt_count" <= "grant_application_precompute_jobs"."max_attempts"
  ),
	CONSTRAINT "grant_application_precompute_jobs_lease_check" CHECK (
    ("grant_application_precompute_jobs"."status" = 'leased'
      AND "grant_application_precompute_jobs"."leased_at" IS NOT NULL
      AND "grant_application_precompute_jobs"."lease_expires_at" IS NOT NULL
      AND "grant_application_precompute_jobs"."worker_id" IS NOT NULL)
    OR ("grant_application_precompute_jobs"."status" <> 'leased')
  ),
	CONSTRAINT "grant_application_precompute_jobs_terminal_check" CHECK (
    ("grant_application_precompute_jobs"."status" = 'succeeded'
      AND "grant_application_precompute_jobs"."result_status" IS NOT NULL
      AND "grant_application_precompute_jobs"."completed_at" IS NOT NULL)
    OR ("grant_application_precompute_jobs"."status" <> 'succeeded')
  )
);
--> statement-breakpoint
CREATE TABLE "grant_application_precompute_worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"service_revision" text NOT NULL,
	"analysis_version" text NOT NULL,
	"status" text NOT NULL,
	"current_job_id" uuid,
	"last_error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_application_precompute_worker_heartbeats_status_check" CHECK (
      "grant_application_precompute_worker_heartbeats"."status" IN ('idle', 'running', 'degraded', 'stopped')
    )
);
--> statement-breakpoint
ALTER TABLE "grant_application_precompute_jobs" ADD CONSTRAINT "grant_application_precompute_jobs_surface_id_grant_application_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."grant_application_surfaces"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_application_precompute_jobs" ADD CONSTRAINT "grant_application_precompute_jobs_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_application_precompute_jobs" ADD CONSTRAINT "grant_application_precompute_jobs_deep_analysis_run_id_grant_deep_analysis_runs_id_fk" FOREIGN KEY ("deep_analysis_run_id") REFERENCES "public"."grant_deep_analysis_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_application_precompute_jobs" ADD CONSTRAINT "grant_application_precompute_jobs_result_artifact_id_document_artifacts_id_fk" FOREIGN KEY ("result_artifact_id") REFERENCES "public"."document_artifacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_application_precompute_worker_heartbeats" ADD CONSTRAINT "grant_application_precompute_worker_heartbeats_current_job_id_grant_application_precompute_jobs_id_fk" FOREIGN KEY ("current_job_id") REFERENCES "public"."grant_application_precompute_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_application_precompute_jobs_identity_idx" ON "grant_application_precompute_jobs" USING btree ("surface_id","source_sha256","analysis_version");--> statement-breakpoint
CREATE INDEX "grant_application_precompute_jobs_grant_created_idx" ON "grant_application_precompute_jobs" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "grant_application_precompute_jobs_claimable_idx" ON "grant_application_precompute_jobs" USING btree ("status","available_at","priority") WHERE "grant_application_precompute_jobs"."status" IN ('pending', 'retry_wait');--> statement-breakpoint
CREATE INDEX "grant_application_precompute_jobs_lease_expiry_idx" ON "grant_application_precompute_jobs" USING btree ("lease_expires_at") WHERE "grant_application_precompute_jobs"."status" = 'leased';--> statement-breakpoint
CREATE INDEX "grant_application_precompute_worker_heartbeats_heartbeat_idx" ON "grant_application_precompute_worker_heartbeats" USING btree ("heartbeat_at");--> statement-breakpoint
CREATE INDEX "grant_application_precompute_worker_heartbeats_status_heartbeat_idx" ON "grant_application_precompute_worker_heartbeats" USING btree ("status","heartbeat_at");