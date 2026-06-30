CREATE TABLE "team_role_change_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"target_user_id" uuid,
	"actor_user_id" uuid,
	"previous_role" "company_role" NOT NULL,
	"next_role" "company_role" NOT NULL,
	"target_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actor_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text DEFAULT 'team_management' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_role_change_events" ADD CONSTRAINT "team_role_change_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_role_change_events" ADD CONSTRAINT "team_role_change_events_target_user_id_users_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_role_change_events" ADD CONSTRAINT "team_role_change_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "team_role_change_events_company_created_at_idx" ON "team_role_change_events" USING btree ("company_id","created_at");--> statement-breakpoint
CREATE INDEX "team_role_change_events_target_user_idx" ON "team_role_change_events" USING btree ("target_user_id");--> statement-breakpoint
CREATE INDEX "team_role_change_events_actor_user_idx" ON "team_role_change_events" USING btree ("actor_user_id");--> statement-breakpoint
ALTER TABLE "team_role_change_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_role_change_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "team_role_change_events_admin_select"
ON "team_role_change_events"
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "team_role_change_events"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin')
  )
  OR EXISTS (
    SELECT 1
    FROM "companies"
    WHERE "companies"."id" = "team_role_change_events"."company_id"
      AND "companies"."created_by" = "app_private"."current_user_id"()
  )
);
--> statement-breakpoint
CREATE POLICY "team_role_change_events_admin_insert"
ON "team_role_change_events"
FOR INSERT
WITH CHECK (
  "actor_user_id" = "app_private"."current_user_id"()
  AND (
    EXISTS (
      SELECT 1
      FROM "user_company"
      WHERE "user_company"."company_id" = "team_role_change_events"."company_id"
        AND "user_company"."user_id" = "app_private"."current_user_id"()
        AND "user_company"."role" IN ('owner', 'admin')
    )
    OR EXISTS (
      SELECT 1
      FROM "companies"
      WHERE "companies"."id" = "team_role_change_events"."company_id"
        AND "companies"."created_by" = "app_private"."current_user_id"()
    )
  )
);
