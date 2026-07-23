ALTER TYPE "public"."admin_role" ADD VALUE IF NOT EXISTS 'reviewer';
--> statement-breakpoint
CREATE TABLE "audit_dispatch_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"week" text NOT NULL,
	"seed" integer NOT NULL,
	"reviewer_ids" uuid[] NOT NULL,
	"overlap_ratio" real NOT NULL,
	"guide_sha256" text NOT NULL,
	"dispatched_by" text NOT NULL,
	"item_count" integer NOT NULL,
	"notice_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_dispatch_batches_overlap_ratio_range" CHECK (
    "audit_dispatch_batches"."overlap_ratio" >= 0 AND "audit_dispatch_batches"."overlap_ratio" <= 1
  ),
	CONSTRAINT "audit_dispatch_batches_nonnegative_counts" CHECK (
    "audit_dispatch_batches"."item_count" >= 0 AND "audit_dispatch_batches"."notice_count" >= 0
  )
);
--> statement-breakpoint
CREATE TABLE "audit_dispatch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notice_id" uuid NOT NULL,
	"source_item_key" text NOT NULL,
	"collect_target" text NOT NULL,
	"item_kind" text NOT NULL,
	"criterion_index" integer,
	"dimension" text,
	"payload" jsonb NOT NULL,
	"payload_sha256" text NOT NULL,
	"assignee_id" uuid NOT NULL,
	"assignee_email" text NOT NULL,
	"overlap_group" uuid,
	"blind" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"human_verdict" text,
	"note" text,
	"decided_at" timestamp with time zone,
	"final_verdict" text,
	"finalized_by" uuid,
	"resolved_at" timestamp with time zone,
	"revision" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"collected_at" timestamp with time zone,
	"collect_receipt" jsonb,
	CONSTRAINT "audit_dispatch_items_collect_target_check" CHECK (
    "audit_dispatch_items"."collect_target" IN ('audit_file', 'overlay')
  ),
	CONSTRAINT "audit_dispatch_items_item_kind_check" CHECK (
    "audit_dispatch_items"."item_kind" IN ('criterion', 'axis', 'question_check')
  ),
	CONSTRAINT "audit_dispatch_items_status_check" CHECK (
    "audit_dispatch_items"."status" IN ('pending', 'decided', 'conflict', 'resolved', 'collected')
  ),
	CONSTRAINT "audit_dispatch_items_decided_verdict_check" CHECK (
    "audit_dispatch_items"."status" <> 'decided' OR "audit_dispatch_items"."human_verdict" IS NOT NULL
  ),
	CONSTRAINT "audit_dispatch_items_resolved_verdict_check" CHECK (
    "audit_dispatch_items"."status" <> 'resolved' OR "audit_dispatch_items"."final_verdict" IS NOT NULL
  ),
	CONSTRAINT "audit_dispatch_items_nonnegative_revision" CHECK (
    "audit_dispatch_items"."revision" >= 0
  )
);
--> statement-breakpoint
CREATE TABLE "audit_dispatch_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"source" text NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"input_text" text,
	"input_sha256" text NOT NULL,
	"analysis_markdown" text,
	"review_model" text,
	"audit_schema" text NOT NULL,
	"audit_file_sha256" text NOT NULL,
	"ai_review_model" text,
	"ai_review_prompt_ver" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD COLUMN "criterion_stable_key" text;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD COLUMN "invalidation_reason" text;--> statement-breakpoint
ALTER TABLE "grant_criteria" ADD COLUMN "stable_key" text;--> statement-breakpoint
ALTER TABLE "audit_dispatch_items" ADD CONSTRAINT "audit_dispatch_items_notice_id_audit_dispatch_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."audit_dispatch_notices"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_dispatch_items" ADD CONSTRAINT "audit_dispatch_items_assignee_id_admin_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_dispatch_items" ADD CONSTRAINT "audit_dispatch_items_finalized_by_admin_users_id_fk" FOREIGN KEY ("finalized_by") REFERENCES "public"."admin_users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_dispatch_notices" ADD CONSTRAINT "audit_dispatch_notices_batch_id_audit_dispatch_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."audit_dispatch_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_dispatch_notices" ADD CONSTRAINT "audit_dispatch_notices_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "audit_dispatch_batches_week_idx" ON "audit_dispatch_batches" USING btree ("week");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_dispatch_items_assignment_idx" ON "audit_dispatch_items" USING btree ("notice_id","source_item_key","assignee_id");--> statement-breakpoint
CREATE INDEX "audit_dispatch_items_assignee_status_idx" ON "audit_dispatch_items" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE INDEX "audit_dispatch_items_notice_id_idx" ON "audit_dispatch_items" USING btree ("notice_id");--> statement-breakpoint
CREATE INDEX "audit_dispatch_items_finalized_by_idx" ON "audit_dispatch_items" USING btree ("finalized_by");--> statement-breakpoint
CREATE INDEX "audit_dispatch_items_overlap_group_idx" ON "audit_dispatch_items" USING btree ("overlap_group");--> statement-breakpoint
CREATE UNIQUE INDEX "audit_dispatch_notices_batch_run_idx" ON "audit_dispatch_notices" USING btree ("batch_id","run_id");--> statement-breakpoint
CREATE INDEX "audit_dispatch_notices_batch_id_idx" ON "audit_dispatch_notices" USING btree ("batch_id");--> statement-breakpoint
CREATE INDEX "audit_dispatch_notices_grant_id_idx" ON "audit_dispatch_notices" USING btree ("grant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_confirmation_questions_grant_stable_key_idx" ON "grant_confirmation_questions" USING btree ("grant_id","criterion_stable_key");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_criteria_grant_stable_key_idx" ON "grant_criteria" USING btree ("grant_id","stable_key");
