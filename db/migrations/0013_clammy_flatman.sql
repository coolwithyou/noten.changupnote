CREATE TYPE "public"."notification_receipt_status" AS ENUM('unread', 'read', 'dismissed');--> statement-breakpoint
CREATE TABLE "notification_receipts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"notification_id" text NOT NULL,
	"kind" text NOT NULL,
	"target" text NOT NULL,
	"status" "notification_receipt_status" DEFAULT 'unread' NOT NULL,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_receipts" ADD CONSTRAINT "notification_receipts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_receipts" ADD CONSTRAINT "notification_receipts_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_receipts_user_company_notification_idx" ON "notification_receipts" USING btree ("user_id","company_id","notification_id");--> statement-breakpoint
CREATE INDEX "notification_receipts_user_company_status_idx" ON "notification_receipts" USING btree ("user_id","company_id","status");--> statement-breakpoint
CREATE INDEX "notification_receipts_updated_at_idx" ON "notification_receipts" USING btree ("updated_at");--> statement-breakpoint
ALTER TABLE "notification_receipts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "notification_receipts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "notification_receipts_self"
ON "notification_receipts"
FOR ALL
USING (
  "user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "notification_receipts"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
)
WITH CHECK (
  "user_id" = "app_private"."current_user_id"()
  AND EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "notification_receipts"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);
