ALTER TYPE "company_role" ADD VALUE IF NOT EXISTS 'admin' BEFORE 'member';--> statement-breakpoint
DROP POLICY IF EXISTS "companies_writer_update" ON "companies";--> statement-breakpoint
CREATE POLICY "companies_writer_update"
ON "companies"
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "companies"."id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role"::text IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "companies"."id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role"::text IN ('owner', 'admin', 'member')
  )
);
--> statement-breakpoint
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
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "company_profiles"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role"::text IN ('owner', 'admin', 'member')
  )
);
--> statement-breakpoint
DROP POLICY IF EXISTS "consents_self_write" ON "consents";--> statement-breakpoint
CREATE POLICY "consents_self_write"
ON "consents"
FOR ALL
USING (
  "user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "consents"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role"::text IN ('owner', 'admin', 'member')
  )
)
WITH CHECK (
  "user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "consents"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role"::text IN ('owner', 'admin', 'member')
  )
);
