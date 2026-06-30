CREATE TABLE "billing_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_invoice_id" text NOT NULL,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"invoice_number" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"currency" text DEFAULT 'KRW' NOT NULL,
	"amount_due" integer DEFAULT 0 NOT NULL,
	"amount_paid" integer DEFAULT 0 NOT NULL,
	"tax_amount" integer DEFAULT 0 NOT NULL,
	"hosted_invoice_url" text,
	"receipt_url" text,
	"issued_at" timestamp with time zone,
	"due_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_invoices" ADD CONSTRAINT "billing_invoices_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_invoices_provider_invoice_idx" ON "billing_invoices" USING btree ("provider","provider_invoice_id");--> statement-breakpoint
CREATE INDEX "billing_invoices_company_issued_idx" ON "billing_invoices" USING btree ("company_id","issued_at");--> statement-breakpoint
CREATE INDEX "billing_invoices_company_status_idx" ON "billing_invoices" USING btree ("company_id","status");--> statement-breakpoint
CREATE INDEX "billing_invoices_subscription_idx" ON "billing_invoices" USING btree ("provider_subscription_id");
