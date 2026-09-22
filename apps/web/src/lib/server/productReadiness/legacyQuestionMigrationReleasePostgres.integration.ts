import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  canonicalLegacyQuestionMigrationReviewJson,
} from "@cunote/contracts/legacy-question-migration-review";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadDeepAnalysisSourceBinding } from "../deep-analysis/prepareInput";
import { questionDefinitionSha256, sourceSpanHash } from "../analysis-lab/promote";
import {
  listGrantConfirmations,
  submitGrantConfirmations,
  withdrawGrantConfirmation,
} from "../matches/grantConfirmations";
import {
  applyLegacyQuestionMigrationRelease,
  approveLegacyQuestionMigrationRelease,
  prepareLegacyQuestionMigrationReleaseLedger,
  rollbackLegacyQuestionMigrationRelease,
} from "./legacyQuestionMigrationRelease";
import {
  LEGACY_QUESTION_MIGRATION_RELEASE_PLAN_SCHEMA,
  LEGACY_QUESTION_MIGRATION_RELEASE_PROMPT_VERSION,
  type LegacyQuestionMigrationReleasePlan,
  type LegacyQuestionMigrationReleasePlanBody,
} from "./legacyQuestionMigrationReleasePlan";

const OPTIONS = [
  { value: "yes", label: "해당해요", evaluation: "satisfied" },
  { value: "no", label: "해당하지 않아요", evaluation: "unsatisfied" },
  { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" },
] as const;

/** 폐기용 Unix socket DB에서만 제한 writer, drift, 답변 보존, rollback을 검증한다. */
export async function verifyLegacyQuestionMigrationReleasePostgres(input: {
  admin: postgres.Sql;
  client: postgres.Sql;
  socket: string;
  companyId: string;
  userId: string;
}): Promise<void> {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/u);
  const db = drizzle(input.admin, { schema });

  const fixture = await createFixture(input.admin, db, "roundtrip");
  const plan = createPlan(fixture);
  const releaseId = `legacy-migration-${fixture.grantId}`;
  const prepared = await prepareLegacyQuestionMigrationReleaseLedger({
    db,
    plan,
    releaseId,
    createdBy: "migration-preparer",
    gitCommit: "isolated-test-commit",
    buildDigest: "isolated-test-build",
  });
  assert.equal(prepared.replayed, false);
  assert.equal(prepared.itemIds.length, 1);
  const replayedPreparation = await prepareLegacyQuestionMigrationReleaseLedger({
    db,
    plan,
    releaseId,
    createdBy: "migration-preparer",
    gitCommit: "ignored-on-replay",
    buildDigest: "ignored-on-replay",
  });
  assert.equal(replayedPreparation.replayed, true);
  await assert.rejects(() => approveLegacyQuestionMigrationRelease({
    db,
    plan,
    releaseId,
    approvedBy: "migration-preparer",
    approvalArtifactSha256: "a".repeat(64),
  }), /준비자와 승인자는 달라야/u);
  await approveLegacyQuestionMigrationRelease({
    db,
    plan,
    releaseId,
    approvedBy: "migration-approver",
    approvalArtifactSha256: "a".repeat(64),
  });

  await input.admin.begin(async (tx) => {
    await tx`select set_config('app.match_state_writer_contract','match-state-input-v1',true)`;
    for (const grantId of [fixture.grantId, fixture.memberGrantId]) {
      const binding = {
        version: "match-state-input-v1",
        companyId: input.companyId,
        companyRevision: "1",
        grantId,
        grantComponentRevisions: [{ grantId, revision: "1" }],
      };
      await tx`insert into match_state
        (company_id,grant_id,eligibility,match_score,fit_score,rule_trace,match_confidence,
         ruleset_ver,scoring_ver,input_binding,calculation_as_of)
        values (${input.companyId},${grantId},'conditional',50,50,'[]',.5,'fixture','fixture',
          ${JSON.stringify(binding)}::jsonb,now())`;
    }
  });
  const applied = await applyLegacyQuestionMigrationRelease({
    db,
    plan,
    releaseId,
    executedBy: "migration-executor",
  });
  assert.equal(applied.replayed, false);
  const appliedReplay = await applyLegacyQuestionMigrationRelease({
    db,
    plan,
    releaseId,
    executedBy: "migration-executor",
  });
  assert.equal(appliedReplay.replayed, true);
  const [ledger] = await input.admin<{
    status: string;
    migrated_question_id: string;
    after_sha256: string;
  }[]>`select status,migrated_question_id,after_sha256
      from analysis_lab_legacy_question_migration_items
      where release_db_id=${prepared.releaseDbId}`;
  assert.equal(ledger?.status, "applied");
  assert.match(ledger?.after_sha256 ?? "", /^[a-f0-9]{64}$/u);
  const migratedQuestionId = ledger!.migrated_question_id;
  const questions = await input.admin<{
    id: string;
    grant_criteria_id: string | null;
    evaluation_criterion_id: string | null;
    evaluation_contract_version: string | null;
    invalidation_reason: string | null;
  }[]>`select id,grant_criteria_id,evaluation_criterion_id,evaluation_contract_version,invalidation_reason
      from grant_confirmation_questions
      where id in (${fixture.legacyQuestionId},${migratedQuestionId})
      order by id`;
  const legacy = questions.find((question) => question.id === fixture.legacyQuestionId)!;
  const migrated = questions.find((question) => question.id === migratedQuestionId)!;
  assert.equal(legacy.grant_criteria_id, null);
  assert.equal(legacy.invalidation_reason, "legacy_question_migrated_to_v2");
  assert.equal(migrated.evaluation_criterion_id, fixture.criterionId);
  assert.equal(migrated.evaluation_contract_version, "confirmation-evaluation-v2");
  assert.equal((await input.admin`select grant_id from match_state where grant_id in (${fixture.grantId},${fixture.memberGrantId})`).length, 0);
  assert.equal((await input.admin`select id from grant_criteria where id=${fixture.criterionId}`).length, 1);
  assert.equal((await input.admin`select id from grant_confirmation_questions where id=${fixture.otherQuestionId} and invalidated_at is null`).length, 1);

  const initialLedger = await listGrantConfirmations({
    companyId: input.companyId,
    grantId: fixture.grantId,
  }, db);
  const migratedQuestion = initialLedger.questions.find((question) => question.id === migratedQuestionId);
  assert.ok(migratedQuestion?.binding);
  assert.equal(initialLedger.answers.length, 0);
  let recalculatedGrantIds: string[] = [];
  const firstSave = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId: fixture.grantId,
    answers: [{
      questionId: migratedQuestionId,
      values: ["yes"],
      binding: migratedQuestion.binding,
      expectedAnswerRevision: 0,
      expectedCompanyFactRevision: null,
    }],
    asOf: new Date("2026-09-22T03:00:00.000Z"),
  }, {
    db,
    recalculate: async (recalculateInput) => {
      recalculatedGrantIds = [...(recalculateInput.relatedGrantIds ?? [])].sort();
      return {
        match: null,
        refresh: { plannedCount: recalculateInput.relatedGrantIds?.length ?? 0, savedCount: 0 },
      };
    },
  });
  assert.equal(firstSave.saved[0]?.evaluation, "satisfied");
  assert.ok(firstSave.saved[0]?.companyFactRevision);
  assert.deepEqual(recalculatedGrantIds, [fixture.grantId, ...fixture.related.map((item) => item.grantId)].sort());
  for (const related of fixture.related) {
    const ledger = await listGrantConfirmations({
      companyId: input.companyId,
      grantId: related.grantId,
    }, db);
    assert.equal(ledger.answers[0]?.evaluation, "satisfied");
    assert.equal(ledger.answers[0]?.reusedFromCompanyFact, true);
  }
  const changed = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId: fixture.grantId,
    answers: [{
      questionId: migratedQuestionId,
      values: ["no"],
      binding: migratedQuestion.binding,
      expectedAnswerRevision: firstSave.saved[0]!.answerRevision!,
      expectedCompanyFactRevision: firstSave.saved[0]!.companyFactRevision!,
    }],
    asOf: new Date("2026-09-22T04:00:00.000Z"),
  }, { db, recalculate: async () => ({ match: null, refresh: { plannedCount: 4, savedCount: 0 } }) });
  assert.equal(changed.saved[0]?.evaluation, "unsatisfied");
  for (const related of fixture.related) {
    const ledger = await listGrantConfirmations({ companyId: input.companyId, grantId: related.grantId }, db);
    assert.equal(ledger.answers[0]?.evaluation, "unsatisfied");
  }
  const withdrawn = await withdrawGrantConfirmation({
    companyId: input.companyId,
    userId: input.userId,
    grantId: fixture.grantId,
    questionId: migratedQuestionId,
    binding: migratedQuestion.binding,
    expectedAnswerRevision: changed.saved[0]!.answerRevision!,
    expectedCompanyFactRevision: changed.saved[0]!.companyFactRevision!,
    asOf: new Date("2026-09-22T05:00:00.000Z"),
  }, { db, recalculate: async () => ({ match: null, refresh: { plannedCount: 4, savedCount: 0 } }) });
  assert.equal(withdrawn.saved.length, 0);
  for (const related of fixture.related) {
    const ledger = await listGrantConfirmations({ companyId: input.companyId, grantId: related.grantId }, db);
    assert.equal(ledger.answers.length, 0, "철회된 회사 사실은 관련 공고에 남지 않는다");
  }
  assert.equal((await applyLegacyQuestionMigrationRelease({
    db,
    plan,
    releaseId,
    executedBy: "migration-executor",
  })).replayed, true, "적용 재시도는 이후 사용자 답변을 drift로 오인하지 않는다");
  await assert.rejects(() => rollbackLegacyQuestionMigrationRelease({
    db,
    plan,
    releaseId,
    executedBy: "migration-rollback",
  }), /post_migration_answers_present/u);
  assert.equal((await input.admin`select status from analysis_lab_promotion_releases where id=${prepared.releaseDbId}`)[0]?.status, "active");

  const rollbackFixture = await createFixture(input.admin, db, "rollback");
  const rollbackPlan = createPlan(rollbackFixture);
  const rollbackReleaseId = `legacy-migration-${rollbackFixture.grantId}`;
  const rollbackPrepared = await prepareLegacyQuestionMigrationReleaseLedger({
    db,
    plan: rollbackPlan,
    releaseId: rollbackReleaseId,
    createdBy: "migration-preparer",
    gitCommit: "isolated-test-commit",
    buildDigest: "isolated-test-build",
  });
  await approveLegacyQuestionMigrationRelease({
    db,
    plan: rollbackPlan,
    releaseId: rollbackReleaseId,
    approvedBy: "migration-approver",
    approvalArtifactSha256: "c".repeat(64),
  });
  await applyLegacyQuestionMigrationRelease({
    db,
    plan: rollbackPlan,
    releaseId: rollbackReleaseId,
    executedBy: "migration-executor",
  });
  const [rollbackItem] = await input.admin<{ migrated_question_id: string }[]>`
    select migrated_question_id from analysis_lab_legacy_question_migration_items
    where release_db_id=${rollbackPrepared.releaseDbId}`;
  const rolledBack = await rollbackLegacyQuestionMigrationRelease({
    db,
    plan: rollbackPlan,
    releaseId: rollbackReleaseId,
    executedBy: "migration-rollback",
  });
  assert.equal(rolledBack.replayed, false);
  const rolledBackReplay = await rollbackLegacyQuestionMigrationRelease({
    db,
    plan: rollbackPlan,
    releaseId: rollbackReleaseId,
    executedBy: "migration-rollback",
  });
  assert.equal(rolledBackReplay.replayed, true);
  const [restored] = await input.admin<{ grant_criteria_id: string; invalidated_at: Date | null }[]>`
    select grant_criteria_id,invalidated_at from grant_confirmation_questions where id=${rollbackFixture.legacyQuestionId}`;
  assert.equal(restored?.grant_criteria_id, rollbackFixture.criterionId);
  assert.equal(restored?.invalidated_at, null);
  const [retiredSuccessor] = await input.admin<{ invalidation_reason: string }[]>`
    select invalidation_reason from grant_confirmation_questions where id=${rollbackItem!.migrated_question_id}`;
  assert.equal(retiredSuccessor?.invalidation_reason, "legacy_question_migration_rolled_back");

  const driftFixture = await createFixture(input.admin, db, "drift");
  const driftPlan = createPlan(driftFixture);
  const driftReleaseId = `legacy-migration-${driftFixture.grantId}`;
  await prepareLegacyQuestionMigrationReleaseLedger({
    db,
    plan: driftPlan,
    releaseId: driftReleaseId,
    createdBy: "migration-preparer",
    gitCommit: "isolated-test-commit",
    buildDigest: "isolated-test-build",
  });
  await approveLegacyQuestionMigrationRelease({
    db,
    plan: driftPlan,
    releaseId: driftReleaseId,
    approvedBy: "migration-approver",
    approvalArtifactSha256: "b".repeat(64),
  });
  await input.admin`insert into company_grant_confirmations
    (company_id,grant_id,question_id,answer,disqualified)
    values (${input.companyId},${driftFixture.grantId},${driftFixture.legacyQuestionId},'{"values":["yes"]}',false)`;
  await assert.rejects(() => applyLegacyQuestionMigrationRelease({
    db,
    plan: driftPlan,
    releaseId: driftReleaseId,
    executedBy: "migration-executor",
  }), /baseline_drift/u);
  const [driftLegacy] = await input.admin<{ invalidated_at: Date | null }[]>`
    select invalidated_at from grant_confirmation_questions where id=${driftFixture.legacyQuestionId}`;
  assert.equal(driftLegacy?.invalidated_at, null, "apply 실패는 legacy 질문을 부분 변경하지 않는다");
  assert.equal((await input.admin`
    select id from grant_confirmation_questions
    where grant_id=${driftFixture.grantId} and evaluation_contract_version='confirmation-evaluation-v2'
  `).length, 0);
  assert.equal((await input.admin`
    select status from analysis_lab_legacy_question_migration_items
    where legacy_question_id=${driftFixture.legacyQuestionId}
  `)[0]?.status, "prepared");

  await input.client.begin(async (tx) => {
    assert.equal((await tx`select id from analysis_lab_legacy_question_migration_items`).length, 0);
  });
  console.log("PASS: migrated v2 question roundtrip updates four related grants and limited migration stays exact, atomic, answer-preserving and reversible");
}

