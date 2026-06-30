CREATE TABLE "billing_tax_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"business_name" text,
	"business_registration_number" text,
	"recipient_name" text,
	"recipient_email" text,
	"recipient_phone" text,
	"tax_invoice_email" text,
	"billing_address_line1" text,
	"billing_address_line2" text,
	"postal_code" text,
	"tax_invoice_enabled" boolean DEFAULT false NOT NULL,
	"notes" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_tax_profiles" ADD CONSTRAINT "billing_tax_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_tax_profiles" ADD CONSTRAINT "billing_tax_profiles_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_tax_profiles_company_idx" ON "billing_tax_profiles" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "billing_tax_profiles_updated_at_idx" ON "billing_tax_profiles" USING btree ("updated_at");--> statement-breakpoint
CREATE INDEX "billing_tax_profiles_tax_invoice_email_idx" ON "billing_tax_profiles" USING btree ("tax_invoice_email");
