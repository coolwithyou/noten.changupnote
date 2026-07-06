CREATE TABLE "user_business_lookup_history" (
	"user_id" uuid NOT NULL,
	"biz_no" text NOT NULL,
	"first_looked_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_looked_up_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lookup_count" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "user_business_lookup_history_user_id_biz_no_pk" PRIMARY KEY("user_id","biz_no")
);
--> statement-breakpoint
ALTER TABLE "user_business_lookup_history" ADD CONSTRAINT "user_business_lookup_history_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "user_business_lookup_history_user_last_lookup_idx" ON "user_business_lookup_history" USING btree ("user_id","last_looked_up_at");--> statement-breakpoint
CREATE INDEX "user_business_lookup_history_biz_no_idx" ON "user_business_lookup_history" USING btree ("biz_no");--> statement-breakpoint
ALTER TABLE "user_business_lookup_history" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_business_lookup_history" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "user_business_lookup_history_self"
ON "user_business_lookup_history"
FOR ALL
USING ("user_id" = "app_private"."current_user_id"())
WITH CHECK ("user_id" = "app_private"."current_user_id"());
