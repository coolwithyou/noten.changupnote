ALTER TABLE "grants" ADD COLUMN "benefits" jsonb;
CREATE INDEX "grants_source_status_idx" ON "grants" USING btree ("source","status");--> statement-breakpoint
CREATE INDEX "grants_apply_end_idx" ON "grants" USING btree ("apply_end");--> statement-breakpoint
CREATE INDEX "grants_updated_at_idx" ON "grants" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "grants_benefits_idx" ON "grants" USING gin ("benefits");--> statement-breakpoint
CREATE INDEX "grant_criteria_dimension_grant_idx" ON "grant_criteria" USING btree ("dimension","grant_id");--> statement-breakpoint
CREATE INDEX "grant_criteria_operator_grant_idx" ON "grant_criteria" USING btree ("operator","grant_id");
