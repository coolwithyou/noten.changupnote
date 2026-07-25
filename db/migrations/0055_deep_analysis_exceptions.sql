CREATE TABLE "grant_deep_analysis_exception_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"exception_key" text NOT NULL,
	"event_type" text NOT NULL,
	"reason_code" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor" text NOT NULL,
	"detail" jsonb NOT NULL,
	"evidence_sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_deep_analysis_exception_events_event_check" CHECK (
    "grant_deep_analysis_exception_events"."event_type" IN ('opened', 'resolved', 'reopened')
  ),
	CONSTRAINT "grant_deep_analysis_exception_events_actor_check" CHECK (
    "grant_deep_analysis_exception_events"."actor_type" IN ('system', 'human')
  ),
	CONSTRAINT "grant_deep_analysis_exception_events_hash_check" CHECK (
    "grant_deep_analysis_exception_events"."evidence_sha256" ~ '^[0-9a-f]{64}$'
  )
);
--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_exception_events" ADD CONSTRAINT "grant_deep_analysis_exception_events_run_id_grant_deep_analysis_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grant_deep_analysis_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_exception_events_run_created_idx" ON "grant_deep_analysis_exception_events" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "grant_deep_analysis_exception_events_key_created_idx" ON "grant_deep_analysis_exception_events" USING btree ("exception_key","created_at");--> statement-breakpoint
CREATE TRIGGER "grant_deep_analysis_exception_events_append_only"
BEFORE UPDATE OR DELETE ON "grant_deep_analysis_exception_events"
FOR EACH ROW EXECUTE FUNCTION "cunote_prevent_deep_analysis_mutation"();--> statement-breakpoint
ALTER TABLE "grant_deep_analysis_exception_events" ENABLE ROW LEVEL SECURITY;
