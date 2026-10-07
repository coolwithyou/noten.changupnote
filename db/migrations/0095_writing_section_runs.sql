ALTER TABLE "grant_document_field_agent_runs" ADD COLUMN "writing_context_binding_sha256" text;--> statement-breakpoint
ALTER TABLE "grant_document_field_agent_runs" ADD COLUMN "composition" jsonb;