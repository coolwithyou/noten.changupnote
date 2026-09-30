CREATE TABLE "document_writing_section_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"draft_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"base_revision" integer NOT NULL,
	"writing_binding" text NOT NULL,
	"field_binding" text NOT NULL,
	"status" text NOT NULL,
	"composition" jsonb,
	"error_code" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "document_writing_section_runs_state_check" CHECK ("document_writing_section_runs"."status" in ('running', 'ready', 'failed') and "document_writing_section_runs"."base_revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "document_writing_sections" (
	"draft_id" uuid NOT NULL,
	"field_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"label" text NOT NULL,
	"revision" integer NOT NULL,
	"content" text NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_writing_sections_draft_id_field_id_pk" PRIMARY KEY("draft_id","field_id"),
	CONSTRAINT "document_writing_sections_value_check" CHECK ("document_writing_sections"."revision" > 0 and char_length("document_writing_sections"."content") <= 12000)
);
--> statement-breakpoint
ALTER TABLE "document_writing_section_runs" ADD CONSTRAINT "document_writing_section_runs_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_writing_section_runs" ADD CONSTRAINT "document_writing_section_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_writing_section_runs" ADD CONSTRAINT "document_writing_section_runs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_writing_sections" ADD CONSTRAINT "document_writing_sections_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_writing_sections" ADD CONSTRAINT "document_writing_sections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_writing_sections" ADD CONSTRAINT "document_writing_sections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_writing_section_runs_draft_idx" ON "document_writing_section_runs" USING btree ("draft_id","field_id","created_at");--> statement-breakpoint
CREATE INDEX "document_writing_section_runs_company_idx" ON "document_writing_section_runs" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "document_writing_section_runs_creator_idx" ON "document_writing_section_runs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "document_writing_sections_company_idx" ON "document_writing_sections" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "document_writing_sections_updater_idx" ON "document_writing_sections" USING btree ("updated_by");
--> statement-breakpoint
ALTER TABLE document_writing_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_writing_sections FORCE ROW LEVEL SECURITY;
ALTER TABLE document_writing_section_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_writing_section_runs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY writing_sections_read ON document_writing_sections FOR SELECT
USING (app_private.is_current_company_member(company_id));
CREATE POLICY writing_sections_insert ON document_writing_sections FOR INSERT
WITH CHECK (app_private.can_current_user_write_company(company_id)
  AND updated_by = app_private.current_user_id()
  AND EXISTS (SELECT 1 FROM grant_document_drafts d WHERE d.id = draft_id AND d.company_id = document_writing_sections.company_id));
CREATE POLICY writing_sections_update ON document_writing_sections FOR UPDATE
USING (app_private.can_current_user_write_company(company_id))
WITH CHECK (app_private.can_current_user_write_company(company_id)
  AND updated_by = app_private.current_user_id()
  AND EXISTS (SELECT 1 FROM grant_document_drafts d WHERE d.id = draft_id AND d.company_id = document_writing_sections.company_id));
--> statement-breakpoint
CREATE POLICY writing_section_runs_read ON document_writing_section_runs FOR SELECT
USING (app_private.is_current_company_member(company_id));
CREATE POLICY writing_section_runs_insert ON document_writing_section_runs FOR INSERT
WITH CHECK (app_private.can_current_user_write_company(company_id)
  AND created_by = app_private.current_user_id()
  AND EXISTS (SELECT 1 FROM grant_document_drafts d WHERE d.id = draft_id AND d.company_id = document_writing_section_runs.company_id));
CREATE POLICY writing_section_runs_update ON document_writing_section_runs FOR UPDATE
USING (app_private.can_current_user_write_company(company_id) AND created_by = app_private.current_user_id())
WITH CHECK (app_private.can_current_user_write_company(company_id)
  AND created_by = app_private.current_user_id()
  AND EXISTS (SELECT 1 FROM grant_document_drafts d WHERE d.id = draft_id AND d.company_id = document_writing_section_runs.company_id));
