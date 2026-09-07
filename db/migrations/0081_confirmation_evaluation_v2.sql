ALTER TABLE "grant_confirmation_questions" ADD COLUMN "evaluation_criterion_id" uuid;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD COLUMN "evaluation_contract_version" text;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD COLUMN "source_revision_sha256" text;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD COLUMN "source_raw_sha256" text;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD COLUMN "evaluation" text;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD COLUMN "evaluation_criterion_id" uuid;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD COLUMN "source_revision_sha256" text;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD COLUMN "source_raw_sha256" text;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD COLUMN "question_definition_sha256" text;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD COLUMN "question_version" integer;--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD COLUMN "answer_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD CONSTRAINT "grant_confirmation_questions_evaluation_criterion_id_grant_criteria_id_fk" FOREIGN KEY ("evaluation_criterion_id") REFERENCES "public"."grant_criteria"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION app_private.detach_confirmation_evaluation_questions() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.grant_confirmation_questions
  SET invalidated_at = COALESCE(invalidated_at, now()),
      invalidation_reason = COALESCE(invalidation_reason, 'anchor_criterion_removed_or_changed')
  WHERE evaluation_criterion_id = OLD.id;
  RETURN OLD;
END $$;--> statement-breakpoint
CREATE TRIGGER detach_confirmation_evaluation_questions BEFORE DELETE ON "grant_criteria"
FOR EACH ROW EXECUTE FUNCTION app_private.detach_confirmation_evaluation_questions();--> statement-breakpoint
CREATE FUNCTION app_private.enforce_confirmation_evaluation_question_anchor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF NEW.evaluation_contract_version = 'confirmation-evaluation-v2'
     AND NEW.evaluation_criterion_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM public.grant_criteria criterion
       WHERE criterion.id = NEW.evaluation_criterion_id
         AND criterion.grant_id = NEW.grant_id
     ) THEN
    RAISE EXCEPTION 'confirmation evaluation criterion must belong to the same grant';
  END IF;
  RETURN NEW;
END $$;--> statement-breakpoint
CREATE TRIGGER enforce_confirmation_evaluation_question_anchor
BEFORE INSERT OR UPDATE ON "grant_confirmation_questions"
FOR EACH ROW EXECUTE FUNCTION app_private.enforce_confirmation_evaluation_question_anchor();--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ADD CONSTRAINT "grant_confirmation_questions_evaluation_contract_check" CHECK ((
  (evaluation_contract_version IS NULL AND evaluation_criterion_id IS NULL AND source_revision_sha256 IS NULL AND source_raw_sha256 IS NULL)
  OR (
    evaluation_contract_version = 'confirmation-evaluation-v2'
    AND grant_criteria_id IS NULL
    AND (evaluation_criterion_id IS NOT NULL OR invalidated_at IS NOT NULL)
    AND source_revision_sha256 IS NOT NULL
    AND (source_revision_sha256 ~ '^[0-9a-f]{64}$') IS TRUE
    AND source_raw_sha256 IS NOT NULL
    AND (source_raw_sha256 ~ '^[0-9a-f]{64}$') IS TRUE
  )
) IS TRUE);--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD CONSTRAINT "company_grant_confirmations_evaluation_check" CHECK ((
  (evaluation IS NULL AND evaluation_criterion_id IS NULL AND source_revision_sha256 IS NULL AND source_raw_sha256 IS NULL AND question_definition_sha256 IS NULL AND question_version IS NULL)
  OR (
    evaluation IS NOT NULL
    AND
    evaluation IN ('satisfied', 'unsatisfied', 'unknown')
    AND evaluation_criterion_id IS NOT NULL
    AND source_revision_sha256 IS NOT NULL
    AND (source_revision_sha256 ~ '^[0-9a-f]{64}$') IS TRUE
    AND source_raw_sha256 IS NOT NULL
    AND (source_raw_sha256 ~ '^[0-9a-f]{64}$') IS TRUE
    AND question_definition_sha256 IS NOT NULL
    AND (question_definition_sha256 ~ '^[0-9a-f]{64}$') IS TRUE
    AND question_version IS NOT NULL
    AND question_version > 0
  )
) IS TRUE);--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ADD CONSTRAINT "company_grant_confirmations_positive_answer_revision" CHECK (answer_revision > 0);--> statement-breakpoint
CREATE INDEX "grant_confirmation_questions_evaluation_criterion_idx" ON "grant_confirmation_questions" USING btree ("evaluation_criterion_id");
--> statement-breakpoint
ALTER TABLE "grant_confirmation_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "grant_confirmation_questions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "grant_confirmation_questions_authenticated_read" ON "grant_confirmation_questions" FOR SELECT
USING (app_private.current_user_id() IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "company_grant_confirmations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_grant_confirmations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "company_grant_confirmations_member_read" ON "company_grant_confirmations" FOR SELECT
USING (app_private.is_current_company_member(company_id));
