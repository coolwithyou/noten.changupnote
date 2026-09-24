CREATE TABLE "analysis_lab_source_rebind_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_db_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"parent_promotion_item_id" uuid NOT NULL,
	"impact_sha256" text NOT NULL,
	"previous_source_revision_sha256" text NOT NULL,
	"previous_source_raw_sha256" text NOT NULL,
	"current_source_revision_sha256" text NOT NULL,
	"current_source_raw_sha256" text NOT NULL,
	"current_material_source_revision_sha256" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"before_sha256" text NOT NULL,
	"before_serving_sha256" text NOT NULL,
	"after_snapshot" jsonb,
	"after_sha256" text,
	"serving_state_sha256" text,
	"rebound_question_count" integer,
	"rebound_answer_count" integer,
	"status" text DEFAULT 'prepared' NOT NULL,
	"error" text,
	"applied_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_lab_source_rebind_status_check" CHECK (
		"analysis_lab_source_rebind_items"."status" IN ('prepared', 'applying', 'applied', 'failed')
	)
);
--> statement-breakpoint
ALTER TABLE "analysis_lab_source_rebind_items" ADD CONSTRAINT "analysis_lab_source_rebind_release_db_id_fk" FOREIGN KEY ("release_db_id") REFERENCES "public"."analysis_lab_promotion_releases"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analysis_lab_source_rebind_items" ADD CONSTRAINT "analysis_lab_source_rebind_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analysis_lab_source_rebind_items" ADD CONSTRAINT "analysis_lab_source_rebind_parent_item_fk" FOREIGN KEY ("parent_promotion_item_id") REFERENCES "public"."analysis_lab_promotion_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_lab_source_rebind_release_idx" ON "analysis_lab_source_rebind_items" USING btree ("release_db_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_lab_source_rebind_parent_previous_idx" ON "analysis_lab_source_rebind_items" USING btree ("parent_promotion_item_id", "previous_source_revision_sha256") WHERE "status" IN ('prepared', 'applying', 'applied');
--> statement-breakpoint
CREATE INDEX "analysis_lab_source_rebind_parent_idx" ON "analysis_lab_source_rebind_items" USING btree ("parent_promotion_item_id");
--> statement-breakpoint
CREATE INDEX "analysis_lab_source_rebind_grant_idx" ON "analysis_lab_source_rebind_items" USING btree ("grant_id");
--> statement-breakpoint
ALTER TABLE "analysis_lab_source_rebind_items" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "analysis_lab_source_rebind_items" FORCE ROW LEVEL SECURITY;
