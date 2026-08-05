CREATE TABLE "grant_application_precompute_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_count" integer NOT NULL,
	"worker_id" text NOT NULL,
	"lease_token" uuid NOT NULL,
	"status" text DEFAULT 'leased' NOT NULL,
	"reserved_cost_usd" numeric(12, 6) NOT NULL,
	"actual_request_count" integer DEFAULT 0 NOT NULL,
	"actual_input_tokens" integer DEFAULT 0 NOT NULL,
	"actual_output_tokens" integer DEFAULT 0 NOT NULL,
	"actual_cost_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"charged_cost_usd" numeric(12, 6) NOT NULL,
	"usage_complete" boolean DEFAULT false NOT NULL,
	"last_error_code" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_application_precompute_attempts_status_check" CHECK (
    "grant_application_precompute_attempts"."status" IN ('leased', 'succeeded', 'failed', 'expired')
  ),
	CONSTRAINT "grant_application_precompute_attempts_counts_check" CHECK (
    "grant_application_precompute_attempts"."attempt_count" > 0
    AND "grant_application_precompute_attempts"."actual_request_count" >= 0
    AND "grant_application_precompute_attempts"."actual_input_tokens" >= 0
    AND "grant_application_precompute_attempts"."actual_output_tokens" >= 0
  ),
	CONSTRAINT "grant_application_precompute_attempts_costs_check" CHECK (
    "grant_application_precompute_attempts"."reserved_cost_usd" >= 0
    AND "grant_application_precompute_attempts"."actual_cost_usd" >= 0
    AND "grant_application_precompute_attempts"."charged_cost_usd" >= "grant_application_precompute_attempts"."actual_cost_usd"
  ),
	CONSTRAINT "grant_application_precompute_attempts_terminal_check" CHECK (
    ("grant_application_precompute_attempts"."status" = 'leased' AND "grant_application_precompute_attempts"."completed_at" IS NULL)
    OR ("grant_application_precompute_attempts"."status" <> 'leased' AND "grant_application_precompute_attempts"."completed_at" IS NOT NULL)
  )
);
--> statement-breakpoint
ALTER TABLE "grant_application_precompute_jobs" DROP CONSTRAINT "grant_application_precompute_jobs_lease_check";--> statement-breakpoint
ALTER TABLE "grant_application_precompute_jobs" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "grant_application_precompute_jobs" WHERE "status" = 'leased'
  ) THEN
    RAISE EXCEPTION '0068 migration requires zero leased application precompute jobs';
  END IF;
END $$;--> statement-breakpoint
ALTER TABLE "grant_application_precompute_attempts" ADD CONSTRAINT "grant_application_precompute_attempts_job_id_grant_application_precompute_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."grant_application_precompute_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_application_precompute_attempts_job_attempt_idx" ON "grant_application_precompute_attempts" USING btree ("job_id","attempt_count");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_application_precompute_attempts_lease_token_idx" ON "grant_application_precompute_attempts" USING btree ("lease_token");--> statement-breakpoint
CREATE INDEX "grant_application_precompute_attempts_started_at_idx" ON "grant_application_precompute_attempts" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "grant_application_precompute_attempts_active_idx" ON "grant_application_precompute_attempts" USING btree ("status","started_at") WHERE "grant_application_precompute_attempts"."status" = 'leased';--> statement-breakpoint
INSERT INTO "grant_application_precompute_attempts" (
  "job_id", "attempt_count", "worker_id", "lease_token", "status",
  "reserved_cost_usd", "actual_request_count", "actual_input_tokens",
  "actual_output_tokens", "actual_cost_usd", "charged_cost_usd",
  "usage_complete", "last_error_code", "started_at", "completed_at",
  "created_at", "updated_at"
)
SELECT
  job."id",
  job."attempt_count",
  'migration-0068',
  gen_random_uuid(),
  CASE WHEN job."status" = 'succeeded' THEN 'succeeded' ELSE 'failed' END,
  CASE WHEN job."status" = 'succeeded' THEN 0 ELSE 0.500000 END,
  coalesce(job."request_count", 0),
  coalesce(job."input_tokens", 0),
  coalesce(job."output_tokens", 0),
  coalesce(job."cost_usd", 0),
  CASE
    WHEN job."status" = 'succeeded' THEN coalesce(job."cost_usd", 0)
    ELSE greatest(coalesce(job."cost_usd", 0), 0.500000)
  END,
  job."status" = 'succeeded',
  job."last_error_code",
  coalesce(job."started_at", job."created_at"),
  coalesce(job."completed_at", job."updated_at"),
  job."created_at",
  job."updated_at"
FROM "grant_application_precompute_jobs" job
WHERE job."attempt_count" > 0;--> statement-breakpoint
ALTER TABLE "grant_application_precompute_jobs" ADD CONSTRAINT "grant_application_precompute_jobs_lease_check" CHECK (
    ("grant_application_precompute_jobs"."status" = 'leased'
      AND "grant_application_precompute_jobs"."leased_at" IS NOT NULL
      AND "grant_application_precompute_jobs"."lease_expires_at" IS NOT NULL
      AND "grant_application_precompute_jobs"."worker_id" IS NOT NULL
      AND "grant_application_precompute_jobs"."lease_token" IS NOT NULL)
    OR ("grant_application_precompute_jobs"."status" <> 'leased' AND "grant_application_precompute_jobs"."lease_token" IS NULL)
  );
