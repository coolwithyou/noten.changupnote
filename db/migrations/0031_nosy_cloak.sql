CREATE TABLE "knowledge_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"sha256" text NOT NULL,
	"r2_key" text NOT NULL,
	"extracted_text_key" text,
	"extraction_json_key" text,
	"program_hint" text,
	"institution_hint" text,
	"source_date" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"extraction_model" text,
	"extraction_prompt_ver" text,
	"non_lesson_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "review_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" text NOT NULL,
	"scope" jsonb NOT NULL,
	"instruction" text NOT NULL,
	"rationale" text NOT NULL,
	"source_kind" text NOT NULL,
	"evidence_tier" text NOT NULL,
	"source_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_id" uuid,
	"golden_case_ref" text,
	"program_round" text,
	"valid_from" timestamp with time zone DEFAULT now() NOT NULL,
	"review_by" timestamp with time zone,
	"status" text DEFAULT 'proposed' NOT NULL,
	"lesson_ver" text DEFAULT 'v1' NOT NULL,
	"curated_by" text,
	"curated_at" timestamp with time zone,
	"curation_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_lessons" ADD CONSTRAINT "review_lessons_source_id_knowledge_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."knowledge_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_sources_sha_idx" ON "knowledge_sources" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "knowledge_sources_kind_status_idx" ON "knowledge_sources" USING btree ("kind","status");--> statement-breakpoint
CREATE INDEX "review_lessons_status_idx" ON "review_lessons" USING btree ("status");--> statement-breakpoint
CREATE INDEX "review_lessons_status_target_idx" ON "review_lessons" USING btree ("status","target");--> statement-breakpoint
CREATE INDEX "review_lessons_source_idx" ON "review_lessons" USING btree ("source_id");