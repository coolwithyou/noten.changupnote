-- Generated SQL scoped to writing tables; prior manual migrations 0081–0093 are already applied.
CREATE TABLE "company_writing_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"draft_id" uuid,
	"request_id" uuid NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"kind" text NOT NULL,
	"observed_date" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	CONSTRAINT "company_writing_sources_kind_check" CHECK ("company_writing_sources"."kind" in ('user_statement', 'company_document')),
	CONSTRAINT "company_writing_sources_size_check" CHECK (char_length("company_writing_sources"."title") between 1 and 200 and char_length("company_writing_sources"."content") between 1 and 30000)
);
--> statement-breakpoint
CREATE TABLE "document_writing_briefs" (
	"draft_id" uuid PRIMARY KEY NOT NULL,
	"company_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"brief" jsonb NOT NULL,
	"source_ids" jsonb NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_writing_briefs_revision_check" CHECK ("document_writing_briefs"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "company_writing_sources" ADD CONSTRAINT "company_writing_sources_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_writing_sources" ADD CONSTRAINT "company_writing_sources_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "company_writing_sources" ADD CONSTRAINT "company_writing_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_writing_briefs" ADD CONSTRAINT "document_writing_briefs_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_writing_briefs" ADD CONSTRAINT "document_writing_briefs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "document_writing_briefs" ADD CONSTRAINT "document_writing_briefs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "company_writing_sources_request_idx" ON "company_writing_sources" USING btree ("company_id","request_id");
--> statement-breakpoint
CREATE INDEX "company_writing_sources_company_created_idx" ON "company_writing_sources" USING btree ("company_id","created_at");
--> statement-breakpoint
CREATE INDEX "company_writing_sources_draft_idx" ON "company_writing_sources" USING btree ("draft_id");
--> statement-breakpoint
CREATE INDEX "company_writing_sources_creator_idx" ON "company_writing_sources" USING btree ("created_by");
--> statement-breakpoint
CREATE INDEX "document_writing_briefs_company_idx" ON "document_writing_briefs" USING btree ("company_id");
--> statement-breakpoint
CREATE INDEX "document_writing_briefs_updater_idx" ON "document_writing_briefs" USING btree ("updated_by");
--> statement-breakpoint
ALTER TABLE company_writing_sources ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE company_writing_sources FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_writing_briefs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE document_writing_briefs FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY writing_sources_read ON company_writing_sources FOR SELECT
USING (app_private.is_current_company_member(company_id));
--> statement-breakpoint
CREATE POLICY writing_sources_insert ON company_writing_sources FOR INSERT
WITH CHECK (app_private.can_current_user_write_company(company_id)
  AND created_by = app_private.current_user_id()
  AND (draft_id IS NULL OR EXISTS (SELECT 1 FROM grant_document_drafts d WHERE d.id = draft_id AND d.company_id = company_writing_sources.company_id)));
--> statement-breakpoint
CREATE POLICY writing_sources_update ON company_writing_sources FOR UPDATE
USING (app_private.can_current_user_write_company(company_id))
WITH CHECK (app_private.can_current_user_write_company(company_id));
--> statement-breakpoint
CREATE POLICY writing_briefs_read ON document_writing_briefs FOR SELECT
USING (app_private.is_current_company_member(company_id));
--> statement-breakpoint
CREATE POLICY writing_briefs_insert ON document_writing_briefs FOR INSERT
WITH CHECK (app_private.can_current_user_write_company(company_id)
  AND updated_by = app_private.current_user_id()
  AND EXISTS (SELECT 1 FROM grant_document_drafts d WHERE d.id = draft_id AND d.company_id = document_writing_briefs.company_id));
--> statement-breakpoint
CREATE POLICY writing_briefs_update ON document_writing_briefs FOR UPDATE
USING (app_private.can_current_user_write_company(company_id))
WITH CHECK (app_private.can_current_user_write_company(company_id)
  AND updated_by = app_private.current_user_id()
  AND EXISTS (SELECT 1 FROM grant_document_drafts d WHERE d.id = draft_id AND d.company_id = document_writing_briefs.company_id));
--> statement-breakpoint
CREATE FUNCTION app_private.protect_writing_source() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF (to_jsonb(NEW) - 'withdrawn_at' - 'created_by') IS DISTINCT FROM (to_jsonb(OLD) - 'withdrawn_at' - 'created_by')
    OR (NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL)
    OR (OLD.withdrawn_at IS NOT NULL AND NEW.withdrawn_at IS DISTINCT FROM OLD.withdrawn_at) THEN
    RAISE EXCEPTION 'writing source is immutable; create a new source revision' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER protect_writing_source BEFORE UPDATE ON company_writing_sources
FOR EACH ROW EXECUTE FUNCTION app_private.protect_writing_source();
