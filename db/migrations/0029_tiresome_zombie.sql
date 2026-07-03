CREATE TABLE "field_map_review_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"review_doc_id" uuid NOT NULL,
	"field_index" integer,
	"page" integer,
	"kind" text NOT NULL,
	"prompt" text NOT NULL,
	"answer_type" text NOT NULL,
	"options" jsonb,
	"apply_map" jsonb,
	"order_index" integer NOT NULL,
	"answer" jsonb,
	"answered_by" text,
	"answered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "field_map_review_questions" ADD CONSTRAINT "field_map_review_questions_review_doc_id_field_map_review_docs_id_fk" FOREIGN KEY ("review_doc_id") REFERENCES "public"."field_map_review_docs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "field_map_review_questions_doc_idx" ON "field_map_review_questions" USING btree ("review_doc_id");--> statement-breakpoint
CREATE INDEX "field_map_review_questions_doc_order_idx" ON "field_map_review_questions" USING btree ("review_doc_id","order_index");