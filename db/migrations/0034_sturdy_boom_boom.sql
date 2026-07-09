ALTER TABLE "company_profiles" ADD COLUMN "user_id" uuid;--> statement-breakpoint
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
UPDATE "company_profiles"
SET "user_id" = "companies"."created_by"
FROM "companies"
WHERE "company_profiles"."company_id" = "companies"."id"
  AND "company_profiles"."source" = 'self_declared'
  AND "company_profiles"."user_id" IS NULL
  AND "companies"."created_by" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "company_profiles_company_user_dimension_idx" ON "company_profiles" USING btree ("company_id","user_id","dimension");--> statement-breakpoint
DROP POLICY IF EXISTS "company_profiles_member_select" ON "company_profiles";--> statement-breakpoint
CREATE POLICY "company_profiles_member_select"
ON "company_profiles"
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "company_profiles"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
  AND (
    "company_profiles"."user_id" IS NULL
    OR "company_profiles"."user_id" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
DROP POLICY IF EXISTS "company_profiles_writer_write" ON "company_profiles";--> statement-breakpoint
CREATE POLICY "company_profiles_writer_write"
ON "company_profiles"
FOR ALL
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "company_profiles"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role"::text IN ('owner', 'admin', 'member')
  )
  AND "company_profiles"."user_id" = "app_private"."current_user_id"()
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "company_profiles"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role"::text IN ('owner', 'admin', 'member')
  )
  AND "company_profiles"."user_id" = "app_private"."current_user_id"()
);
