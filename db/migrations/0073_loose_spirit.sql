CREATE TABLE "grant_document_field_agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"field_label" text NOT NULL,
	"created_by" uuid NOT NULL,
	"client_request_id" uuid NOT NULL,
	"status" text DEFAULT 'generating' NOT NULL,
	"status_version" integer DEFAULT 0 NOT NULL,
	"request_binding_sha256" text NOT NULL,
	"base_revision_id" uuid NOT NULL,
	"document_sha256" text NOT NULL,
	"field_binding_sha256" text NOT NULL,
	"target" jsonb NOT NULL,
	"before_text" text NOT NULL,
	"before_text_sha256" text NOT NULL,
	"format_sha256" text NOT NULL,
	"adjacent_context_sha256" text NOT NULL,
	"before_answer" jsonb,
	"model_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"grounding_binding_sha256" text NOT NULL,
	"failure_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "grant_document_field_agent_runs_state_check" CHECK (
    "grant_document_field_agent_runs"."status" IN ('generating', 'ready', 'empty', 'failed')
    AND "grant_document_field_agent_runs"."status_version" >= 0
    AND char_length("grant_document_field_agent_runs"."request_binding_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."document_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."field_binding_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."before_text_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."format_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."adjacent_context_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."grounding_binding_sha256") = 64
  )
);
--> statement-breakpoint
CREATE TABLE "grant_document_field_agent_suggestions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"draft_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"created_by" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"value" text NOT NULL,
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
	"applied_at" timestamp with time zone,
	"undone_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "grant_document_field_agent_suggestions_state_check" CHECK (
    "grant_document_field_agent_suggestions"."ordinal" BETWEEN 0 AND 1
    AND "grant_document_field_agent_suggestions"."status" IN ('pending', 'applied', 'undone', 'dismissed', 'stale')
    AND "grant_document_field_agent_suggestions"."status_version" >= 0
    AND "grant_document_field_agent_suggestions"."operation_version" >= 0
    AND "grant_document_field_agent_suggestions"."operation_state" IN ('idle', 'apply_saving', 'undo_saving')
    AND (
      ("grant_document_field_agent_suggestions"."operation_state" IN ('apply_saving', 'undo_saving')
        AND "grant_document_field_agent_suggestions"."operation_started_at" IS NOT NULL
        AND "grant_document_field_agent_suggestions"."operation_client_id" IS NOT NULL)
      OR ("grant_document_field_agent_suggestions"."operation_state" = 'idle'
        AND "grant_document_field_agent_suggestions"."operation_started_at" IS NULL
        AND "grant_document_field_agent_suggestions"."operation_client_id" IS NULL)
    )
  )
);
--> statement-breakpoint
ALTER TABLE "grant_document_revisions" DROP CONSTRAINT "grant_document_revisions_agent_binding_check";--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD COLUMN "field_agent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD COLUMN "field_agent_suggestion_id" uuid;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_runs" ADD CONSTRAINT "grant_document_field_agent_runs_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_runs" ADD CONSTRAINT "grant_document_field_agent_runs_field_id_grant_document_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."grant_document_fields"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_runs" ADD CONSTRAINT "grant_document_field_agent_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_runs" ADD CONSTRAINT "grant_document_field_agent_runs_base_revision_id_grant_document_revisions_id_fk" FOREIGN KEY ("base_revision_id") REFERENCES "public"."grant_document_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_suggestions" ADD CONSTRAINT "grant_document_field_agent_suggestions_run_id_grant_document_field_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."grant_document_field_agent_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_suggestions" ADD CONSTRAINT "grant_document_field_agent_suggestions_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_suggestions" ADD CONSTRAINT "grant_document_field_agent_suggestions_field_id_grant_document_fields_id_fk" FOREIGN KEY ("field_id") REFERENCES "public"."grant_document_fields"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_suggestions" ADD CONSTRAINT "grant_document_field_agent_suggestions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_suggestions" ADD CONSTRAINT "grant_document_field_agent_suggestions_applied_revision_id_grant_document_revisions_id_fk" FOREIGN KEY ("applied_revision_id") REFERENCES "public"."grant_document_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_suggestions" ADD CONSTRAINT "grant_document_field_agent_suggestions_undone_revision_id_grant_document_revisions_id_fk" FOREIGN KEY ("undone_revision_id") REFERENCES "public"."grant_document_revisions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_field_agent_runs_client_request_unique" ON "grant_document_field_agent_runs" USING btree ("draft_id","created_by","client_request_id");--> statement-breakpoint
CREATE INDEX "grant_document_field_agent_runs_field_created_idx" ON "grant_document_field_agent_runs" USING btree ("draft_id","field_id","created_at");--> statement-breakpoint
CREATE INDEX "grant_document_field_agent_runs_created_by_idx" ON "grant_document_field_agent_runs" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_document_field_agent_suggestions_run_ordinal_unique" ON "grant_document_field_agent_suggestions" USING btree ("run_id","ordinal");--> statement-breakpoint
CREATE INDEX "grant_document_field_agent_suggestions_draft_creator_updated_idx" ON "grant_document_field_agent_suggestions" USING btree ("draft_id","created_by","updated_at");--> statement-breakpoint
CREATE INDEX "grant_document_field_agent_suggestions_created_by_idx" ON "grant_document_field_agent_suggestions" USING btree ("created_by");--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_field_agent_run_id_grant_document_field_agent_runs_id_fk" FOREIGN KEY ("field_agent_run_id") REFERENCES "public"."grant_document_field_agent_runs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_field_agent_suggestion_id_grant_document_field_agent_suggestions_id_fk" FOREIGN KEY ("field_agent_suggestion_id") REFERENCES "public"."grant_document_field_agent_suggestions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grant_document_revisions_field_agent_run_idx" ON "grant_document_revisions" USING btree ("field_agent_run_id");--> statement-breakpoint
CREATE INDEX "grant_document_revisions_field_agent_suggestion_idx" ON "grant_document_revisions" USING btree ("field_agent_suggestion_id");--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ADD CONSTRAINT "grant_document_revisions_agent_binding_check" CHECK (
    (
      "grant_document_revisions"."agent_command_id" IS NULL
      AND "grant_document_revisions"."agent_operation" IS NULL
      AND "grant_document_revisions"."agent_run_id" IS NULL
      AND "grant_document_revisions"."agent_suggestion_id" IS NULL
      AND "grant_document_revisions"."field_agent_run_id" IS NULL
      AND "grant_document_revisions"."field_agent_suggestion_id" IS NULL
    ) OR (
      "grant_document_revisions"."agent_command_id" IS NOT NULL
      AND "grant_document_revisions"."agent_operation" IN ('apply', 'undo')
      AND (
        (
          "grant_document_revisions"."agent_run_id" IS NOT NULL
          AND "grant_document_revisions"."agent_suggestion_id" IS NOT NULL
          AND "grant_document_revisions"."field_agent_run_id" IS NULL
          AND "grant_document_revisions"."field_agent_suggestion_id" IS NULL
        ) OR (
          "grant_document_revisions"."agent_run_id" IS NULL
          AND "grant_document_revisions"."agent_suggestion_id" IS NULL
          AND "grant_document_revisions"."field_agent_run_id" IS NOT NULL
          AND "grant_document_revisions"."field_agent_suggestion_id" IS NOT NULL
        )
      )
    )
  );--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_suggestions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_suggestions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "grant_document_field_agent_runs_creator_select"
