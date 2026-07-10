CREATE TYPE "public"."credit_actor_type" AS ENUM('user', 'admin', 'system');--> statement-breakpoint
CREATE TYPE "public"."credit_hold_status" AS ENUM('pending', 'captured', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."credit_ledger_entry_type" AS ENUM('signup_bonus_grant', 'purchase_grant', 'plan_grant', 'admin_grant', 'promo_grant', 'usage_capture', 'refund_deduct', 'expiry', 'admin_deduct', 'reversal');--> statement-breakpoint
CREATE TYPE "public"."credit_lot_source" AS ENUM('signup_bonus', 'purchase', 'plan_grant', 'admin_grant', 'promo');--> statement-breakpoint
CREATE TYPE "public"."credit_lot_status" AS ENUM('active', 'exhausted', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."credit_order_status" AS ENUM('created', 'pending', 'paid', 'failed', 'expired', 'refunded', 'partial_refunded');--> statement-breakpoint
CREATE TYPE "public"."credit_plan_sub_status" AS ENUM('incomplete', 'active', 'past_due', 'canceled', 'expired');--> statement-breakpoint
CREATE TYPE "public"."usage_event_status" AS ENUM('pending', 'settled', 'failed', 'free');--> statement-breakpoint
CREATE TABLE "credit_audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_type" "credit_actor_type" NOT NULL,
	"actor_id" text,
	"actor_email" text,
	"actor_role" text,
	"target_type" text NOT NULL,
	"target_id" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"ip_address" text,
	"user_agent" text,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"usage_event_id" uuid NOT NULL,
	"held_credits" bigint NOT NULL,
	"captured_credits" bigint,
	"status" "credit_hold_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"released_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"entry_type" "credit_ledger_entry_type" NOT NULL,
	"amount_credits" bigint NOT NULL,
	"balance_after" bigint NOT NULL,
	"lot_breakdown" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"usage_event_id" uuid,
	"payment_order_id" uuid,
	"reversal_of_entry_id" uuid,
	"pricing_snapshot" jsonb,
	"actor_type" "credit_actor_type" NOT NULL,
	"actor_id" text,
	"reason" text,
	"idempotency_key" text NOT NULL,
	"chain_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_lots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid NOT NULL,
	"source" "credit_lot_source" NOT NULL,
	"initial_credits" bigint NOT NULL,
	"remaining_credits" bigint NOT NULL,
	"expires_at" timestamp with time zone,
	"status" "credit_lot_status" DEFAULT 'active' NOT NULL,
	"payment_order_id" uuid,
	"plan_subscription_id" uuid,
	"granted_by_admin_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_payment_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" text NOT NULL,
	"wallet_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"order_type" text NOT NULL,
	"product_id" uuid,
	"plan_subscription_id" uuid,
	"amount_krw" integer NOT NULL,
	"credits_to_grant" bigint NOT NULL,
	"krw_per_credit_snapshot" integer NOT NULL,
	"status" "credit_order_status" DEFAULT 'created' NOT NULL,
	"portone_status" text,
	"portone_tx_id" text,
	"pay_method" text,
	"paid_at" timestamp with time zone,
	"fail_reason" text,
	"refunded_amount_krw" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_plan_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"wallet_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "credit_plan_sub_status" DEFAULT 'active' NOT NULL,
	"billing_key" text NOT NULL,
	"billing_key_issued_at" timestamp with time zone,
	"card_summary" jsonb,
	"current_period_start" timestamp with time zone NOT NULL,
	"current_period_end" timestamp with time zone NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"next_schedule_id" text,
	"next_schedule_payment_id" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"pending_plan_id" uuid,
	"canceled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"monthly_price_krw" integer NOT NULL,
	"monthly_credits" bigint NOT NULL,
	"features" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_pricing_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_type" text NOT NULL,
	"feature_code" text,
	"model" text,
	"input_millicredits_per_1k" bigint,
	"output_millicredits_per_1k" bigint,
	"cache_read_millicredits_per_1k" bigint,
	"cache_write_millicredits_per_1k" bigint,
	"flat_credits" bigint,
	"effective_from" timestamp with time zone NOT NULL,
	"effective_until" timestamp with time zone,
	"created_by_admin_id" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"amount_krw" integer NOT NULL,
	"credits" bigint NOT NULL,
	"bonus_credits" bigint DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_date" timestamp with time zone NOT NULL,
	"scope" text NOT NULL,
	"status" text NOT NULL,
	"summary" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_by_admin_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credit_wallets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"balance_credits" bigint DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"frozen_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "portone_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"webhook_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payment_id" text,
	"billing_key" text,
	"payload_digest" jsonb NOT NULL,
	"processing_status" text DEFAULT 'received' NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"wallet_id" uuid,
	"user_id" uuid,
	"company_id" uuid,
	"feature_code" text NOT NULL,
	"provider" text,
	"model" text,
	"input_tokens" bigint DEFAULT 0 NOT NULL,
	"output_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_read_tokens" bigint DEFAULT 0 NOT NULL,
	"cache_write_tokens" bigint DEFAULT 0 NOT NULL,
	"provider_cost_usd_micros" bigint,
	"credits_charged" bigint DEFAULT 0 NOT NULL,
	"pricing_rule_id" uuid,
	"status" "usage_event_status" DEFAULT 'pending' NOT NULL,
	"request_id" text,
	"context_ref" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_holds" ADD CONSTRAINT "credit_holds_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_usage_event_id_usage_events_id_fk" FOREIGN KEY ("usage_event_id") REFERENCES "public"."usage_events"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_payment_order_id_credit_payment_orders_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."credit_payment_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_payment_order_id_credit_payment_orders_id_fk" FOREIGN KEY ("payment_order_id") REFERENCES "public"."credit_payment_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_plan_subscription_id_credit_plan_subscriptions_id_fk" FOREIGN KEY ("plan_subscription_id") REFERENCES "public"."credit_plan_subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_payment_orders" ADD CONSTRAINT "credit_payment_orders_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_payment_orders" ADD CONSTRAINT "credit_payment_orders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_payment_orders" ADD CONSTRAINT "credit_payment_orders_product_id_credit_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."credit_products"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_plan_subscriptions" ADD CONSTRAINT "credit_plan_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_plan_subscriptions" ADD CONSTRAINT "credit_plan_subscriptions_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_plan_subscriptions" ADD CONSTRAINT "credit_plan_subscriptions_plan_id_credit_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."credit_plans"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_wallet_id_credit_wallets_id_fk" FOREIGN KEY ("wallet_id") REFERENCES "public"."credit_wallets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_pricing_rule_id_credit_pricing_rules_id_fk" FOREIGN KEY ("pricing_rule_id") REFERENCES "public"."credit_pricing_rules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "credit_audit_logs_target_idx" ON "credit_audit_logs" USING btree ("target_type","target_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_audit_logs_actor_idx" ON "credit_audit_logs" USING btree ("actor_type","actor_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_audit_logs_action_idx" ON "credit_audit_logs" USING btree ("action","created_at");--> statement-breakpoint
CREATE INDEX "credit_holds_wallet_pending_idx" ON "credit_holds" USING btree ("wallet_id","status");--> statement-breakpoint
CREATE INDEX "credit_holds_expires_idx" ON "credit_holds" USING btree ("status","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_holds_usage_event_idx" ON "credit_holds" USING btree ("usage_event_id");--> statement-breakpoint
CREATE INDEX "credit_ledger_wallet_created_idx" ON "credit_ledger" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_ledger_idempotency_idx" ON "credit_ledger" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "credit_ledger_entry_type_idx" ON "credit_ledger" USING btree ("entry_type","created_at");--> statement-breakpoint
CREATE INDEX "credit_lots_wallet_idx" ON "credit_lots" USING btree ("wallet_id");--> statement-breakpoint
CREATE INDEX "credit_lots_wallet_active_idx" ON "credit_lots" USING btree ("wallet_id","status","expires_at");--> statement-breakpoint
CREATE INDEX "credit_lots_order_idx" ON "credit_lots" USING btree ("payment_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_payment_orders_payment_id_idx" ON "credit_payment_orders" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "credit_payment_orders_wallet_idx" ON "credit_payment_orders" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "credit_payment_orders_status_idx" ON "credit_payment_orders" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "credit_plan_subs_user_idx" ON "credit_plan_subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE INDEX "credit_plan_subs_schedule_idx" ON "credit_plan_subscriptions" USING btree ("next_schedule_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_plans_code_idx" ON "credit_plans" USING btree ("code");--> statement-breakpoint
CREATE INDEX "credit_pricing_rules_lookup_idx" ON "credit_pricing_rules" USING btree ("rule_type","feature_code","model","effective_from");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_products_code_idx" ON "credit_products" USING btree ("code");--> statement-breakpoint
CREATE INDEX "credit_recon_runs_date_idx" ON "credit_reconciliation_runs" USING btree ("run_date","scope");--> statement-breakpoint
CREATE UNIQUE INDEX "credit_wallets_user_idx" ON "credit_wallets" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "portone_webhook_events_webhook_id_idx" ON "portone_webhook_events" USING btree ("webhook_id");--> statement-breakpoint
CREATE INDEX "portone_webhook_events_payment_idx" ON "portone_webhook_events" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "portone_webhook_events_status_idx" ON "portone_webhook_events" USING btree ("processing_status","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_wallet_created_idx" ON "usage_events" USING btree ("wallet_id","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_feature_idx" ON "usage_events" USING btree ("feature_code","created_at");--> statement-breakpoint
CREATE INDEX "usage_events_status_idx" ON "usage_events" USING btree ("status");--> statement-breakpoint
-- ─────────────────────────────────────────────────────────────────────────────
-- 수동 추가 DDL (drizzle 미생성). 설계 4.1/4.2/4.3/4.9/4.13.
-- ─────────────────────────────────────────────────────────────────────────────

-- 4.1 CHECK: 지갑 잔액 음수 금지 (shortfall 은 0 클램프)
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_balance_nonneg" CHECK ("balance_credits" >= 0);--> statement-breakpoint

-- 4.2 CHECK: lot 잔여는 [0, initial] 범위
ALTER TABLE "credit_lots" ADD CONSTRAINT "credit_lots_remaining_bounds" CHECK ("remaining_credits" >= 0 AND "remaining_credits" <= "initial_credits");--> statement-breakpoint

-- 4.3 분개 금액 0 금지
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_amount_nonzero" CHECK ("amount_credits" <> 0);--> statement-breakpoint

-- 4.3 reversal_of_entry_id 자기참조 FK
ALTER TABLE "credit_ledger" ADD CONSTRAINT "credit_ledger_reversal_of_entry_id_fk" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "public"."credit_ledger"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- 4.3 reversal 원분개당 1회 제한 (partial unique index)
CREATE UNIQUE INDEX "credit_ledger_reversal_of_entry_uidx" ON "credit_ledger" ("reversal_of_entry_id") WHERE "reversal_of_entry_id" IS NOT NULL;--> statement-breakpoint

-- 4.9 user당 활성 구독 1개 (incomplete 제외 — 레드팀 M6)
CREATE UNIQUE INDEX "credit_plan_subs_one_active" ON "credit_plan_subscriptions" ("user_id") WHERE "status" IN ('active','past_due');--> statement-breakpoint

-- 4.3 append-only 강제 트리거 (credit_ledger + credit_audit_logs).
-- app_private 스키마·함수는 0003 에서 이미 존재. reject_mutation 은 신규.
CREATE OR REPLACE FUNCTION "app_private"."reject_mutation"() RETURNS trigger AS $$
BEGIN RAISE EXCEPTION 'append-only table: % rows cannot be updated or deleted', TG_TABLE_NAME; END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "credit_ledger_no_update" BEFORE UPDATE OR DELETE ON "credit_ledger"
  FOR EACH ROW EXECUTE FUNCTION "app_private"."reject_mutation"();--> statement-breakpoint
CREATE TRIGGER "credit_audit_logs_no_update" BEFORE UPDATE OR DELETE ON "credit_audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "app_private"."reject_mutation"();--> statement-breakpoint

-- ─────────────────────────────────────────────────────────────────────────────
-- 4.13 RLS. 실측: current_user='postgres', rolbypassrls=true, rolsuper=false
--   → "BYPASSRLS 유력" 분기: 전 테이블 ENABLE + FORCE.
--   admin 은 BYPASSRLS 로 통과(접근성 유지), 향후 non-BYPASSRLS 역할 도입 시 즉시 방어.
--   이 구조에서 RLS 는 2선 방어이며, 코드 레벨 가드(withCunoteDbUser 경유)가 1선.
-- ─────────────────────────────────────────────────────────────────────────────

-- 본인 소유 조회 계열: credit_wallets 는 user_id 직접, 나머지는 wallet_id 조인.
ALTER TABLE "credit_wallets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_wallets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "credit_wallets_self_select" ON "credit_wallets" FOR SELECT
  USING ("user_id" = "app_private"."current_user_id"());--> statement-breakpoint

ALTER TABLE "credit_lots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_lots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "credit_lots_self_select" ON "credit_lots" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "credit_wallets" w WHERE w."id" = "credit_lots"."wallet_id" AND w."user_id" = "app_private"."current_user_id"()));--> statement-breakpoint

ALTER TABLE "credit_ledger" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_ledger" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "credit_ledger_self_select" ON "credit_ledger" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "credit_wallets" w WHERE w."id" = "credit_ledger"."wallet_id" AND w."user_id" = "app_private"."current_user_id"()));--> statement-breakpoint

ALTER TABLE "credit_holds" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_holds" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "credit_holds_self_select" ON "credit_holds" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "credit_wallets" w WHERE w."id" = "credit_holds"."wallet_id" AND w."user_id" = "app_private"."current_user_id"()));--> statement-breakpoint

ALTER TABLE "usage_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "usage_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "usage_events_self_select" ON "usage_events" FOR SELECT
  USING (EXISTS (SELECT 1 FROM "credit_wallets" w WHERE w."id" = "usage_events"."wallet_id" AND w."user_id" = "app_private"."current_user_id"()));--> statement-breakpoint

ALTER TABLE "credit_payment_orders" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_payment_orders" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "credit_payment_orders_self_select" ON "credit_payment_orders" FOR SELECT
  USING ("user_id" = "app_private"."current_user_id"());--> statement-breakpoint

ALTER TABLE "credit_plan_subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_plan_subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "credit_plan_subscriptions_self_select" ON "credit_plan_subscriptions" FOR SELECT
  USING ("user_id" = "app_private"."current_user_id"());--> statement-breakpoint

-- 전면 차단(웹 사용자용 정책 없음): audit_logs / webhook_events / recon_runs / settings / pricing_rules
ALTER TABLE "credit_audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_audit_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portone_webhook_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "portone_webhook_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_reconciliation_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_reconciliation_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_settings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_pricing_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_pricing_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

-- 공개 카탈로그: is_active 행 전원 SELECT 허용 (비로그인 /pricing 노출용)
ALTER TABLE "credit_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "credit_products_active_select" ON "credit_products" FOR SELECT
  USING ("is_active" = true);--> statement-breakpoint

ALTER TABLE "credit_plans" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "credit_plans" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "credit_plans_active_select" ON "credit_plans" FOR SELECT
  USING ("is_active" = true);
