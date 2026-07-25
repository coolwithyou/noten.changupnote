CREATE TABLE "admin_deep_analysis_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"admin_user_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"run_id" uuid,
	"job_id" uuid,
	"exception_key" text,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_deep_analysis_actions_action_check" CHECK (
    "admin_deep_analysis_actions"."action" IN ('requeue_job', 'claim_exception', 'release_exception')
  ),
	CONSTRAINT "admin_deep_analysis_actions_outcome_check" CHECK (
    "admin_deep_analysis_actions"."outcome" IN ('succeeded', 'failed')
  )
);
--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_exception_events" DROP CONSTRAINT "grant_deep_analysis_exception_events_event_check";--> statement-breakpoint
ALTER TABLE "admin_deep_analysis_actions" ADD CONSTRAINT "admin_deep_analysis_actions_admin_user_id_admin_users_id_fk" FOREIGN KEY ("admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_deep_analysis_actions" ADD CONSTRAINT "admin_deep_analysis_actions_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_deep_analysis_actions" ADD CONSTRAINT "admin_deep_analysis_actions_run_id_grant_deep_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grant_deep_analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_deep_analysis_actions" ADD CONSTRAINT "admin_deep_analysis_actions_job_id_grant_deep_analysis_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."grant_deep_analysis_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_deep_analysis_actions_request_idx" ON "admin_deep_analysis_actions" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "admin_deep_analysis_actions_grant_created_idx" ON "admin_deep_analysis_actions" USING btree ("grant_id","created_at");--> statement-breakpoint
CREATE INDEX "admin_deep_analysis_actions_admin_created_idx" ON "admin_deep_analysis_actions" USING btree ("admin_user_id","created_at");--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_exception_events" ADD CONSTRAINT "grant_deep_analysis_exception_events_event_check" CHECK (
    "grant_deep_analysis_exception_events"."event_type" IN ('opened', 'resolved', 'reopened', 'assigned', 'released')
  );--> statement-breakpoint
CREATE FUNCTION "cunote_active_deep_analysis_grants"("as_of" timestamptz)
RETURNS TABLE("grant_id" uuid)
LANGUAGE sql
STABLE
AS $$
  SELECT g.id
  FROM grants g
  WHERE g.status = 'open'
    AND g.apply_end IS NOT NULL
    AND timezone('Asia/Seoul', g.apply_end)::date
      >= timezone('Asia/Seoul', as_of)::date
    AND (
      g.apply_start IS NULL
      OR timezone('Asia/Seoul', g.apply_start)::date
        <= timezone('Asia/Seoul', as_of)::date
    )
$$;--> statement-breakpoint
CREATE TRIGGER "admin_deep_analysis_actions_append_only"
BEFORE UPDATE OR DELETE ON "admin_deep_analysis_actions"
FOR EACH ROW EXECUTE FUNCTION "cunote_prevent_deep_analysis_mutation"();--> statement-breakpoint
ALTER TABLE "admin_deep_analysis_actions" ENABLE ROW LEVEL SECURITY;