ON "grant_document_field_agent_runs" FOR SELECT
USING (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1 FROM "grant_document_drafts"
    JOIN "user_company" ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_field_agent_runs"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_field_agent_runs_writer_insert"
ON "grant_document_field_agent_runs" FOR INSERT
WITH CHECK (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1 FROM "grant_document_drafts"
    JOIN "user_company" ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_field_agent_runs"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_field_agent_runs_writer_update"
ON "grant_document_field_agent_runs" FOR UPDATE
USING (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1 FROM "grant_document_drafts"
    JOIN "user_company" ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_field_agent_runs"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1 FROM "grant_document_drafts"
    JOIN "user_company" ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_field_agent_runs"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_field_agent_suggestions_creator_select"
ON "grant_document_field_agent_suggestions" FOR SELECT
USING (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1 FROM "grant_document_drafts"
    JOIN "user_company" ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_field_agent_suggestions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_field_agent_suggestions_writer_insert"
ON "grant_document_field_agent_suggestions" FOR INSERT
WITH CHECK (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1 FROM "grant_document_drafts"
    JOIN "user_company" ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_field_agent_suggestions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_field_agent_suggestions_writer_update"
ON "grant_document_field_agent_suggestions" FOR UPDATE
USING (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1 FROM "grant_document_drafts"
    JOIN "user_company" ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_field_agent_suggestions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1 FROM "grant_document_drafts"
    JOIN "user_company" ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_field_agent_suggestions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);
