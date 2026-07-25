CREATE TABLE "grant_aggregate_split_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"source_revision_sha256" text NOT NULL,
	"status" text DEFAULT 'pending_review' NOT NULL,
	"reason_code" text NOT NULL,
	"input_chars" integer NOT NULL,
	"input_cap_chars" integer NOT NULL,
	"chunk_count" integer NOT NULL,
	"attachment_count" integer NOT NULL,
	"evidence" jsonb NOT NULL,
	"evidence_sha256" text NOT NULL,
	"approval_request_id" uuid,
	"approved_by_admin_user_id" uuid,
	"approved_at" timestamp with time zone,
	"processing_started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error_code" text,
	"last_error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_aggregate_split_cases_status_check" CHECK (
    "grant_aggregate_split_cases"."status" IN (
      'pending_review', 'approved', 'processing', 'completed', 'failed'
    )
  ),
	CONSTRAINT "grant_aggregate_split_cases_reason_check" CHECK (
    "grant_aggregate_split_cases"."reason_code" IN ('oversized_aggregate_notice')
  ),
	CONSTRAINT "grant_aggregate_split_cases_hash_check" CHECK (
    "grant_aggregate_split_cases"."source_revision_sha256" ~ '^[0-9a-f]{64}$'
    AND "grant_aggregate_split_cases"."evidence_sha256" ~ '^[0-9a-f]{64}$'
  ),
	CONSTRAINT "grant_aggregate_split_cases_counts_check" CHECK (
    "grant_aggregate_split_cases"."input_chars" > "grant_aggregate_split_cases"."input_cap_chars"
    AND "grant_aggregate_split_cases"."input_cap_chars" > 0
    AND "grant_aggregate_split_cases"."chunk_count" > 0
    AND "grant_aggregate_split_cases"."attachment_count" >= 0
  ),
	CONSTRAINT "grant_aggregate_split_cases_approval_check" CHECK (
    (
      "grant_aggregate_split_cases"."status" = 'pending_review'
      AND "grant_aggregate_split_cases"."approval_request_id" IS NULL
      AND "grant_aggregate_split_cases"."approved_by_admin_user_id" IS NULL
      AND "grant_aggregate_split_cases"."approved_at" IS NULL
    )
    OR (
      "grant_aggregate_split_cases"."status" <> 'pending_review'
      AND "grant_aggregate_split_cases"."approval_request_id" IS NOT NULL
      AND "grant_aggregate_split_cases"."approved_by_admin_user_id" IS NOT NULL
      AND "grant_aggregate_split_cases"."approved_at" IS NOT NULL
    )
  )
);
--> statement-breakpoint
ALTER TABLE "admin_deep_analysis_actions" DROP CONSTRAINT "admin_deep_analysis_actions_action_check";--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ADD CONSTRAINT "grant_aggregate_split_cases_approved_by_admin_user_id_admin_users_id_fk" FOREIGN KEY ("approved_by_admin_user_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_aggregate_split_cases_identity_idx" ON "grant_aggregate_split_cases" USING btree ("grant_id","source_revision_sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_aggregate_split_cases_approval_request_idx" ON "grant_aggregate_split_cases" USING btree ("approval_request_id");--> statement-breakpoint
CREATE INDEX "grant_aggregate_split_cases_status_created_idx" ON "grant_aggregate_split_cases" USING btree ("status","created_at");--> statement-breakpoint
ALTER TABLE "admin_deep_analysis_actions" ADD CONSTRAINT "admin_deep_analysis_actions_action_check" CHECK (
    "admin_deep_analysis_actions"."action" IN (
      'requeue_job', 'claim_exception', 'release_exception', 'approve_aggregate_split'
    )
  );--> statement-breakpoint
ALTER TABLE "grant_aggregate_split_cases" ENABLE ROW LEVEL SECURITY;
