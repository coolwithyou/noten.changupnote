CREATE TABLE "analysis_lab_application_field_repairs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"release_db_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"parent_promotion_item_id" uuid NOT NULL,
	"roundtrip_run_id" text NOT NULL,
	"application_field_analysis_version" text NOT NULL,
	"plan_sha256" text NOT NULL,
	"before_snapshot" jsonb NOT NULL,
	"before_sha256" text NOT NULL,
	"after_snapshot" jsonb,
	"after_sha256" text,
	"serving_state_sha256" text,
	"application_precompute_receipt" jsonb,
	"status" text DEFAULT 'prepared' NOT NULL,
	"error" text,
	"applied_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "analysis_lab_application_field_repairs_status_check" CHECK (
		"analysis_lab_application_field_repairs"."status" IN (
			'prepared', 'applying', 'applied', 'failed'
		)
	)
);
--> statement-breakpoint
ALTER TABLE "analysis_lab_application_field_repairs" ADD CONSTRAINT "analysis_lab_application_field_repairs_release_db_id_fk" FOREIGN KEY ("release_db_id") REFERENCES "public"."analysis_lab_promotion_releases"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analysis_lab_application_field_repairs" ADD CONSTRAINT "analysis_lab_application_field_repairs_grant_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "analysis_lab_application_field_repairs" ADD CONSTRAINT "analysis_lab_application_field_repairs_parent_promotion_item_id_fk" FOREIGN KEY ("parent_promotion_item_id") REFERENCES "public"."analysis_lab_promotion_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_lab_application_field_repairs_release_idx" ON "analysis_lab_application_field_repairs" USING btree ("release_db_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "analysis_lab_application_field_repairs_parent_idx" ON "analysis_lab_application_field_repairs" USING btree ("parent_promotion_item_id");
--> statement-breakpoint
CREATE INDEX "analysis_lab_application_field_repairs_grant_idx" ON "analysis_lab_application_field_repairs" USING btree ("grant_id");
--> statement-breakpoint
ALTER TABLE "analysis_lab_application_field_repairs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "analysis_lab_application_field_repairs" FORCE ROW LEVEL SECURITY;
