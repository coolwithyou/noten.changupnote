CREATE SCHEMA IF NOT EXISTS "app_private";--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app_private"."current_user_id"()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(current_setting('app.current_user_id', true), '')::uuid;
$$;
--> statement-breakpoint
ALTER TABLE "companies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "companies" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_company" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_company" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consents" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "consents" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_refresh_tokens" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_refresh_tokens" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_devices" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "app_devices" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "match_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "match_state" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "match_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "match_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "companies_member_select"
ON "companies"
FOR SELECT
USING (
  "created_by" = "app_private"."current_user_id"()
  OR EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "companies"."id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);
--> statement-breakpoint
CREATE POLICY "companies_creator_insert"
ON "companies"
FOR INSERT
WITH CHECK ("created_by" = "app_private"."current_user_id"());
--> statement-breakpoint
CREATE POLICY "companies_writer_update"
ON "companies"
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "companies"."id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'member')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "companies"."id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'member')
  )
);
--> statement-breakpoint
CREATE POLICY "user_company_self_select"
ON "user_company"
FOR SELECT
USING ("user_id" = "app_private"."current_user_id"());
--> statement-breakpoint
CREATE POLICY "user_company_creator_insert"
ON "user_company"
FOR INSERT
WITH CHECK (
  "user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "companies"
    WHERE "companies"."id" = "user_company"."company_id"
      AND "companies"."created_by" = "app_private"."current_user_id"()
  )
);
--> statement-breakpoint
CREATE POLICY "user_company_self_update"
ON "user_company"
FOR UPDATE
USING ("user_id" = "app_private"."current_user_id"())
WITH CHECK ("user_id" = "app_private"."current_user_id"());
--> statement-breakpoint
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
);
--> statement-breakpoint
CREATE POLICY "company_profiles_writer_write"
ON "company_profiles"
FOR ALL
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "company_profiles"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'member')
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "company_profiles"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'member')
  )
);
--> statement-breakpoint
CREATE POLICY "consents_self_select"
ON "consents"
FOR SELECT
USING (
  "user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "consents"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);
--> statement-breakpoint
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
      AND "user_company"."role" IN ('owner', 'member')
  )
)
WITH CHECK (
  "user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "consents"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'member')
  )
);
--> statement-breakpoint
CREATE POLICY "app_refresh_tokens_self"
ON "app_refresh_tokens"
FOR ALL
USING ("user_id" = "app_private"."current_user_id"())
WITH CHECK ("user_id" = "app_private"."current_user_id"());
--> statement-breakpoint
CREATE POLICY "app_devices_self"
ON "app_devices"
FOR ALL
USING ("user_id" = "app_private"."current_user_id"())
WITH CHECK ("user_id" = "app_private"."current_user_id"());
--> statement-breakpoint
CREATE POLICY "notification_settings_self"
ON "notification_settings"
FOR ALL
USING ("user_id" = "app_private"."current_user_id"())
WITH CHECK ("user_id" = "app_private"."current_user_id"());
--> statement-breakpoint
CREATE POLICY "match_state_member"
ON "match_state"
FOR ALL
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "match_state"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "match_state"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);
--> statement-breakpoint
CREATE POLICY "match_events_member"
ON "match_events"
FOR ALL
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "match_events"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "match_events"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);
