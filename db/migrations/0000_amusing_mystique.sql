CREATE TYPE "public"."company_kind" AS ENUM('active', 'preliminary');--> statement-breakpoint
CREATE TYPE "public"."company_profile_source" AS ENUM('popbill', 'nts', 'codef', 'self_declared', 'ocr');--> statement-breakpoint
CREATE TYPE "public"."company_role" AS ENUM('owner', 'member', 'viewer');--> statement-breakpoint
CREATE TYPE "public"."consent_scope" AS ENUM('basic_info', 'hometax', 'insurance');--> statement-breakpoint
CREATE TYPE "public"."criterion_dimension" AS ENUM('region', 'biz_age', 'industry', 'size', 'revenue', 'employees', 'founder_age', 'founder_trait', 'certification', 'prior_award', 'ip', 'target_type', 'business_status', 'other');--> statement-breakpoint
CREATE TYPE "public"."criterion_kind" AS ENUM('required', 'preferred', 'exclusion');--> statement-breakpoint
CREATE TYPE "public"."criterion_operator" AS ENUM('in', 'not_in', 'lte', 'gte', 'between', 'exists', 'text_only');--> statement-breakpoint
CREATE TYPE "public"."eligibility" AS ENUM('eligible', 'conditional', 'ineligible');--> statement-breakpoint
CREATE TYPE "public"."eval_target" AS ENUM('extraction', 'matching');--> statement-breakpoint
CREATE TYPE "public"."extraction_status" AS ENUM('auto', 'review', 'labeled');--> statement-breakpoint
CREATE TYPE "public"."feedback_actor" AS ENUM('user', 'reviewer');--> statement-breakpoint
CREATE TYPE "public"."feedback_target" AS ENUM('extraction', 'match');--> statement-breakpoint
CREATE TYPE "public"."feedback_type" AS ENUM('implicit', 'explicit_relevant', 'explicit_irrelevant', 'outcome');--> statement-breakpoint
CREATE TYPE "public"."golden_kind" AS ENUM('extraction', 'matching');--> statement-breakpoint
CREATE TYPE "public"."grant_raw_status" AS ENUM('fetched', 'converted', 'extracted', 'normalized', 'published', 'failed');--> statement-breakpoint
CREATE TYPE "public"."grant_source" AS ENUM('kstartup', 'bizinfo', 'bizinfo_event');--> statement-breakpoint
CREATE TYPE "public"."grant_status" AS ENUM('upcoming', 'open', 'closed', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."match_event" AS ENUM('surfaced', 'clicked', 'saved', 'apply_click');--> statement-breakpoint
CREATE TYPE "public"."version_type" AS ENUM('model', 'prompt', 'ruleset', 'scoring', 'taxonomy');--> statement-breakpoint
CREATE TABLE "accounts" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "accounts_provider_provider_account_id_pk" PRIMARY KEY("provider","provider_account_id")
);
--> statement-breakpoint
CREATE TABLE "app_refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"rotated_from" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "company_kind" NOT NULL,
	"biz_no" text,
	"legal_type" text,
	"name" text,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" timestamp with time zone,
	"verify_method" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company_enrichment_cache" (
	"provider" text NOT NULL,
	"biz_no" text NOT NULL,
	"scope" text NOT NULL,
	"raw_payload" jsonb,
	"canonical_payload" jsonb,
	"provider_result_code" text,
	"provider_result_message" text,
	"checked_at" timestamp with time zone,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"payload_hash" text,
	"last_error" jsonb,
	CONSTRAINT "company_enrichment_cache_provider_biz_no_scope_pk" PRIMARY KEY("provider","biz_no","scope")
);
--> statement-breakpoint
CREATE TABLE "company_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"dimension" "criterion_dimension" NOT NULL,
	"value" jsonb NOT NULL,
	"source" "company_profile_source" NOT NULL,
	"confidence" real NOT NULL,
	"as_of" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"scope" "consent_scope" NOT NULL,
	"purpose" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dedup_links" (
	"canonical_grant_id" uuid NOT NULL,
	"member_grant_id" uuid NOT NULL,
	"score" real NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	CONSTRAINT "dedup_links_canonical_grant_id_member_grant_id_pk" PRIMARY KEY("canonical_grant_id","member_grant_id")
);
--> statement-breakpoint
CREATE TABLE "eval_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target" "eval_target" NOT NULL,
	"version_refs" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"golden_ver" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extraction_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid,
	"input_ref" text NOT NULL,
	"output" jsonb NOT NULL,
	"confidence" real NOT NULL,
	"status" "extraction_status" NOT NULL,
	"reviewer" uuid,
	"model_ver" text NOT NULL,
	"prompt_ver" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_type" "feedback_target" NOT NULL,
	"target_id" text NOT NULL,
	"type" "feedback_type" NOT NULL,
	"value" jsonb NOT NULL,
	"actor" "feedback_actor" NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "golden_set" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "golden_kind" NOT NULL,
	"ref" text NOT NULL,
	"gold" jsonb NOT NULL,
	"curated_by" uuid,
	"golden_ver" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grant_criteria" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"grant_id" uuid NOT NULL,
	"dimension" "criterion_dimension" NOT NULL,
	"operator" "criterion_operator" NOT NULL,
	"value" jsonb NOT NULL,
	"kind" "criterion_kind" NOT NULL,
	"weight" real,
	"confidence" real NOT NULL,
	"source_span" text,
	"raw_text" text,
	"source_field" text,
	"needs_review" boolean DEFAULT false NOT NULL,
	"parser_version" text
);
--> statement-breakpoint
CREATE TABLE "grant_raw" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "grant_source" NOT NULL,
	"source_id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"attachments" jsonb,
	"raw_hash" text,
	"collected_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" "grant_raw_status" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "grant_source" NOT NULL,
	"source_id" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"agency_jurisdiction" text,
	"agency_operator" text,
	"category_l1" text,
	"category_l2" text,
	"apply_start" timestamp with time zone,
	"apply_end" timestamp with time zone,
	"apply_method" jsonb,
	"support_amount" jsonb,
	"required_documents" jsonb,
	"status" "grant_status" NOT NULL,
	"f_regions" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"f_industries" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"f_biz_age_min_months" integer,
	"f_biz_age_max_months" integer,
	"f_sizes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"f_founder_traits" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"f_required_certs" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"embedding" jsonb,
	"overall_confidence" real NOT NULL,
	"model_ver" text,
	"prompt_ver" text,
	"parser_version" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "industry_taxonomy" (
	"ksic" varchar(16) NOT NULL,
	"policy_tag" text NOT NULL,
	"ver" text NOT NULL,
	CONSTRAINT "industry_taxonomy_ksic_policy_tag_ver_pk" PRIMARY KEY("ksic","policy_tag","ver")
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"event" "match_event" NOT NULL,
	"ruleset_ver" text NOT NULL,
	"ts" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_state" (
	"company_id" uuid NOT NULL,
	"grant_id" uuid NOT NULL,
	"eligibility" "eligibility" NOT NULL,
	"match_score" integer NOT NULL,
	"fit_score" integer NOT NULL,
	"competitiveness" jsonb,
	"value_score" integer,
	"rule_trace" jsonb NOT NULL,
	"match_confidence" real NOT NULL,
	"eligible_from" timestamp with time zone,
	"eligible_until" timestamp with time zone,
	"ruleset_ver" text NOT NULL,
	"scoring_ver" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "match_state_company_id_grant_id_pk" PRIMARY KEY("company_id","grant_id")
);
--> statement-breakpoint
CREATE TABLE "region_hierarchy" (
	"sigungu" text PRIMARY KEY NOT NULL,
	"sido" text NOT NULL,
	"region_group" text
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "size_thresholds" (
	"ksic" varchar(16) NOT NULL,
	"segment" text NOT NULL,
	"revenue_max" integer,
	"employees_max" integer,
	CONSTRAINT "size_thresholds_ksic_segment_pk" PRIMARY KEY("ksic","segment")
);
--> statement-breakpoint
CREATE TABLE "source_cursor" (
	"source" "grant_source" PRIMARY KEY NOT NULL,
	"last_page" integer,
	"last_collected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "user_company" (
	"user_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"role" "company_role" NOT NULL,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_company_user_id_company_id_pk" PRIMARY KEY("user_id","company_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification_tokens" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_tokens_identifier_token_pk" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "version_type" NOT NULL,
	"hash" text NOT NULL,
	"notes" text,
	"activated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_refresh_tokens" ADD CONSTRAINT "app_refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "companies" ADD CONSTRAINT "companies_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedup_links" ADD CONSTRAINT "dedup_links_canonical_grant_id_grants_id_fk" FOREIGN KEY ("canonical_grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dedup_links" ADD CONSTRAINT "dedup_links_member_grant_id_grants_id_fk" FOREIGN KEY ("member_grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_log" ADD CONSTRAINT "extraction_log_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extraction_log" ADD CONSTRAINT "extraction_log_reviewer_users_id_fk" FOREIGN KEY ("reviewer") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "golden_set" ADD CONSTRAINT "golden_set_curated_by_users_id_fk" FOREIGN KEY ("curated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_criteria" ADD CONSTRAINT "grant_criteria_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_state" ADD CONSTRAINT "match_state_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_state" ADD CONSTRAINT "match_state_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_company" ADD CONSTRAINT "user_company_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_company" ADD CONSTRAINT "user_company_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_company" ADD CONSTRAINT "user_company_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "app_refresh_tokens_hash_idx" ON "app_refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "app_refresh_tokens_user_device_idx" ON "app_refresh_tokens" USING btree ("user_id","device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "companies_biz_no_idx" ON "companies" USING btree ("biz_no");--> statement-breakpoint
CREATE INDEX "companies_created_by_idx" ON "companies" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "company_enrichment_cache_expiry_idx" ON "company_enrichment_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "company_profiles_company_dimension_idx" ON "company_profiles" USING btree ("company_id","dimension");--> statement-breakpoint
CREATE INDEX "consents_company_user_idx" ON "consents" USING btree ("company_id","user_id");--> statement-breakpoint
CREATE INDEX "eval_runs_target_ver_idx" ON "eval_runs" USING btree ("target","golden_ver");--> statement-breakpoint
CREATE INDEX "extraction_log_status_idx" ON "extraction_log" USING btree ("status");--> statement-breakpoint
CREATE INDEX "feedback_target_idx" ON "feedback" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "golden_set_kind_ver_idx" ON "golden_set" USING btree ("kind","golden_ver");--> statement-breakpoint
CREATE INDEX "grant_criteria_grant_id_idx" ON "grant_criteria" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "grant_criteria_review_idx" ON "grant_criteria" USING btree ("needs_review");--> statement-breakpoint
CREATE UNIQUE INDEX "grant_raw_source_id_idx" ON "grant_raw" USING btree ("source","source_id");--> statement-breakpoint
CREATE UNIQUE INDEX "grants_source_id_idx" ON "grants" USING btree ("source","source_id");--> statement-breakpoint
CREATE INDEX "grants_status_idx" ON "grants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "grants_f_regions_idx" ON "grants" USING btree ("f_regions");--> statement-breakpoint
CREATE INDEX "match_events_company_grant_idx" ON "match_events" USING btree ("company_id","grant_id");--> statement-breakpoint
CREATE INDEX "match_state_eligible_from_idx" ON "match_state" USING btree ("eligible_from");--> statement-breakpoint
CREATE INDEX "match_state_eligible_until_idx" ON "match_state" USING btree ("eligible_until");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_company_company_id_idx" ON "user_company" USING btree ("company_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "verification_tokens_token_idx" ON "verification_tokens" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "versions_type_hash_idx" ON "versions" USING btree ("type","hash");