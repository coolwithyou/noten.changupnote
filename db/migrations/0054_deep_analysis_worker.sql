CREATE TABLE "grant_deep_analysis_worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"service_revision" text NOT NULL,
	"model_policy_version" text NOT NULL,
	"status" text NOT NULL,
	"current_job_id" uuid,
	"last_error_code" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_deep_analysis_worker_heartbeats_status_check" CHECK (
    "grant_deep_analysis_worker_heartbeats"."status" IN ('idle', 'running', 'degraded', 'stopped')
  )
);
--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_jobs" DROP CONSTRAINT "grant_deep_analysis_jobs_status_check";--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_worker_heartbeats" ADD CONSTRAINT "grant_deep_analysis_worker_heartbeats_current_job_id_grant_deep_analysis_jobs_id_fk" FOREIGN KEY ("current_job_id") REFERENCES "public"."grant_deep_analysis_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_worker_heartbeats_heartbeat_idx" ON "grant_deep_analysis_worker_heartbeats" USING btree ("heartbeat_at");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_worker_heartbeats_status_heartbeat_idx" ON "grant_deep_analysis_worker_heartbeats" USING btree ("status","heartbeat_at");--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_jobs" ADD CONSTRAINT "grant_deep_analysis_jobs_status_check" CHECK (
    "grant_deep_analysis_jobs"."status" IN (
      'pending', 'leased', 'retry_wait', 'pending_budget', 'succeeded', 'blocked',
      'dead_letter', 'canceled'
    )
  );--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_worker_heartbeats" ENABLE ROW LEVEL SECURITY;
