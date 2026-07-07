ALTER TABLE "grants" ADD COLUMN "f_authoring_mode" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE INDEX "grants_f_authoring_mode_idx" ON "grants" USING btree ("f_authoring_mode");