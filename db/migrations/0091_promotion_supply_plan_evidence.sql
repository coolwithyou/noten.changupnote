ALTER TABLE "analysis_lab_promotion_items"
  ADD COLUMN "supply_plan_evidence_sha256" text;
--> statement-breakpoint
ALTER TABLE "analysis_lab_promotion_items"
  ADD CONSTRAINT "analysis_lab_promotion_items_supply_plan_evidence_sha256_check"
  CHECK ("supply_plan_evidence_sha256" IS NULL OR "supply_plan_evidence_sha256" ~ '^[0-9a-f]{64}$');
