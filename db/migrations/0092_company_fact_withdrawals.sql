CREATE TABLE "company_fact_withdrawals" (
  "company_id" uuid NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "semantic_sha256" text NOT NULL CHECK ("semantic_sha256" ~ '^[0-9a-f]{64}$'),
  "condition_key" text NOT NULL CHECK ("condition_key" ~ '^[a-z][a-z0-9]*(_[a-z0-9]+)*$'),
  "contract_version" text NOT NULL CHECK ("contract_version" = 'company-fact-reuse-v1'),
  "source_question_id" uuid NOT NULL,
  "source_grant_id" uuid NOT NULL,
  "answer_revision" integer NOT NULL CHECK ("answer_revision" > 0),
  "withdrawn_at" timestamptz NOT NULL,
  "withdrawn_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  PRIMARY KEY ("company_id", "semantic_sha256")
);
--> statement-breakpoint
-- 원본 공고/질문이 삭제돼도 철회 장벽을 유지한다. 회사 삭제 시에만 함께 삭제한다.
ALTER TABLE "company_fact_withdrawals" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_fact_withdrawals" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_fact_withdrawals_member_read" ON "company_fact_withdrawals" FOR SELECT
USING (app_private.is_current_company_member(company_id));
--> statement-breakpoint
CREATE TRIGGER bump_match_company_fact_withdrawal_revision
AFTER INSERT OR UPDATE OR DELETE ON company_fact_withdrawals
FOR EACH ROW EXECUTE FUNCTION app_private.bump_match_company_child_revision();
