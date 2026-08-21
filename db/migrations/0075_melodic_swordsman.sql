ALTER TABLE "grant_document_field_agent_runs" DROP CONSTRAINT "grant_document_field_agent_runs_state_check";--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_runs" ADD COLUMN "document_semantic_sha256" text;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_runs" ADD CONSTRAINT "grant_document_field_agent_runs_state_check" CHECK (
    "grant_document_field_agent_runs"."status" IN ('generating', 'ready', 'empty', 'failed')
    AND "grant_document_field_agent_runs"."status_version" >= 0
    AND char_length("grant_document_field_agent_runs"."request_binding_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."document_sha256") = 64
    AND ("grant_document_field_agent_runs"."document_semantic_sha256" IS NULL OR char_length("grant_document_field_agent_runs"."document_semantic_sha256") = 64)
    AND char_length("grant_document_field_agent_runs"."field_binding_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."before_text_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."format_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."adjacent_context_sha256") = 64
    AND char_length("grant_document_field_agent_runs"."grounding_binding_sha256") = 64
  );