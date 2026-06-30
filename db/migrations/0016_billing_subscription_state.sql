CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text DEFAULT 'manual' NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"status" text DEFAULT 'early_access' NOT NULL,
	"plan_code" text DEFAULT 'early_access' NOT NULL,
	"plan_name" text DEFAULT 'Early Access' NOT NULL,
	"price_label" text DEFAULT '월 0원' NOT NULL,
	"renewal_label" text DEFAULT '결제 연동 전' NOT NULL,
	"seat_limit" integer DEFAULT 5 NOT NULL,
	"auto_billing_enabled" boolean DEFAULT false NOT NULL,
	"invoices_enabled" boolean DEFAULT false NOT NULL,
	"payment_method_managed" boolean DEFAULT false NOT NULL,
	"provider_portal_url" text,
	"trial_ends_at" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_company_idx" ON "billing_subscriptions" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_status_idx" ON "billing_subscriptions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_updated_at_idx" ON "billing_subscriptions" USING btree ("updated_at");
