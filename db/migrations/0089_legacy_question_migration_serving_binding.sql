ALTER TABLE "analysis_lab_legacy_question_migration_items" ADD COLUMN "parent_promotion_item_id" uuid;
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" ADD COLUMN "before_serving_sha256" text;
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" ADD COLUMN "serving_state_sha256" text;
--> statement-breakpoint
ALTER TABLE "analysis_lab_legacy_question_migration_items" ADD CONSTRAINT "analysis_lab_legacy_question_migration_parent_item_fk" FOREIGN KEY ("parent_promotion_item_id") REFERENCES "public"."analysis_lab_promotion_items"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "analysis_lab_legacy_question_migration_parent_idx" ON "analysis_lab_legacy_question_migration_items" USING btree ("parent_promotion_item_id");