interface Fixture {
  grantId: string;
  memberGrantId: string;
  criterionId: string;
  legacyQuestionId: string;
  otherQuestionId: string;
  sourceRevisionSha256: string;
  sourceRawSha256: string;
  definitionSha256: string;
  related: Array<{
    grantId: string;
    criterionId: string;
    questionId: string;
  }>;
}

async function createFixture(admin: postgres.Sql, db: CunoteDb, suffix: string): Promise<Fixture> {
  const grantId = crypto.randomUUID();
  const memberGrantId = crypto.randomUUID();
  const criterionId = crypto.randomUUID();
  const legacyQuestionId = crypto.randomUUID();
  const otherQuestionId = crypto.randomUUID();
  const sourceId = `legacy-migration-${suffix}-${grantId}`;
  const memberSourceId = `legacy-migration-member-${suffix}-${grantId}`;
  const sourceRawSha256 = suffix === "roundtrip" ? "7".repeat(64) : "8".repeat(64);
  await admin`insert into grants(id,source,source_id,title,status,overall_confidence)
    values (${grantId},'bizinfo',${sourceId},${`이관 ${suffix} 공고`},'open',1),
           (${memberGrantId},'bizinfo',${memberSourceId},${`이관 ${suffix} 중복 공고`},'open',1)`;
  await admin`insert into grant_raw(source,source_id,payload,attachments,raw_hash,status)
    values ('bizinfo',${sourceId},'{}','[]',${sourceRawSha256},'normalized'),
           ('bizinfo',${memberSourceId},'{}','[]',${"9".repeat(64)},'normalized')`;
  await admin`insert into grant_criteria
    (id,grant_id,dimension,operator,value,kind,confidence,source_span,stable_key,needs_review)
    values (${criterionId},${grantId},'region','text_only','{"note":"시흥 소재 여부"}','required',.9,
      '시흥시에 소재한 기업','siheung-location',false)`;
  await admin`insert into grant_confirmation_questions
    (id,grant_id,grant_criteria_id,criterion_stable_key,definition_sha256,version,prompt,options,
     answer_type,reusable,prompt_ver,provenance)
    values (${legacyQuestionId},${grantId},${criterionId},'siheung-location','legacy-v0',1,
      '귀사는 시흥시에 소재하나요?',${JSON.stringify(OPTIONS)}::jsonb,'single','per_notice','legacy-v0','{}'),
      (${otherQuestionId},${grantId},null,'unrelated-condition',${"e".repeat(64)},1,
      '다른 조건인가요?',${JSON.stringify(OPTIONS)}::jsonb,'single','per_notice','legacy-v0','{}')`;
  await admin`insert into dedup_links(canonical_grant_id,member_grant_id,score,confirmed)
    values (${grantId},${memberGrantId},1,true)`;
  const source = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(source);
  const definitionSha256 = questionDefinitionSha256({
    prompt: "현재 시흥시에 등록된 사업장이 있나요?",
    options: [...OPTIONS],
    answerType: "single",
    reusable: "company_fact",
    conditionKey: "siheung_registered_business_location",
    evaluationContractVersion: "confirmation-evaluation-v2",
    sourceRevisionSha256: source.sourceRevisionSha256,
    sourceRawSha256: source.sourceRawSha256,
  });
  const related: Fixture["related"] = [];
  for (let index = 0; index < 3; index += 1) {
    const relatedGrantId = crypto.randomUUID();
    const relatedCriterionId = crypto.randomUUID();
    const relatedQuestionId = crypto.randomUUID();
    const relatedSourceId = `legacy-migration-related-${suffix}-${index}-${grantId}`;
    const relatedRawSha256 = ["a", "b", "c"][index]!.repeat(64);
    await admin`insert into grants(id,source,source_id,title,status,overall_confidence)
      values (${relatedGrantId},'bizinfo',${relatedSourceId},${`이관 ${suffix} 관련 공고 ${index + 1}`},'open',1)`;
    await admin`insert into grant_raw(source,source_id,payload,attachments,raw_hash,status)
      values ('bizinfo',${relatedSourceId},'{}','[]',${relatedRawSha256},'normalized')`;
    await admin`insert into grant_criteria
      (id,grant_id,dimension,operator,value,kind,confidence,source_span,stable_key,needs_review)
      values (${relatedCriterionId},${relatedGrantId},'region','text_only','{"note":"시흥 소재 여부"}',
        'required',.9,'시흥시에 소재한 기업','siheung-location',false)`;
    const relatedSource = await loadDeepAnalysisSourceBinding({ db, grantId: relatedGrantId });
    assert.ok(relatedSource);
    const relatedDefinitionSha256 = questionDefinitionSha256({
      prompt: "현재 시흥시에 등록된 사업장이 있나요?",
      options: [...OPTIONS],
      answerType: "single",
      reusable: "company_fact",
      conditionKey: "siheung_registered_business_location",
      evaluationContractVersion: "confirmation-evaluation-v2",
      sourceRevisionSha256: relatedSource.sourceRevisionSha256,
      sourceRawSha256: relatedSource.sourceRawSha256,
    });
    await admin`insert into grant_confirmation_questions
      (id,grant_id,evaluation_criterion_id,evaluation_contract_version,source_revision_sha256,
       source_raw_sha256,criterion_stable_key,definition_sha256,version,prompt,options,answer_type,
       reusable,condition_key,prompt_ver,provenance)
      values (${relatedQuestionId},${relatedGrantId},${relatedCriterionId},'confirmation-evaluation-v2',
        ${relatedSource.sourceRevisionSha256},${relatedSource.sourceRawSha256},'siheung-location',
        ${relatedDefinitionSha256},1,'현재 시흥시에 등록된 사업장이 있나요?',
        ${JSON.stringify(OPTIONS)}::jsonb,'single','company_fact','siheung_registered_business_location',
        'fixture-v1','{}')`;
    related.push({ grantId: relatedGrantId, criterionId: relatedCriterionId, questionId: relatedQuestionId });
  }
  return {
    grantId,
    memberGrantId,
    criterionId,
    legacyQuestionId,
    otherQuestionId,
    sourceRevisionSha256: source.sourceRevisionSha256,
    sourceRawSha256: source.sourceRawSha256,
    definitionSha256,
    related,
  };
}

