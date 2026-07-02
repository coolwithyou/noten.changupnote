CREATE TYPE "public"."review_status" AS ENUM('pending', 'in_review', 'approved');--> statement-breakpoint
CREATE TABLE "field_map_review_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"doc_ref" text NOT NULL,
	"doc_id" text NOT NULL,
	"source_filename" text,
	"page_count" integer,
	"label_json" jsonb NOT NULL,
	"labeled_by" text,
	"labeled_at" text,
	"review_status" "review_status" DEFAULT 'pending' NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"correction_notes" text,
	"page_image_keys" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "field_map_review_docs_doc_ref_idx" ON "field_map_review_docs" USING btree ("doc_ref");--> statement-breakpoint
CREATE INDEX "field_map_review_docs_status_idx" ON "field_map_review_docs" USING btree ("review_status");