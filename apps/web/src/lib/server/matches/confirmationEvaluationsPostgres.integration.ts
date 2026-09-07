import assert from "node:assert/strict";
import type postgres from "postgres";
import postgresClient from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { NormalizedGrant } from "@cunote/contracts";
import { toMatchCard } from "@cunote/core";
import * as schema from "../db/schema";
import type { CunoteDb } from "../db/client";
import { createDrizzlePromotionPort } from "../analysis-lab/promote-cli";
import { planGrantPromotion, type GrantPromotionPlan } from "../analysis-lab/promote";
import type { LabCriterion, LabReview, LabRun } from "../analysis-lab/lab-contract";
import {
  buildManualConfirmationEvaluationsArtifact,
  buildManualConfirmationEvaluationsRevisionArtifact,
  manualConfirmationEvaluationSelectionForArtifact,
  type ManualConfirmationEvaluationsArtifact,
  type SelectedManualConfirmationEvaluations,
} from "../analysis-lab/manual-confirmation-evaluations";
import { restoreBeforeSnapshot } from "../analysis-lab/promotion-rollback";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
} from "../analysis-serving/promotionSnapshot";
import {
  listGrantConfirmations,
  submitGrantConfirmations,
} from "./grantConfirmations";
import { refreshMatchStates } from "./matchStateRefresh";
import {
  loadDeepAnalysisSourceBinding,
} from "../deep-analysis/prepareInput";
import { createDrizzleRepositories } from "../repositories/drizzle";

const noopRecalculate = async () => ({
  match: null,
  refresh: { plannedCount: 0, savedCount: 0 },
});

