CREATE TABLE "grant_document_draft_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"draft_id" uuid NOT NULL,
	"actor_user_id" uuid NOT NULL,
	"event" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grant_document_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"document_key" text NOT NULL,
	"document_category" text NOT NULL,
	"document_name" text NOT NULL,
	"source_attachment" text,
	"draft_markdown" text NOT NULL,
	"filled_fields" jsonb NOT NULL,
	"missing_fields" jsonb NOT NULL,
	"used_profile_fields" jsonb NOT NULL,
	"assumptions" jsonb NOT NULL,
	"warnings" jsonb NOT NULL,
	"status" text NOT NULL,
	"model_ver" text NOT NULL,
	"prompt_ver" text NOT NULL,
	"parser_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grant_document_fields" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"source" "grant_source" NOT NULL,
	"source_id" text NOT NULL,
	"document_category" text NOT NULL,
	"document_name" text NOT NULL,
	"source_attachment" text,
	"field_key" text NOT NULL,
	"label" text NOT NULL,
	"section" text,
	"field_type" text NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"source_span" text,
	"mapped_company_field" text,
	"fill_strategy" text NOT NULL,
	"confidence" real NOT NULL,
	"parser_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grant_document_draft_events" ADD CONSTRAINT "grant_document_draft_events_draft_id_grant_document_drafts_id_fk" FOREIGN KEY ("draft_id") REFERENCES "public"."grant_document_drafts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_draft_events" ADD CONSTRAINT "grant_document_draft_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ADD CONSTRAINT "grant_document_drafts_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ADD CONSTRAINT "grant_document_drafts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ADD CONSTRAINT "grant_document_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_fields" ADD CONSTRAINT "grant_document_fields_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "grant_document_draft_events_draft_idx" ON "grant_document_draft_events" USING btree ("draft_id");--> statement-breakpoint
CREATE INDEX "grant_document_draft_events_actor_idx" ON "grant_document_draft_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE INDEX "grant_document_drafts_grant_company_idx" ON "grant_document_drafts" USING btree ("grant_id","company_id");--> statement-breakpoint
CREATE INDEX "grant_document_drafts_company_status_idx" ON "grant_document_drafts" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "grant_document_drafts_user_updated_idx" ON "grant_document_drafts" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "grant_document_drafts_document_key_idx" ON "grant_document_drafts" USING btree ("grant_id","company_id","document_key");--> statement-breakpoint
CREATE INDEX "grant_document_fields_grant_id_idx" ON "grant_document_fields" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "grant_document_fields_source_id_idx" ON "grant_document_fields" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "grant_document_fields_source_attachment_idx" ON "grant_document_fields" USING btree ("source","source_id","source_attachment");--> statement-breakpoint
CREATE INDEX "grant_document_fields_category_idx" ON "grant_document_fields" USING btree ("document_category");--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_drafts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_draft_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "grant_document_draft_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "grant_document_drafts_member_select"
ON "grant_document_drafts"
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "grant_document_drafts"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_drafts_writer_write"
ON "grant_document_drafts"
FOR ALL
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "grant_document_drafts"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  "user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "grant_document_drafts"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_draft_events_member_select"
ON "grant_document_draft_events"
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_draft_events"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "grant_document_draft_events_writer_insert"
ON "grant_document_draft_events"
FOR INSERT
WITH CHECK (
  "actor_user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "grant_document_drafts"
    JOIN "user_company"
      ON "user_company"."company_id" = "grant_document_drafts"."company_id"
    WHERE "grant_document_drafts"."id" = "grant_document_draft_events"."draft_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin', 'member')
  )
);
