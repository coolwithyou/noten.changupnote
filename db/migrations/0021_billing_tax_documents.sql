CREATE TABLE "billing_tax_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"document_kind" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"archive_url" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_tax_documents" ADD CONSTRAINT "billing_tax_documents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_tax_documents" ADD CONSTRAINT "billing_tax_documents_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_tax_documents_company_status_idx" ON "billing_tax_documents" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "billing_tax_documents_uploaded_by_idx" ON "billing_tax_documents" USING btree ("uploaded_by");--> statement-breakpoint
CREATE INDEX "billing_tax_documents_sha_idx" ON "billing_tax_documents" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "billing_tax_documents_updated_at_idx" ON "billing_tax_documents" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "billing_tax_documents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "billing_tax_documents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "billing_tax_documents_member_select"
ON "billing_tax_documents"
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "billing_tax_documents"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "billing_tax_documents_writer_insert"
ON "billing_tax_documents"
FOR INSERT
WITH CHECK (
  "uploaded_by" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "billing_tax_documents"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "billing_tax_documents_writer_update"
ON "billing_tax_documents"
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "billing_tax_documents"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "billing_tax_documents"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);
