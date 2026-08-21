CREATE TABLE "company_application_profiles" (
	"company_id" uuid PRIMARY KEY NOT NULL,
	"representative_name" text,
	"application_email" text,
	"phone" text,
	"postal_code" text,
	"address_line1" text,
	"address_line2" text,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_application_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"full_name" text,
	"application_email" text,
	"phone" text,
	"postal_code" text,
	"address_line1" text,
	"address_line2" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_application_profiles" ADD CONSTRAINT "company_application_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_application_profiles" ADD CONSTRAINT "company_application_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_application_profiles" ADD CONSTRAINT "user_application_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_application_profiles_updated_by_idx" ON "company_application_profiles" USING btree ("updated_by");--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app_private"."is_current_company_member"("target_company_id" uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "public"."user_company"
    WHERE "user_company"."company_id" = "target_company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  );
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app_private"."can_current_user_write_company"("target_company_id" uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "public"."user_company"
    WHERE "user_company"."company_id" = "target_company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role"::text IN ('owner', 'admin', 'member')
  );
$$;--> statement-breakpoint
DROP POLICY IF EXISTS "companies_member_select" ON "companies";--> statement-breakpoint
CREATE POLICY "companies_member_select"
ON "companies"
FOR SELECT
USING (
  "created_by" = "app_private"."current_user_id"()
  OR "app_private"."is_current_company_member"("id")
);--> statement-breakpoint
DROP POLICY IF EXISTS "companies_writer_update" ON "companies";--> statement-breakpoint
CREATE POLICY "companies_writer_update"
ON "companies"
FOR UPDATE
USING ("app_private"."can_current_user_write_company"("id"))
WITH CHECK ("app_private"."can_current_user_write_company"("id"));--> statement-breakpoint
ALTER TABLE "user_application_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_application_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_application_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_application_profiles" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_application_profiles_self"
ON "user_application_profiles"
FOR ALL
USING ("user_id" = "app_private"."current_user_id"())
WITH CHECK ("user_id" = "app_private"."current_user_id"());--> statement-breakpoint
CREATE POLICY "company_application_profiles_member_select"
ON "company_application_profiles"
FOR SELECT
USING ("app_private"."is_current_company_member"("company_id"));--> statement-breakpoint
CREATE POLICY "company_application_profiles_writer_write"
ON "company_application_profiles"
FOR ALL
USING ("app_private"."can_current_user_write_company"("company_id"))
WITH CHECK (
  "updated_by" = "app_private"."current_user_id"()
  AND "app_private"."can_current_user_write_company"("company_id")
);
