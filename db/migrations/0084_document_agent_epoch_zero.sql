ALTER TABLE "grant_document_agent_runs"
  DROP CONSTRAINT "grant_document_agent_runs_state_check",
  ADD CONSTRAINT "grant_document_agent_runs_state_check" CHECK (
    "grant_document_agent_runs"."status" IN ('generating', 'ready', 'empty', 'failed', 'cancelled')
    AND "grant_document_agent_runs"."status_version" >= 0
    AND "grant_document_agent_runs"."attempt" >= 1
    AND "grant_document_agent_runs"."lease_version" >= 1
    AND "grant_document_agent_runs"."document_epoch" >= 0
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
      (
        "grant_document_agent_runs"."status" = 'generating'
        AND "grant_document_agent_runs"."lease_owner" IS NOT NULL
        AND "grant_document_agent_runs"."lease_expires_at" IS NOT NULL
      )
      OR (
        "grant_document_agent_runs"."status" <> 'generating'
        AND "grant_document_agent_runs"."lease_owner" IS NULL
        AND "grant_document_agent_runs"."lease_expires_at" IS NULL
      )
    )
  ) NOT VALID;
--> statement-breakpoint
ALTER TABLE "grant_document_agent_runs"
  VALIDATE CONSTRAINT "grant_document_agent_runs_state_check";