function createPlan(fixture: Fixture): LegacyQuestionMigrationReleasePlan {
  const body: LegacyQuestionMigrationReleasePlanBody = {
    schema: LEGACY_QUESTION_MIGRATION_RELEASE_PLAN_SCHEMA,
    authority: {
      status: "offline_write_plan_only",
      serviceDatabaseWritesMade: 0,
      migrationAuthorized: false,
      releaseAuthorized: false,
      promotionAuthorized: false,
      liveQuestionWriteAuthorized: false,
    },
    source: {
      draftSetContentSha256: "1".repeat(64),
      decisionSetContentSha256: "2".repeat(64),
      currentManifestContentSha256: "3".repeat(64),
      currentShadowSnapshotSha256: "4".repeat(64),
    },
    operations: [{
      grantId: fixture.grantId,
      criterionId: fixture.criterionId,
      criterionStableKey: "siheung-location",
      legacyQuestion: {
        id: fixture.legacyQuestionId,
        version: 1,
        definitionSha256: "legacy-v0",
        expectedAnswerCount: 0,
      },
      question: {
        definitionSha256: fixture.definitionSha256,
        sourceRevisionSha256: fixture.sourceRevisionSha256,
        sourceRawSha256: fixture.sourceRawSha256,
        criterionStableKey: "siheung-location",
        criterionRef: {
          dimension: "region",
          kind: "required",
          sourceSpanHash: sourceSpanHash("시흥시에 소재한 기업")!,
        },
        prompt: "현재 시흥시에 등록된 사업장이 있나요?",
        options: OPTIONS,
        answerType: "single",
        reusable: "company_fact",
        conditionKey: "siheung_registered_business_location",
        evaluationContractVersion: "confirmation-evaluation-v2",
        promptVer: LEGACY_QUESTION_MIGRATION_RELEASE_PROMPT_VERSION,
        supersedesQuestionId: fixture.legacyQuestionId,
        minimumVersion: 2,
        provenance: {
          schema: "legacy-question-migration-provenance-v1",
          draftSetContentSha256: "1".repeat(64),
          decisionSetContentSha256: "2".repeat(64),
          packetContentSha256: "5".repeat(64),
          candidateSha256: "6".repeat(64),
          reviewerEmail: "reviewer@example.invalid",
          reviewedAt: "2026-09-22T00:00:00.000Z",
        },
      },
      retireLegacy: {
        questionId: fixture.legacyQuestionId,
        invalidationReason: "legacy_question_migrated_to_v2",
      },
    }],
    holds: [],
    inheritedNextWorkCount: 0,
  };
  return {
    ...body,
    contentSha256: createHash("sha256")
      .update(canonicalLegacyQuestionMigrationReviewJson(body))
      .digest("hex"),
  };
}
