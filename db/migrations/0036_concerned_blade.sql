ALTER TABLE "grants" ADD COLUMN "agency_primary" text;--> statement-breakpoint
CREATE INDEX "grants_agency_primary_idx" ON "grants" USING btree ("agency_primary");