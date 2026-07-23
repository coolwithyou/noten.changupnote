ALTER TABLE "grant_document_revisions" ADD COLUMN "materialized_answers" jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_revisions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_revision_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_revision_heads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "grant_document_revisions_member_select"
ON "grant_document_revisions"
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_revisions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_revisions_writer_insert"
ON "grant_document_revisions"
FOR INSERT
WITH CHECK (
  "created_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_revisions"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_revision_heads_member_select"
ON "grant_document_revision_heads"
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_revision_heads"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_revision_heads_writer_insert"
ON "grant_document_revision_heads"
FOR INSERT
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_revision_heads"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_revision_heads_writer_update"
ON "grant_document_revision_heads"
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_revision_heads"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_revision_heads"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);
