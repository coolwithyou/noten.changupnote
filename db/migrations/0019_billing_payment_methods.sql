CREATE TABLE "billing_payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_customer_id" text,
	"provider_payment_method_id" text NOT NULL,
	"type" text DEFAULT 'card' NOT NULL,
	"brand" text,
	"last4" text,
	"exp_month" integer,
	"exp_year" integer,
	"holder_name" text,
	"billing_email" text,
	"status" text DEFAULT 'active' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"provider_portal_url" text,
	"last_used_at" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_payment_methods" ADD CONSTRAINT "billing_payment_methods_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_payment_methods_provider_method_idx" ON "billing_payment_methods" USING btree ("provider","provider_payment_method_id");--> statement-breakpoint
CREATE INDEX "billing_payment_methods_company_default_idx" ON "billing_payment_methods" USING btree ("company_id","is_default");--> statement-breakpoint
CREATE INDEX "billing_payment_methods_company_updated_idx" ON "billing_payment_methods" USING btree ("company_id","updated_at");--> statement-breakpoint
CREATE INDEX "billing_payment_methods_customer_idx" ON "billing_payment_methods" USING btree ("provider_customer_id");
