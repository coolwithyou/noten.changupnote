CREATE TABLE "company_discovery_selections" (
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"restored" boolean NOT NULL,
	"revision" integer NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_discovery_selections_company_id_grant_id_pk" PRIMARY KEY("company_id","grant_id"),
	CONSTRAINT "company_discovery_selections_revision_check" CHECK ("company_discovery_selections"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "company_discovery_selections" ADD CONSTRAINT "company_discovery_selections_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_discovery_selections" ADD CONSTRAINT "company_discovery_selections_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_discovery_selections" ADD CONSTRAINT "company_discovery_selections_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_discovery_selections_grant_idx" ON "company_discovery_selections" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "company_discovery_selections_updater_idx" ON "company_discovery_selections" USING btree ("updated_by");
--> statement-breakpoint
ALTER TABLE company_discovery_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE company_discovery_selections FORCE ROW LEVEL SECURITY;
CREATE POLICY discovery_selections_read ON company_discovery_selections FOR SELECT
USING (app_private.is_current_company_member(company_id));
CREATE POLICY discovery_selections_insert ON company_discovery_selections FOR INSERT
WITH CHECK (app_private.can_current_user_write_company(company_id) AND updated_by = app_private.current_user_id());
CREATE POLICY discovery_selections_update ON company_discovery_selections FOR UPDATE
USING (app_private.can_current_user_write_company(company_id))
WITH CHECK (app_private.can_current_user_write_company(company_id) AND updated_by = app_private.current_user_id());
