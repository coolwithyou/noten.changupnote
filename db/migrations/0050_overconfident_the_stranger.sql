CREATE TABLE "company_grant_confirmations" (
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"answer" jsonb NOT NULL,
	"disqualified" boolean NOT NULL,
	"answered_by" uuid,
	"answered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_grant_confirmations_company_id_question_id_pk" PRIMARY KEY("company_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "grant_confirmation_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"grant_criteria_id" uuid,
	"criterion_ref" jsonb,
	"prompt" text NOT NULL,
	"options" jsonb NOT NULL,
	"answer_type" text NOT NULL,
	"reusable" text NOT NULL,
	"condition_key" text,
	"prompt_ver" text NOT NULL,
	"provenance" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD CONSTRAINT "company_grant_confirmations_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD CONSTRAINT "company_grant_confirmations_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD CONSTRAINT "company_grant_confirmations_question_id_grant_confirmation_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."grant_confirmation_questions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD CONSTRAINT "company_grant_confirmations_answered_by_users_id_fk" FOREIGN KEY ("answered_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD CONSTRAINT "grant_confirmation_questions_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD CONSTRAINT "grant_confirmation_questions_grant_criteria_id_grant_criteria_id_fk" FOREIGN KEY ("grant_criteria_id") REFERENCES "public"."grant_criteria"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "company_grant_confirmations_company_grant_idx" ON "company_grant_confirmations" USING btree ("company_id","grant_id");--> statement-breakpoint
CREATE INDEX "grant_confirmation_questions_grant_id_idx" ON "grant_confirmation_questions" USING btree ("grant_id");