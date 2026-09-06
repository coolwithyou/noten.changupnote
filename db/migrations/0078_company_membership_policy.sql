-- user_company INSERT -> team_invitations SELECT -> user_company SELECT의
-- 순환 참조를 현재 사용자만 판정하는 기존 SECURITY DEFINER 방식으로 끊는다.
CREATE OR REPLACE FUNCTION "app_private"."has_current_company_invitation"("target_company_id" uuid, "target_role" "public"."company_role")
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."team_invitations" AS invitation
    JOIN "public"."users" AS actor ON actor.id = "app_private"."current_user_id"()
    WHERE invitation.company_id = target_company_id
      AND lower(invitation.email) = lower(actor.email)
      AND invitation.status = 'pending'::"public"."team_invitation_status"
      AND invitation.expires_at > now()
      AND invitation.role = target_role
      AND target_role <> 'owner'::"public"."company_role"
  );
$$;--> statement-breakpoint
DROP POLICY "user_company_invitation_insert" ON "user_company";--> statement-breakpoint
CREATE POLICY "user_company_invitation_insert" ON "user_company" FOR INSERT
WITH CHECK (
  "user_id" = "app_private"."current_user_id"()
  AND "app_private"."has_current_company_invitation"("company_id", "role")
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "app_private"."can_current_user_manage_company"("target_company_id" uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM "public"."user_company" AS membership
    WHERE membership.company_id = target_company_id
      AND membership.user_id = "app_private"."current_user_id"()
      AND membership.role IN ('owner', 'admin')
  );
$$;--> statement-breakpoint
-- 과거 self UPDATE는 viewer -> owner 자기 승격을 허용했다.
-- 현재 teamManagement의 자기 역할 변경 금지·owner 잠금 계약을 DB에도 적용한다.
DROP POLICY "user_company_self_update" ON "user_company";--> statement-breakpoint
DROP POLICY "user_company_company_creator_update" ON "user_company";--> statement-breakpoint
DROP POLICY "user_company_company_creator_select" ON "user_company";--> statement-breakpoint
CREATE POLICY "user_company_manager_select" ON "user_company" FOR SELECT
USING ("app_private"."can_current_user_manage_company"("company_id"));--> statement-breakpoint
CREATE POLICY "user_company_manager_update" ON "user_company" FOR UPDATE
USING (
  "app_private"."can_current_user_manage_company"("company_id")
  AND "user_id" <> "app_private"."current_user_id"()
  AND "role" <> 'owner'
)
WITH CHECK (
  "app_private"."can_current_user_manage_company"("company_id")
  AND "user_id" <> "app_private"."current_user_id"()
  AND "role" <> 'owner'
);
