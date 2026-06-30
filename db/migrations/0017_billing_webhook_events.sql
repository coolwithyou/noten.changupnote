CREATE TABLE "billing_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"company_id" uuid,
	"provider_customer_id" text,
	"provider_subscription_id" text,
	"signature_verified" boolean DEFAULT false NOT NULL,
	"processing_status" text DEFAULT 'received' NOT NULL,
	"error" text,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "billing_webhook_events" ADD CONSTRAINT "billing_webhook_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_provider_event_idx" ON "billing_webhook_events" USING btree ("provider","event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_provider_received_idx" ON "billing_webhook_events" USING btree ("provider","received_at");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_company_received_idx" ON "billing_webhook_events" USING btree ("company_id","received_at");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_processing_status_idx" ON "billing_webhook_events" USING btree ("processing_status");
