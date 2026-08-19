CREATE TABLE "generative_usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"grant_id" uuid,
	"source_kind" text NOT NULL,
	"source_request_id" uuid NOT NULL,
	"run_id" uuid,
	"attempt" integer,
	"lease_version" integer,
	"model" text NOT NULL,
	"usage_status" text DEFAULT 'started' NOT NULL,
	"provider_request_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finalized_at" timestamp with time zone,
	CONSTRAINT "generative_usage_events_state_check" CHECK (
    "generative_usage_events"."usage_status" IN ('started', 'reported', 'unavailable')
    AND (
      ("generative_usage_events"."run_id" IS NOT NULL AND "generative_usage_events"."attempt" >= 1 AND "generative_usage_events"."lease_version" >= 1)
      OR ("generative_usage_events"."run_id" IS NULL AND "generative_usage_events"."attempt" IS NULL AND "generative_usage_events"."lease_version" IS NULL)
    )
    AND (
      ("generative_usage_events"."usage_status" = 'started' AND "generative_usage_events"."finalized_at" IS NULL)
      OR ("generative_usage_events"."usage_status" <> 'started' AND "generative_usage_events"."finalized_at" IS NOT NULL)
    )
    AND ("generative_usage_events"."input_tokens" IS NULL OR "generative_usage_events"."input_tokens" >= 0)
    AND ("generative_usage_events"."output_tokens" IS NULL OR "generative_usage_events"."output_tokens" >= 0)
    AND ("generative_usage_events"."cache_read_tokens" IS NULL OR "generative_usage_events"."cache_read_tokens" >= 0)
    AND ("generative_usage_events"."cache_write_tokens" IS NULL OR "generative_usage_events"."cache_write_tokens" >= 0)
  )
);
--> statement-breakpoint
CREATE TABLE "grant_document_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"status_version" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"lease_owner" uuid,
	"lease_version" integer DEFAULT 1 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"request_binding_sha256" text NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"document_sha256" text NOT NULL,
	"studio_session_id" text NOT NULL,
	"document_epoch" integer NOT NULL,
	"change_seq" integer NOT NULL,
	"selected_page" integer NOT NULL,
	"candidate" jsonb NOT NULL,
	"candidate_id" text NOT NULL,
	"model_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"grounding_binding_sha256" text NOT NULL,
	"grounding_provenance" jsonb NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "grant_document_agent_runs_state_check" CHECK (
    "grant_document_agent_runs"."status" IN ('generating', 'ready', 'empty', 'failed', 'cancelled')
    AND "grant_document_agent_runs"."status_version" >= 0
    AND "grant_document_agent_runs"."attempt" >= 1
    AND "grant_document_agent_runs"."lease_version" >= 1
    AND "grant_document_agent_runs"."document_epoch" >= 1
    AND "grant_document_agent_runs"."change_seq" >= 0
    AND "grant_document_agent_runs"."selected_page" >= 1
    AND "grant_document_agent_runs"."input_tokens" >= 0
    AND "grant_document_agent_runs"."output_tokens" >= 0
    AND "grant_document_agent_runs"."cache_read_tokens" >= 0
    AND "grant_document_agent_runs"."cache_write_tokens" >= 0
    AND char_length("grant_document_agent_runs"."request_binding_sha256") = 64
    AND char_length("grant_document_agent_runs"."document_sha256") = 64
    AND char_length("grant_document_agent_runs"."grounding_binding_sha256") = 64
    AND (
      ("grant_document_agent_runs"."status" = 'generating' AND "grant_document_agent_runs"."lease_owner" IS NOT NULL AND "grant_document_agent_runs"."lease_expires_at" IS NOT NULL)
      OR ("grant_document_agent_runs"."status" <> 'generating' AND "grant_document_agent_runs"."lease_owner" IS NULL AND "grant_document_agent_runs"."lease_expires_at" IS NULL)
    )
  )
);
--> statement-breakpoint
CREATE TABLE "grant_document_agent_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"anchor" jsonb NOT NULL,
	"location" jsonb NOT NULL,
	"before_text" text NOT NULL,
	"after_text" text NOT NULL,
	"format" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"status_version" integer DEFAULT 0 NOT NULL,
	"operation_state" text DEFAULT 'idle' NOT NULL,
	"operation_version" integer DEFAULT 0 NOT NULL,
	"operation_started_at" timestamp with time zone,
	"operation_client_id" uuid,
	"failure_code" text,
	"applied_document_sha256" text,
	"undone_document_sha256" text,
	"applied_revision_id" uuid,
	"undone_revision_id" uuid,
	"approved_at" timestamp with time zone,
	"applied_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_document_agent_suggestions_state_check" CHECK (
    "grant_document_agent_suggestions"."ordinal" BETWEEN 0 AND 1
    AND "grant_document_agent_suggestions"."status" IN ('pending', 'approved', 'applied', 'undone', 'dismissed', 'stale')
    AND "grant_document_agent_suggestions"."status_version" >= 0
    AND "grant_document_agent_suggestions"."operation_version" >= 0
    AND "grant_document_agent_suggestions"."operation_state" IN ('idle', 'apply_saving', 'apply_save_failed', 'undo_saving', 'undo_save_failed')
    AND (
      "grant_document_agent_suggestions"."failure_code" IS NULL OR "grant_document_agent_suggestions"."failure_code" IN (
        'core_validation_failed', 'reload_failed', 'snapshot_upload_failed', 'revision_conflict',
        'undo_conflict', 'apply_rolled_back', 'undo_rolled_back', 'operation_recovered'
      )
    )
  ),
	CONSTRAINT "grant_document_agent_suggestions_operation_binding_check" CHECK (
    (
      "grant_document_agent_suggestions"."operation_state" IN ('apply_saving', 'undo_saving')
      AND "grant_document_agent_suggestions"."operation_started_at" IS NOT NULL
      AND "grant_document_agent_suggestions"."operation_client_id" IS NOT NULL
    ) OR (
      "grant_document_agent_suggestions"."operation_state" IN ('apply_save_failed', 'undo_save_failed')
      AND "grant_document_agent_suggestions"."operation_started_at" IS NULL
      AND "grant_document_agent_suggestions"."operation_client_id" IS NOT NULL
    ) OR (
      "grant_document_agent_suggestions"."operation_state" = 'idle'
      AND "grant_document_agent_suggestions"."operation_started_at" IS NULL
      AND "grant_document_agent_suggestions"."operation_client_id" IS NULL
    )
  )
);
--> statement-breakpoint
DROP INDEX "grant_document_revisions_snapshot_idempotency_unique";--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD COLUMN "checkpoint_request_id" uuid;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD COLUMN "agent_command_id" text;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD COLUMN "agent_operation" text;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD COLUMN "agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD COLUMN "agent_suggestion_id" uuid;--> statement-breakpoint
ALTER TABLE "generative_usage_events" ADD CONSTRAINT "generative_usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generative_usage_events" ADD CONSTRAINT "generative_usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generative_usage_events" ADD CONSTRAINT "generative_usage_events_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "generative_usage_events" ADD CONSTRAINT "generative_usage_events_run_id_grant_document_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grant_document_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_agent_runs" ADD CONSTRAINT "grant_document_agent_runs_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_agent_runs" ADD CONSTRAINT "grant_document_agent_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_agent_runs" ADD CONSTRAINT "grant_document_agent_runs_base_revision_id_grant_document_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."grant_document_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_agent_suggestions" ADD CONSTRAINT "grant_document_agent_suggestions_run_id_grant_document_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grant_document_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_agent_suggestions" ADD CONSTRAINT "grant_document_agent_suggestions_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_agent_suggestions" ADD CONSTRAINT "grant_document_agent_suggestions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_agent_suggestions" ADD CONSTRAINT "grant_document_agent_suggestions_applied_revision_id_grant_document_revisions_id_fk" FOREIGN KEY ("applied_revision_id") REFERENCES "public"."grant_document_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_agent_suggestions" ADD CONSTRAINT "grant_document_agent_suggestions_undone_revision_id_grant_document_revisions_id_fk" FOREIGN KEY ("undone_revision_id") REFERENCES "public"."grant_document_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "generative_usage_events_company_user_created_idx" ON "generative_usage_events" USING btree ("company_id","user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "generative_usage_events_run_attempt_unique" ON "generative_usage_events" USING btree ("run_id","attempt","lease_version") WHERE "generative_usage_events"."run_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "generative_usage_events_source_request_unique" ON "generative_usage_events" USING btree ("source_kind","source_request_id") WHERE "generative_usage_events"."run_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_agent_runs_client_request_unique" ON "grant_document_agent_runs" USING btree ("draft_id","created_by","client_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_agent_runs_active_creator_unique" ON "grant_document_agent_runs" USING btree ("draft_id","created_by") WHERE "grant_document_agent_runs"."status" = 'generating';--> statement-breakpoint
CREATE INDEX "grant_document_agent_runs_status_lease_idx" ON "grant_document_agent_runs" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE INDEX "grant_document_agent_runs_base_revision_idx" ON "grant_document_agent_runs" USING btree ("base_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_agent_suggestions_run_ordinal_unique" ON "grant_document_agent_suggestions" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "grant_document_agent_suggestions_draft_creator_updated_idx" ON "grant_document_agent_suggestions" USING btree ("draft_id","created_by","updated_at");--> statement-breakpoint
CREATE INDEX "grant_document_agent_suggestions_applied_revision_idx" ON "grant_document_agent_suggestions" USING btree ("applied_revision_id");--> statement-breakpoint
CREATE INDEX "grant_document_agent_suggestions_undone_revision_idx" ON "grant_document_agent_suggestions" USING btree ("undone_revision_id");--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_agent_run_id_grant_document_agent_runs_id_fk" FOREIGN KEY ("agent_run_id") REFERENCES "public"."grant_document_agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_agent_suggestion_id_grant_document_agent_suggestions_id_fk" FOREIGN KEY ("agent_suggestion_id") REFERENCES "public"."grant_document_agent_suggestions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_revisions_checkpoint_request_unique" ON "grant_document_revisions" USING btree ("draft_id","created_by","checkpoint_request_id") WHERE "grant_document_revisions"."checkpoint_request_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_revisions_agent_command_unique" ON "grant_document_revisions" USING btree ("agent_command_id") WHERE "grant_document_revisions"."agent_command_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "grant_document_revisions_agent_run_idx" ON "grant_document_revisions" USING btree ("agent_run_id");--> statement-breakpoint
CREATE INDEX "grant_document_revisions_agent_suggestion_idx" ON "grant_document_revisions" USING btree ("agent_suggestion_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_revisions_snapshot_idempotency_unique" ON "grant_document_revisions" USING btree ("draft_id","studio_session_id","document_epoch","change_seq","sha256") WHERE "grant_document_revisions"."checkpoint_request_id" IS NULL;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_agent_binding_check" CHECK (
    (
      "grant_document_revisions"."agent_command_id" IS NULL
      AND "grant_document_revisions"."agent_operation" IS NULL
      AND "grant_document_revisions"."agent_run_id" IS NULL
      AND "grant_document_revisions"."agent_suggestion_id" IS NULL
    ) OR (
      "grant_document_revisions"."agent_command_id" IS NOT NULL
      AND "grant_document_revisions"."agent_operation" IN ('apply', 'undo')
      AND "grant_document_revisions"."agent_run_id" IS NOT NULL
      AND "grant_document_revisions"."agent_suggestion_id" IS NOT NULL
    )
  );--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_origin_binding_check" CHECK (
    (
      "grant_document_revisions"."origin" = 'studio_agent_checkpoint'
      AND "grant_document_revisions"."checkpoint_request_id" IS NOT NULL
      AND "grant_document_revisions"."agent_command_id" IS NULL
    ) OR (
      "grant_document_revisions"."origin" IN ('studio_agent_apply', 'studio_agent_undo')
      AND "grant_document_revisions"."checkpoint_request_id" IS NULL
      AND "grant_document_revisions"."agent_command_id" IS NOT NULL
      AND "grant_document_revisions"."agent_operation" = CASE
        WHEN "grant_document_revisions"."origin" = 'studio_agent_apply' THEN 'apply'
        ELSE 'undo'
      END
    ) OR (
      "grant_document_revisions"."origin" NOT IN ('studio_agent_checkpoint', 'studio_agent_apply', 'studio_agent_undo')
      AND "grant_document_revisions"."checkpoint_request_id" IS NULL
      AND "grant_document_revisions"."agent_command_id" IS NULL
    )
  );--> statement-breakpoint
