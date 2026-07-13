CREATE TABLE "profile_question_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"dimension" "criterion_dimension" NOT NULL,
	"window_limit" integer NOT NULL,
	"evaluated_grant_count" integer NOT NULL,
	"targeted_conditional_count" integer NOT NULL,
	"dimension_resolved_grant_count" integer NOT NULL,
	"eligibility_resolved_count" integer NOT NULL,
	"conditional_to_eligible_count" integer NOT NULL,
	"conditional_to_ineligible_count" integer NOT NULL,
	"remaining_conditional_count" integer NOT NULL,
	"conditional_resolution_rate" real,
	"ruleset_ver" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_question_events_counts_nonnegative" CHECK (
    "profile_question_events"."window_limit" >= 0 AND
    "profile_question_events"."evaluated_grant_count" >= 0 AND
    "profile_question_events"."targeted_conditional_count" >= 0 AND
    "profile_question_events"."dimension_resolved_grant_count" >= 0 AND
    "profile_question_events"."eligibility_resolved_count" >= 0 AND
    "profile_question_events"."conditional_to_eligible_count" >= 0 AND
    "profile_question_events"."conditional_to_ineligible_count" >= 0 AND
    "profile_question_events"."remaining_conditional_count" >= 0 AND
    "profile_question_events"."eligibility_resolved_count" = "profile_question_events"."conditional_to_eligible_count" + "profile_question_events"."conditional_to_ineligible_count" AND
    "profile_question_events"."targeted_conditional_count" = "profile_question_events"."eligibility_resolved_count" + "profile_question_events"."remaining_conditional_count" AND
    "profile_question_events"."dimension_resolved_grant_count" <= "profile_question_events"."targeted_conditional_count"
  ),
	CONSTRAINT "profile_question_events_rate_range" CHECK (
    "profile_question_events"."conditional_resolution_rate" IS NULL OR
    ("profile_question_events"."conditional_resolution_rate" >= 0 AND "profile_question_events"."conditional_resolution_rate" <= 1)
  )
);
--> statement-breakpoint
ALTER TABLE "profile_question_events" ADD CONSTRAINT "profile_question_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "profile_question_events_company_ts_idx" ON "profile_question_events" USING btree ("company_id","ts");--> statement-breakpoint
CREATE INDEX "profile_question_events_session_ts_idx" ON "profile_question_events" USING btree ("session_id","ts");--> statement-breakpoint
ALTER TABLE "profile_question_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "profile_question_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "profile_question_events_member"
ON "profile_question_events"
FOR ALL
USING (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "profile_question_events"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM "user_company"
    WHERE "user_company"."company_id" = "profile_question_events"."company_id"
      AND "user_company"."user_id" = "app_private"."current_user_id"()
  )
);
