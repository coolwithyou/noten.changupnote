CREATE TYPE "public"."grant_serving_state" AS ENUM('visible', 'staged', 'suppressed');--> statement-breakpoint
ALTER TABLE "grants" ADD COLUMN "serving_state" "grant_serving_state" DEFAULT 'visible' NOT NULL;--> statement-breakpoint
CREATE INDEX "grants_serving_status_apply_end_idx" ON "grants" USING btree ("serving_state","status","apply_end");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "cunote_active_deep_analysis_grants"("as_of" timestamptz)
RETURNS TABLE("grant_id" uuid)
LANGUAGE sql
STABLE
AS $$
  SELECT g.id
  FROM grants g
  WHERE g.serving_state = 'visible'
    AND g.status = 'open'
    AND g.apply_end IS NOT NULL
    AND timezone('Asia/Seoul', g.apply_end)::date
      >= timezone('Asia/Seoul', as_of)::date
    AND (
      g.apply_start IS NULL
      OR timezone('Asia/Seoul', g.apply_start)::date
        <= timezone('Asia/Seoul', as_of)::date
    )
$$;