/** 새 Unix-socket cluster에서만 실행하는 v2 ledger/RLS/lock 통합검사. */
export async function verifyConfirmationEvaluationsPostgres(input: {
  admin: postgres.Sql;
  client: postgres.Sql;
  socket: string;
  companyId: string;
  userId: string;
  viewerId: string;
}) {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  const db = drizzle(input.admin, { schema });
  const grantId = crypto.randomUUID();
  const otherGrantId = crypto.randomUUID();
  const criterionId = crypto.randomUUID();
  const otherCriterionId = crypto.randomUUID();
  const questionId = crypto.randomUUID();
  const sourceId = `confirmation-${grantId}`;
  const sourceRawSha256 = "1".repeat(64);
  await input.admin`insert into grants(id,source,source_id,title,status,overall_confidence)
    values (${grantId},'bizinfo',${sourceId},'확인 왕복 공고','open',1),
           (${otherGrantId},'bizinfo',${`other-${sourceId}`},'다른 공고','open',1)`;
  await input.admin`insert into grant_raw(source,source_id,payload,attachments,raw_hash,status)
    values ('bizinfo',${sourceId},'{}','[]',${sourceRawSha256},'normalized')`;
  await input.admin`insert into grant_criteria
    (id,grant_id,dimension,operator,value,kind,confidence,source_span,stable_key,needs_review)
    values (${criterionId},${grantId},'other','text_only','{"note":"직접 확인"}','required',.9,'직접 확인해야 하는 조건','criterion-main',false),
           (${otherCriterionId},${otherGrantId},'other','text_only','{"note":"다른 공고"}','required',.9,'다른 공고 조건','criterion-other',false)`;
  const source = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(source);
  const definitionSha256 = "2".repeat(64);
  const options = [
    { value: "yes", label: "충족해요", evaluation: "satisfied" },
    { value: "no", label: "충족하지 않아요", evaluation: "unsatisfied" },
    { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" },
  ];
  await input.admin`insert into grant_confirmation_questions
    (id,grant_id,grant_criteria_id,evaluation_criterion_id,evaluation_contract_version,
     source_revision_sha256,source_raw_sha256,criterion_stable_key,definition_sha256,version,
     prompt,options,answer_type,reusable,prompt_ver,provenance)
    values (${questionId},${grantId},null,${criterionId},'confirmation-evaluation-v2',
      ${source.sourceRevisionSha256},${source.sourceRawSha256},'criterion-main',${definitionSha256},1,
      '이 조건을 충족하나요?',${JSON.stringify(options)}::jsonb,'single','per_notice','manual-v1','{}')`;

  await assert.rejects(
    () => input.admin`insert into grant_confirmation_questions
      (grant_id,grant_criteria_id,evaluation_criterion_id,evaluation_contract_version,
       criterion_stable_key,definition_sha256,prompt,options,answer_type,reusable,prompt_ver,provenance)
      values (${grantId},null,${criterionId},'confirmation-evaluation-v2','partial-v2',${"3".repeat(64)},
       '부분행',${JSON.stringify(options)}::jsonb,'single','per_notice','manual-v1','{}')`,
    /evaluation_contract_check/,
  );
  await assert.rejects(
    () => input.admin`insert into grant_confirmation_questions
      (grant_id,grant_criteria_id,evaluation_criterion_id,evaluation_contract_version,
       source_revision_sha256,source_raw_sha256,criterion_stable_key,definition_sha256,
       prompt,options,answer_type,reusable,prompt_ver,provenance)
      values (${grantId},null,${otherCriterionId},'confirmation-evaluation-v2',
       ${source.sourceRevisionSha256},${source.sourceRawSha256},'wrong-grant',${"4".repeat(64)},
       '잘못된 앵커',${JSON.stringify(options)}::jsonb,'single','per_notice','manual-v1','{}')`,
    /must belong to the same grant/,
  );

  const binding = {
    contractVersion: "confirmation-evaluation-v2" as const,
    criterionId,
    sourceRevisionSha256: source.sourceRevisionSha256,
    sourceRawSha256: source.sourceRawSha256,
    definitionSha256,
    questionVersion: 1,
  };
  const saved = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId, values: ["yes"], binding, expectedAnswerRevision: 0 }],
  }, { db, recalculate: noopRecalculate });
  assert.equal(saved.saved[0]?.evaluation, "satisfied");
  assert.equal(saved.saved[0]?.answerRevision, 1);
  const promotionPort = createDrizzlePromotionPort(db, []);
  const firstPlan = confirmationPromotionPlan({
    grantId,
    sourceRevisionSha256: source.sourceRevisionSha256,
    sourceRawSha256: source.sourceRawSha256,
    definitionSha256,
    prompt: "이 조건을 충족하나요?",
    options,
  });
  const samePublication = await promotionPort.publishGrant(firstPlan);
  assert.equal(samePublication.questionsUpdated, 1);
  const [sameQuestion] = await input.admin`select id,version,invalidated_at from grant_confirmation_questions where grant_id=${grantId} and invalidated_at is null`;
  assert.equal(sameQuestion!.id, questionId, "같은 source+definition 재발행은 question id를 보존한다");
  assert.equal(sameQuestion!.version, 1);
  assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId }, db)).answers[0]?.answerRevision, 1);
  await assertEvaluationRoundTrip({ db, companyId: input.companyId, grantId, sourceId, criterionId, evaluation: "satisfied" });

  // 실제 manual revision artifact → 순수 plan → 실제 publisher → rollback 왕복.
  // r2는 질문 수정+추가, r3는 전량 철회이며 기존 answer 행과 rollback baseline은 보존한다.
  const beforeManualRevisions = await loadPromotionGrantSnapshot(db, grantId, []);
  const beforeManualRevisionsSha256 = promotionGrantSnapshotStateSha256(beforeManualRevisions);
  const revisionFixture = buildManualRevisionFixture({
    grantId,
    sourceRevisionSha256: source.sourceRevisionSha256,
  });
  await promotionPort.publishGrant(revisionFixture.revision1Plan);
  assert.equal((await activeV2Questions(input.admin, grantId)).length, 1);
  await promotionPort.publishGrant(revisionFixture.revision2Plan);
  const revision2Questions = await activeV2Questions(input.admin, grantId);
  assert.equal(revision2Questions.length, 2);
  assert.ok(revision2Questions.some((row) => row.prompt === "수정한 필수 질문"));
  assert.ok(revision2Questions.some((row) => row.prompt === "추가한 우대 질문"));
  await promotionPort.publishGrant(revisionFixture.withdrawAllPlan);
  assert.equal((await activeV2Questions(input.admin, grantId)).length, 0);
  assert.equal(
    (await input.admin`select question_id from company_grant_confirmations where question_id=${questionId}`).length,
    1,
    "질문 revision 발행/철회 중 기존 답변 원장은 삭제하지 않는다",
  );
  await db.transaction((tx) => restoreBeforeSnapshot(tx, beforeManualRevisions));
  assert.equal(
    promotionGrantSnapshotStateSha256(await loadPromotionGrantSnapshot(db, grantId, [])),
    beforeManualRevisionsSha256,
    "rollback은 revision 발행 전 질문 snapshot을 exact 복원한다",
  );
  assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId }, db)).answers[0]?.answerRevision, 1);

  await assert.rejects(() => submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId, values: ["no"], binding, expectedAnswerRevision: 0 }],
  }, { db, recalculate: noopRecalculate }), { code: "confirmation_answer_conflict" });
  const unsatisfied = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId, values: ["no"], binding, expectedAnswerRevision: 1 }],
  }, { db, recalculate: noopRecalculate });
  assert.equal(unsatisfied.saved[0]?.answerRevision, 2);
  await assertEvaluationRoundTrip({ db, companyId: input.companyId, grantId, sourceId, criterionId, evaluation: "unsatisfied" });
  const unknown = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId, values: ["unknown"], binding, expectedAnswerRevision: 2 }],
  }, { db, recalculate: noopRecalculate });
  assert.equal(unknown.saved[0]?.answerRevision, 3);
  await assertEvaluationRoundTrip({ db, companyId: input.companyId, grantId, sourceId, criterionId, evaluation: "unknown" });

  await input.client.begin(async (tx) => {
    await tx`select set_config('app.current_user_id',${input.userId},true)`;
    assert.equal((await tx`select question_id from company_grant_confirmations where company_id=${input.companyId}`).length, 1);
    assert.equal((await tx`select id from grant_confirmation_questions where id=${questionId}`).length, 1);
    const directUpdate = await tx`update company_grant_confirmations set evaluation='unsatisfied' where question_id=${questionId} returning question_id`;
    assert.equal(directUpdate.length, 0, "일반 제품 role은 서버 검증을 우회해 답변을 갱신할 수 없다");
  });
  const outsiderId = crypto.randomUUID();
  await input.admin`insert into users(id,email) values (${outsiderId},${`${outsiderId}@example.invalid`})`;
  await input.client.begin(async (tx) => {
    await tx`select set_config('app.current_user_id',${outsiderId},true)`;
    assert.equal((await tx`select question_id from company_grant_confirmations`).length, 0);
    assert.equal((await tx`select id from grant_confirmation_questions where id=${questionId}`).length, 1);
  });
  await assert.rejects(() => input.client.begin(async (tx) => {
    await tx`select set_config('app.current_user_id',${outsiderId},true)`;
    await tx`insert into company_grant_confirmations(company_id,grant_id,question_id,answer,disqualified)
      values (${input.companyId},${grantId},${questionId},'{"values":["yes"]}',false)`;
  }), /row-level security/);

  // raw-only drift는 enqueue/job과 무관하게 GET/PUT/reader에서 즉시 stale다.
  await input.admin`update grant_raw set raw_hash=${"5".repeat(64)} where source='bizinfo' and source_id=${sourceId}`;
  assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId }, db)).questions.length, 0);
  await assert.rejects(() => submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId, values: ["yes"], binding, expectedAnswerRevision: 3 }],
  }, { db, recalculate: noopRecalculate }), { code: "confirmation_source_stale" });
  const afterRaw = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(afterRaw);
  assert.notEqual(afterRaw.sourceRevisionSha256, source.sourceRevisionSha256);

  // 새 source는 실제 publication port에서 새 question id/version으로 재확인하며 기존 답변은 보존한다.
  const definitionV2 = "6".repeat(64);
  const secondPlan = confirmationPromotionPlan({
    grantId,
    sourceRevisionSha256: afterRaw.sourceRevisionSha256,
    sourceRawSha256: afterRaw.sourceRawSha256,
    definitionSha256: definitionV2,
    prompt: "이 조건을 다시 확인하나요?",
    options,
  });
  const changedPublication = await promotionPort.publishGrant(secondPlan);
  assert.equal(changedPublication.questionsInserted, 1);
  assert.equal(changedPublication.questionsInvalidated, 0, "교체 질문은 superseded 집계로 별도 처리된다");
  const [questionV2] = await input.admin`select id,version,supersedes_question_id from grant_confirmation_questions where grant_id=${grantId} and invalidated_at is null`;
  const questionV2Id = String(questionV2!.id);
  assert.notEqual(questionV2Id, questionId);
  assert.equal(questionV2!.version, 2);
  assert.equal(questionV2!.supersedes_question_id, questionId);
  assert.equal((await input.admin`select question_id from company_grant_confirmations where question_id=${questionId}`).length, 1);
  const bindingV2 = { ...binding, sourceRevisionSha256: afterRaw.sourceRevisionSha256, sourceRawSha256: afterRaw.sourceRawSha256, definitionSha256: definitionV2, questionVersion: 2 };
  const resaved = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId: questionV2Id, values: ["unknown"], binding: bindingV2, expectedAnswerRevision: 0 }],
  }, { db, recalculate: noopRecalculate });
  assert.equal(resaved.saved[0]?.evaluation, "unknown");
  await assertEvaluationRoundTrip({ db, companyId: input.companyId, grantId, sourceId, criterionId, evaluation: "unknown" });

  // 실제 publisher로 같은 question을 재발행하면 새 답변도 그대로 보존한다.
  await promotionPort.publishGrant(secondPlan);
  assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId }, db)).answers[0]?.answerRevision, 1);

  // 실제 rollback 복원 코어는 v2 anchor/질문 ID/answer binding을 before snapshot으로 되돌린다.
  const beforeReplacement = await loadPromotionGrantSnapshot(db, grantId, []);
  const beforeReplacementSha256 = promotionGrantSnapshotStateSha256(beforeReplacement);
  const thirdPlan = confirmationPromotionPlan({
    grantId,
    sourceRevisionSha256: afterRaw.sourceRevisionSha256,
    sourceRawSha256: afterRaw.sourceRawSha256,
    definitionSha256: "a".repeat(64),
    prompt: "질문 문구가 바뀌었나요?",
    options,
  });
  await promotionPort.publishGrant(thirdPlan);
  assert.notEqual(
    promotionGrantSnapshotStateSha256(await loadPromotionGrantSnapshot(db, grantId, [])),
    beforeReplacementSha256,
  );
  await db.transaction((tx) => restoreBeforeSnapshot(tx, beforeReplacement));
  const restored = await loadPromotionGrantSnapshot(db, grantId, []);
  assert.equal(promotionGrantSnapshotStateSha256(restored), beforeReplacementSha256);
  assert.equal(restored.questions.find((question) => question.id === questionV2Id)?.invalidatedAt, null);
  assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId }, db)).answers[0]?.answerRevision, 1);

  // attachment inventory만 바뀌어도 DB-only source fingerprint가 바뀌고 질문은 숨겨진다.
  await input.admin`insert into grant_attachment_archives(source,source_id,filename,source_uri,sha256,conversion_status)
    values ('bizinfo',${sourceId},'new.pdf','https://example.invalid/new.pdf',${"7".repeat(64)},'archived')`;
  const afterAttachment = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(afterAttachment);
  assert.notEqual(afterAttachment.sourceRevisionSha256, afterRaw.sourceRevisionSha256);
  assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId }, db)).questions.length, 0);

  // role revoke가 먼저 잠그면 저장은 대기 후 viewer를 재조회해 거부한다.
  const raceQuestionId = crypto.randomUUID();
  await input.admin`delete from grant_attachment_archives where source='bizinfo' and source_id=${sourceId}`;
  const raceSource = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(raceSource);
  await input.admin`insert into grant_confirmation_questions
    (id,grant_id,grant_criteria_id,evaluation_criterion_id,evaluation_contract_version,
     source_revision_sha256,source_raw_sha256,criterion_stable_key,definition_sha256,version,
     prompt,options,answer_type,reusable,prompt_ver,provenance)
    values (${raceQuestionId},${grantId},null,${criterionId},'confirmation-evaluation-v2',
      ${raceSource.sourceRevisionSha256},${raceSource.sourceRawSha256},'criterion-race',${"8".repeat(64)},1,
      '경합 질문',${JSON.stringify(options)}::jsonb,'single','per_notice','manual-v1','{}')`;
  const blocker = postgresClient({ host: input.socket, database: "postgres", username: "postgres", prepare: false, max: 1 });
  const releaseRole = deferred<void>();
  const roleLocked = deferred<void>();
  const revoke = blocker.begin(async (tx) => {
    await tx`update user_company set role='viewer' where user_id=${input.userId} and company_id=${input.companyId}`;
    roleLocked.resolve();
    await releaseRole.promise;
  });
  await roleLocked.promise;
  const raceBinding = { ...binding, sourceRevisionSha256: raceSource.sourceRevisionSha256, sourceRawSha256: raceSource.sourceRawSha256, definitionSha256: "8".repeat(64) };
  const revokeSave = submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId: raceQuestionId, values: ["yes"], binding: raceBinding, expectedAnswerRevision: 0 }],
  }, { db, recalculate: noopRecalculate });
  assert.equal(await settlementWithin(revokeSave, 40), "pending");
  releaseRole.resolve();
  await revoke;
  await assert.rejects(() => revokeSave, { code: "company_write_forbidden" });
  await input.admin`update user_company set role='owner' where user_id=${input.userId} and company_id=${input.companyId}`;

  // question replacement가 publication lock을 먼저 가지면 저장은 대기 후 invalidation을 본다.
  const releaseQuestion = deferred<void>();
  const questionLocked = deferred<void>();
  const replace = blocker.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext(${`cunote:grant-publication:${grantId}`}))`;
    await tx`update grant_confirmation_questions set evaluation_criterion_id=null,invalidated_at=now(),invalidation_reason='test_replaced' where id=${raceQuestionId}`;
    questionLocked.resolve();
    await releaseQuestion.promise;
  });
  await questionLocked.promise;
  const replaceSave = submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{ questionId: raceQuestionId, values: ["yes"], binding: raceBinding, expectedAnswerRevision: 0 }],
  }, { db, recalculate: noopRecalculate });
  assert.equal(await settlementWithin(replaceSave, 40), "pending");
  releaseQuestion.resolve();
  await replace;
  await assert.rejects(() => replaceSave, { code: "confirmation_questions_not_found" });
  await blocker.end({ timeout: 5 });

  const detachCriterionId = crypto.randomUUID();
  const detachQuestionId = crypto.randomUUID();
  await input.admin`insert into grant_criteria
    (id,grant_id,dimension,operator,value,kind,confidence,source_span,stable_key,needs_review)
    values (${detachCriterionId},${grantId},'other','text_only','{}','required',.9,'삭제 검증','detach',false)`;
  await input.admin`insert into grant_confirmation_questions
    (id,grant_id,grant_criteria_id,evaluation_criterion_id,evaluation_contract_version,
     source_revision_sha256,source_raw_sha256,criterion_stable_key,definition_sha256,version,
     prompt,options,answer_type,reusable,prompt_ver,provenance)
    values (${detachQuestionId},${grantId},null,${detachCriterionId},'confirmation-evaluation-v2',
      ${raceSource.sourceRevisionSha256},${raceSource.sourceRawSha256},'detach',${"9".repeat(64)},1,
      '삭제 검증',${JSON.stringify(options)}::jsonb,'single','per_notice','manual-v1','{}')`;
  await input.admin`delete from grant_criteria where id=${detachCriterionId}`;
  const [detached] = await input.admin`select evaluation_criterion_id,invalidated_at from grant_confirmation_questions where id=${detachQuestionId}`;
  assert.equal(detached!.evaluation_criterion_id, null);
  assert.ok(detached!.invalidated_at);

  console.log("PASS: confirmation v2 migration, publication/rollback, repository→matcher/card roundtrip, RLS, CAS, source/attachment drift and lock races");
}

function confirmationPromotionPlan(input: {
  grantId: string;
  sourceRevisionSha256: string;
  sourceRawSha256: string;
  definitionSha256: string;
  prompt: string;
  options: Array<{ value: string; label: string; evaluation: string }>;
}): GrantPromotionPlan {
  return {
    grantId: input.grantId,
    runId: "run-isolated-confirmation-v2",
    title: "확인 왕복 공고",
    origin: "human",
    auditState: "human_reviewed",
    criteria: [{
      dimension: "other",
      operator: "text_only",
      value: { note: "직접 확인" },
      kind: "required",
      confidence: 0.9,
      source_span: "직접 확인해야 하는 조건",
      needs_review: false,
    }],
    criterionIndexByPosition: [0],
    criterionStableKeys: ["criterion-main"],
    resolutions: [],
    conversion: {} as GrantPromotionPlan["conversion"],
    questions: [{
      criteriaPosition: 0,
      criterionIndex: 0,
      prompt: input.prompt,
      options: input.options as GrantPromotionPlan["questions"][number]["options"],
      answerType: "single",
      reusable: "per_notice",
      conditionKey: null,
      promptVer: "lab-manual-confirmation-evaluations-v1",
      inline: false,
      provenance: { runId: "run-isolated-confirmation-v2", auditState: "human_reviewed", criterionIndex: 0 },
      criterionRef: { dimension: "other", kind: "required", sourceSpanHash: null },
      criterionStableKey: "criterion-main",
      definitionSha256: input.definitionSha256,
      resolutionState: "confirmed_correct",
      evaluationContractVersion: "confirmation-evaluation-v2",
      sourceRevisionSha256: input.sourceRevisionSha256,
      sourceRawSha256: input.sourceRawSha256,
    }],
    droppedQuestionCandidates: 0,
  };
}

function buildManualRevisionFixture(input: {
  grantId: string;
  sourceRevisionSha256: string;
}) {
  const criteria: LabCriterion[] = [
    {
      dimension: "other",
      kind: "required",
      operator: "text_only",
      value: { note: "직접 확인" },
      confidence: 0.9,
      sourceSpan: "직접 확인해야 하는 조건",
      spanVerified: true,
      note: null,
    },
    {
      dimension: "other",
      kind: "preferred",
      operator: "text_only",
      value: { note: "우대 확인" },
      confidence: 0.9,
      sourceSpan: "우대 여부를 직접 확인하는 조건",
      spanVerified: true,
      note: null,
    },
  ];
  const run: LabRun = {
    runId: "run-2026-09-08T000000.000Z-db1234",
    grantId: input.grantId,
    source: "bizinfo",
    sourceId: `confirmation-${input.grantId}`,
    title: "확인 왕복 공고",
    model: "manual-fixture",
    promptVersion: "manual-fixture-v1",
    startedAt: "2026-09-08T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: "e".repeat(64),
    sourceRevisionSha256: input.sourceRevisionSha256,
    usage: null,
    costUsd: null,
    analysisMarkdown: "",
    programIntent: null,
    criteria,
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    primaryValidationOutcome: "publishable",
    matchingReadiness: "conditional",
    error: null,
  };
  const review: LabReview = {
    grantId: input.grantId,
    runId: run.runId,
    reviewerEmail: "reviewer@example.invalid",
    createdAt: "2026-09-08T00:01:00.000Z",
    updatedAt: "2026-09-08T00:01:00.000Z",
    criterionReviews: criteria.map((_, criterionIndex) => ({
      criterionIndex,
      verdict: "correct" as const,
      note: null,
    })),
    axisReviews: [],
    overallNote: null,
  };
  const answerOptions = [
    { value: "yes", label: "충족해요", evaluation: "satisfied" as const },
    { value: "no", label: "충족하지 않아요", evaluation: "unsatisfied" as const },
    { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" as const },
  ];
  const revision1 = buildManualConfirmationEvaluationsArtifact({
    run,
    review,
    questionAuthorEmail: "author@example.invalid",
    createdAt: "2026-09-08T00:02:00.000Z",
    items: [{ criterionIndex: 0, resolutionScope: "per_notice", prompt: "최초 필수 질문", options: answerOptions }],
  });
  const selected1 = selectedManual(revision1);
  const revision2 = buildManualConfirmationEvaluationsRevisionArtifact({
    run,
    review,
    parent: selected1,
    questionAuthorEmail: "author@example.invalid",
    createdAt: "2026-09-08T00:03:00.000Z",
    intent: "replace",
    withdrawnCriterionIndexes: [],
    items: [
      { criterionIndex: 0, resolutionScope: "per_notice", prompt: "수정한 필수 질문", options: answerOptions },
      { criterionIndex: 1, resolutionScope: "per_notice", prompt: "추가한 우대 질문", options: answerOptions },
    ],
  });
  const selected2 = selectedManual(revision2);
  const revision3 = buildManualConfirmationEvaluationsRevisionArtifact({
    run,
    review,
    parent: selected2,
    questionAuthorEmail: "author@example.invalid",
    createdAt: "2026-09-08T00:04:00.000Z",
    intent: "withdraw_all",
    withdrawnCriterionIndexes: [0, 1],
    items: [],
  });
  const selected3 = selectedManual(revision3);
  const plan = (selected: SelectedManualConfirmationEvaluations) => planGrantPromotion({
    run,
    review,
    origin: "human",
    sidecar: null,
    manualEvaluationSidecar: selected.artifact,
    manualConfirmationEvaluationSelection: selected.selection,
    sourceRawSha256: "1".repeat(64),
  });
  return {
    revision1Plan: plan(selected1),
    revision2Plan: plan(selected2),
    withdrawAllPlan: plan(selected3),
  };
}

function selectedManual(
  artifact: ManualConfirmationEvaluationsArtifact,
): SelectedManualConfirmationEvaluations {
  return {
    artifact,
    selection: manualConfirmationEvaluationSelectionForArtifact(artifact),
    path: "/tmp/synthetic-manual-confirmation.json",
    legacyShaOnly: false,
  };
}

async function activeV2Questions(sql: postgres.Sql, grantId: string) {
  return sql`select id,prompt from grant_confirmation_questions
    where grant_id=${grantId}
      and evaluation_contract_version='confirmation-evaluation-v2'
      and invalidated_at is null
    order by prompt`;
}

async function assertEvaluationRoundTrip(input: {
  db: CunoteDb;
  companyId: string;
  grantId: string;
  sourceId: string;
  criterionId: string;
  evaluation: "satisfied" | "unsatisfied" | "unknown";
}) {
  const repositories = createDrizzleRepositories({ dialect: "drizzle", client: input.db });
  const normalizedGrant: NormalizedGrant = {
    raw: {
      source: "bizinfo",
      source_id: input.sourceId,
      payload: {},
      attachments: [],
      status: "normalized",
    },
    grant: {
      id: input.grantId,
      source: "bizinfo",
      source_id: input.sourceId,
      title: "확인 왕복 공고",
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria: [{
      id: input.criterionId,
      grant_id: input.grantId,
      dimension: "other",
      operator: "text_only",
      value: { note: "직접 확인" },
      kind: "required",
      confidence: 0.9,
      source_span: "직접 확인해야 하는 조건",
    }],
  };
  const confirmations = await repositories.matches.listCriterionConfirmations!({
    companyId: input.companyId,
    grantIds: [input.grantId],
  });
  assert.equal(confirmations.get(input.grantId)?.[0]?.evaluation, input.evaluation);
  const refreshed = await refreshMatchStates({
    repositories,
    companyId: input.companyId,
    company: {},
    grants: [normalizedGrant],
    asOf: new Date("2026-09-07T00:00:00.000Z"),
    write: false,
  });
  const match = refreshed.plan.states[0]!.match;
  const trace = match.rule_trace[0]!;
  const expectedResult = input.evaluation === "satisfied"
    ? "pass"
    : input.evaluation === "unsatisfied"
      ? "fail"
      : "unknown";
  assert.equal(trace.result, expectedResult);
  assert.equal(trace.resolution, input.evaluation === "unknown" ? undefined : "confirmed_by_user");
  const card = toMatchCard({ item: normalizedGrant, match });
  assert.equal(card.ruleTrace[0]?.criterionId, input.criterionId);
  assert.equal(card.ruleTrace[0]?.result, input.evaluation === "unknown" ? "text_only" : expectedResult);
  assert.equal(card.ruleTrace[0]?.resolution, input.evaluation === "unknown" ? undefined : "confirmed_by_user");
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function settlementWithin(value: Promise<unknown>, milliseconds: number): Promise<"settled" | "pending"> {
  return Promise.race([
    value.then(() => "settled" as const, () => "settled" as const),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), milliseconds)),
  ]);
}
