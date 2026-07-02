-- Phase 1: Application Surface / Artifact 모델
-- 설계: docs/public-support-application-guide-master-architecture.md 7.3, 7.4, 7.7, 11장
-- 주의: drizzle-kit generate 결과에서 이미 DB에 존재하는 객체(0018~0024에서 수동 작성된
-- billing/admin/support 테이블, grants.benefits 등)를 제거하고 신규 객체만 남긴 파일이다.
-- 0025 스냅샷(meta/0025_snapshot.json)은 전체 스키마 기준으로 갱신되어 이후 generate 드리프트가 해소된다.

CREATE TABLE "form_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"structure_hash" text NOT NULL,
	"canonical_surface_id" uuid,
	"verified_field_map_version" text,
	"usage_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grant_application_surfaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"template_id" uuid,
	"source" "grant_source" NOT NULL,
	"source_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"format" text NOT NULL,
	"source_url" text,
	"source_attachment" text,
	"extraction_status" text DEFAULT 'pending' NOT NULL,
	"extraction_version" text,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_artifacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"surface_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"page" integer,
	"storage_key" text NOT NULL,
	"url" text,
	"content_type" text,
	"sha256" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ADD COLUMN "surface_id" uuid;--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ADD COLUMN "draft_plan" jsonb;--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ADD COLUMN "evidence_refs" jsonb;--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ADD COLUMN "llm_cost" jsonb;--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ADD COLUMN "review_state" text DEFAULT 'user_review_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_document_fields" ADD COLUMN "surface_id" uuid;--> statement-breakpoint
ALTER TABLE "grant_document_fields" ADD COLUMN "position" jsonb;--> statement-breakpoint
ALTER TABLE "grant_document_fields" ADD COLUMN "visual_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "grant_document_fields" ADD COLUMN "text_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "grant_document_fields" ADD COLUMN "review_required" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_application_surfaces" ADD CONSTRAINT "grant_application_surfaces_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_application_surfaces" ADD CONSTRAINT "grant_application_surfaces_template_id_form_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."form_templates"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_artifacts" ADD CONSTRAINT "document_artifacts_surface_id_grant_application_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."grant_application_surfaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_drafts" ADD CONSTRAINT "grant_document_drafts_surface_id_grant_application_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."grant_application_surfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_document_fields" ADD CONSTRAINT "grant_document_fields_surface_id_grant_application_surfaces_id_fk" FOREIGN KEY ("surface_id") REFERENCES "public"."grant_application_surfaces"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "form_templates_structure_hash_idx" ON "form_templates" USING btree ("structure_hash");--> statement-breakpoint
CREATE INDEX "grant_application_surfaces_grant_idx" ON "grant_application_surfaces" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "grant_application_surfaces_template_idx" ON "grant_application_surfaces" USING btree ("template_id");--> statement-breakpoint
CREATE INDEX "grant_application_surfaces_source_id_idx" ON "grant_application_surfaces" USING btree ("source","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_application_surfaces_source_attachment_idx" ON "grant_application_surfaces" USING btree ("source","source_id","type","source_attachment","source_url");--> statement-breakpoint
CREATE INDEX "grant_application_surfaces_status_idx" ON "grant_application_surfaces" USING btree ("extraction_status");--> statement-breakpoint
CREATE INDEX "document_artifacts_surface_kind_idx" ON "document_artifacts" USING btree ("surface_id","kind","page");--> statement-breakpoint
CREATE INDEX "document_artifacts_sha_idx" ON "document_artifacts" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "grant_document_drafts_surface_idx" ON "grant_document_drafts" USING btree ("surface_id");--> statement-breakpoint
CREATE INDEX "grant_document_fields_surface_idx" ON "grant_document_fields" USING btree ("surface_id");
