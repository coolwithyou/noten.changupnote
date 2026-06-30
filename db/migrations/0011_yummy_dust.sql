CREATE TYPE "public"."team_invitation_status" AS ENUM('pending', 'accepted', 'revoked', 'expired');--> statement-breakpoint
CREATE TABLE "team_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" "company_role" NOT NULL,
	"token_hash" text NOT NULL,
	"status" "team_invitation_status" DEFAULT 'pending' NOT NULL,
	"invited_by" uuid,
	"accepted_by" uuid,
	"accepted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_accepted_by_users_id_fk" FOREIGN KEY ("accepted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "team_invitations_token_hash_idx" ON "team_invitations" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "team_invitations_company_status_idx" ON "team_invitations" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "team_invitations_email_status_idx" ON "team_invitations" USING btree ("email","status");--> statement-breakpoint
CREATE INDEX "team_invitations_expires_at_idx" ON "team_invitations" USING btree ("expires_at");--> statement-breakpoint
ALTER TABLE "team_invitations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "team_invitations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_company_company_creator_select"
ON "user_company"
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM "companies"
    WHERE "companies"."id" = "user_company"."company_id"
      AND "companies"."created_by" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "user_company_company_creator_update"
ON "user_company"
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM "companies"
    WHERE "companies"."id" = "user_company"."company_id"
      AND "companies"."created_by" = "app_private"."current_user_id"()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "companies"
    WHERE "companies"."id" = "user_company"."company_id"
      AND "companies"."created_by" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "user_company_invitation_insert"
ON "user_company"
FOR INSERT
WITH CHECK (
  "user_id" = "app_private"."current_user_id"()
  AND "role" <> 'owner'::"company_role"
  AND EXISTS (
    SELECT 1
    FROM "team_invitations"
    JOIN "users"
      ON "users"."id" = "app_private"."current_user_id"()
    WHERE "team_invitations"."company_id" = "user_company"."company_id"
      AND lower("team_invitations"."email") = lower("users"."email")
      AND "team_invitations"."status" = 'pending'::"team_invitation_status"
      AND "team_invitations"."expires_at" > now()
      AND "team_invitations"."role" = "user_company"."role"
  )
);--> statement-breakpoint
CREATE POLICY "team_invitations_admin_select"
ON "team_invitations"
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "team_invitations"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin')
  )
  OR EXISTS (
    SELECT 1
    FROM "companies"
    WHERE "companies"."id" = "team_invitations"."company_id"
      AND "companies"."created_by" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "team_invitations_invitee_select"
ON "team_invitations"
FOR SELECT
USING (
  "status" = 'pending'::"team_invitation_status"
  AND EXISTS (
    SELECT 1
    FROM "users"
    WHERE "users"."id" = "app_private"."current_user_id"()
      AND lower("users"."email") = lower("team_invitations"."email")
  )
);--> statement-breakpoint
CREATE POLICY "team_invitations_admin_insert"
ON "team_invitations"
FOR INSERT
WITH CHECK (
  "role" <> 'owner'::"company_role"
  AND "invited_by" = "app_private"."current_user_id"()
  AND (
    EXISTS (
      SELECT 1
      FROM "user_company"
      WHERE "user_company"."company_id" = "team_invitations"."company_id"
        AND "user_company"."user_id" = "app_private"."current_user_id"()
        AND "user_company"."role" IN ('owner', 'admin')
    )
    OR EXISTS (
      SELECT 1
      FROM "companies"
      WHERE "companies"."id" = "team_invitations"."company_id"
        AND "companies"."created_by" = "app_private"."current_user_id"()
    )
  )
);--> statement-breakpoint
CREATE POLICY "team_invitations_admin_update"
ON "team_invitations"
FOR UPDATE
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "team_invitations"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin')
  )
  OR EXISTS (
    SELECT 1
    FROM "companies"
    WHERE "companies"."id" = "team_invitations"."company_id"
      AND "companies"."created_by" = "app_private"."current_user_id"()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "team_invitations"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
      AND "user_company"."role" IN ('owner', 'admin')
  )
  OR EXISTS (
    SELECT 1
    FROM "companies"
    WHERE "companies"."id" = "team_invitations"."company_id"
      AND "companies"."created_by" = "app_private"."current_user_id"()
  )
);--> statement-breakpoint
CREATE POLICY "team_invitations_invitee_update"
ON "team_invitations"
FOR UPDATE
USING (
  "status" = 'pending'::"team_invitation_status"
  AND EXISTS (
    SELECT 1
    FROM "users"
    WHERE "users"."id" = "app_private"."current_user_id"()
      AND lower("users"."email") = lower("team_invitations"."email")
  )
)
WITH CHECK (
  "accepted_by" = "app_private"."current_user_id"()
  AND "status" IN ('accepted'::"team_invitation_status", 'expired'::"team_invitation_status")
);