ALTER TABLE "grant_document_agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_agent_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_agent_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_agent_suggestions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generative_usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "generative_usage_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "grant_document_agent_runs_creator_select"
ON "grant_document_agent_runs"
FOR SELECT
USING (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_agent_runs"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_agent_runs_writer_insert"
ON "grant_document_agent_runs"
FOR INSERT
WITH CHECK (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_agent_runs"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_agent_runs_writer_update"
ON "grant_document_agent_runs"
FOR UPDATE
USING (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_agent_runs"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_agent_runs"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_agent_suggestions_creator_select"
ON "grant_document_agent_suggestions"
FOR SELECT
USING (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_agent_suggestions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_agent_suggestions_writer_insert"
ON "grant_document_agent_suggestions"
FOR INSERT
WITH CHECK (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_agent_suggestions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_agent_suggestions_writer_update"
ON "grant_document_agent_suggestions"
FOR UPDATE
USING (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_agent_suggestions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_agent_suggestions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "generative_usage_events_creator_select"
ON "generative_usage_events"
FOR SELECT
USING (
  "user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "generative_usage_events"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "generative_usage_events_writer_insert"
ON "generative_usage_events"
FOR INSERT
WITH CHECK (
  "user_id" = "app_private"."current_user_id"()
  AND "usage_status" = 'started'
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "generative_usage_events"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "generative_usage_events_writer_update"
ON "generative_usage_events"
FOR UPDATE
USING (
  "user_id" = "app_private"."current_user_id"()
  AND "usage_status" = 'started'
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "generative_usage_events"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  "user_id" = "app_private"."current_user_id"()
  AND "usage_status" IN ('reported', 'unavailable')
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "generative_usage_events"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);
