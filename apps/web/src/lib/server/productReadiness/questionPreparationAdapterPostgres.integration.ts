import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { NormalizedGrant } from "@cunote/contracts";
import type { KStartupAnnouncement } from "@cunote/core";
import { ANALYSIS_LAB_PROMPT_VERSION, type LabReview, type LabRun } from "../analysis-lab/lab-contract";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadDeepAnalysisSourceBinding } from "../deep-analysis/prepareInput";
import {
  createPromotionReleaseManifest,
  hashFile,
  planSha256,
  promotionReleaseArtifactPath,
  promotionReleaseDir,
  VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  writeImmutablePromotionArtifact,
  type PromotionReleaseManifest,
  type PromotionReleasePlanItem,
} from "../analysis-lab/promotion-release";
import {
  questionDefinitionSha256,
  sourceSpanHash,
  type GrantPromotionPlan,
} from "../analysis-lab/promote";
import { applyApprovedPromotionCanary } from "../analysis-lab/promote-cli";
import {
  listGrantConfirmations,
  recalculateGrantMatch,
  submitGrantConfirmations,
  withdrawGrantConfirmation,
} from "../matches/grantConfirmations";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { publishKStartupGrants } from "../ingestion/kstartupPublisher";
import { createQuestionPreparationFormalFixture } from "./questionPreparationFormalFixture";
import {
  buildManualConfirmationEvaluationsArtifact,
  manualConfirmationEvaluationsFilePath,
  manualConfirmationEvaluationSelectionForArtifact,
  saveManualConfirmationEvaluations,
} from "../analysis-lab/manual-confirmation-evaluations";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotHashes,
  promotionGrantSnapshotStateSha256,
} from "../analysis-lab/promotion-snapshot";
import { loadCurrentGrantReadiness } from "./grantReadinessLoader";
import { assessPublishedGrantSupply, executeApprovedGrantSupply } from "./grantSupply";
import {
  createGrantNextWorkSnapshot,
} from "./grantNextWorkExecution";
import {
  createApprovedQuestionPreparationReleasePort,
  createQuestionPreparationAdapter,
} from "./questionPreparationAdapter";

const OPTIONS = [
  { value: "yes", label: "해당해요", evaluation: "satisfied" as const },
  { value: "no", label: "해당하지 않아요", evaluation: "unsatisfied" as const },
  { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" as const },
];

/** 폐기용 Unix socket DB에서 B→승인 canary→A 왕복을 기존 promotion writer로 검증한다. */
export async function verifyQuestionPreparationAdapterPostgres(input: {
  admin: postgres.Sql;
  socket: string;
  companyId: string;
  userId: string;
}): Promise<void> {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/u);
  const db = drizzle(input.admin, { schema });
  const sourceId = `question-preparation-${crypto.randomUUID()}`;
  const stableKey = "criterion:industry:manual";
  const asOf = new Date("2026-09-22T03:00:00.000Z");

  const entry: NormalizedGrant<KStartupAnnouncement> = {
    raw: {
      source: "kstartup", source_id: sourceId,
      payload: { pbanc_sn: sourceId, intg_pbanc_biz_nm: "질문 준비 격리 검증 공고" },
      attachments: [{ filename: "guide.pdf", url: "https://example.invalid/guide.pdf" }],
      status: "published",
    },
    grant: {
      source: "kstartup", source_id: sourceId, title: "질문 준비 격리 검증 공고",
      apply_start: "2026-09-01T00:00:00.000Z",
      apply_end: "2026-10-01T00:00:00.000Z",
      status: "open", f_regions: [], f_industries: [], f_sizes: [],
      f_founder_traits: [], f_required_certs: [], f_apply_methods: [],
      f_authoring_mode: "unknown", overall_confidence: 1, parser_version: "fixture-v1",
    },
    criteria: [{
      dimension: "industry", operator: "text_only",
      value: { fact_scope: "registered_business", basis_date: "2026-09-22" },
      kind: "required", confidence: 1,
      source_span: "식품·생활용품·가정용품 분야 중소기업",
      raw_text: "식품·생활용품·가정용품 분야 중소기업", source_field: "지원대상",
      needs_review: false, parser_version: "fixture-v1",
    }],
  };
  const publication = await publishKStartupGrants(db, [entry], { collectedAt: asOf });
  assert.equal(publication.revisionCounts.new, 1);
  assert.equal(publication.supplyWorkItems?.[0]?.sourceId, sourceId);
  assert.equal(publication.supplyWorkItems?.[0]?.discoveredBy, "current_state");
  const [publishedGrant] = await input.admin<{ id: string }[]>`select id from grants
    where source='kstartup' and source_id=${sourceId}`;
  assert.ok(publishedGrant);
  const grantId = publishedGrant.id;
  const runId = `run-2026-09-22T030000.000Z-${grantId.replaceAll("-", "").slice(0, 6)}`;
  const [publishedRaw] = await input.admin<{ raw_hash: string }[]>`select raw_hash from grant_raw
    where source='kstartup' and source_id=${sourceId}`;
  assert.ok(publishedRaw);
  const rawSha256 = publishedRaw.raw_hash;
  const [publishedCriterion] = await input.admin<{ id: string }[]>`select id from grant_criteria
    where grant_id=${grantId}`;
  assert.ok(publishedCriterion);
  const criterionId = publishedCriterion.id;
  await input.admin`update grant_criteria set stable_key=${stableKey} where id=${criterionId}`;
  await input.admin`update grant_attachment_archives
    set sha256=${"a".repeat(64)},conversion_status='archived'
    where source='kstartup' and source_id=${sourceId}
      and filename='guide.pdf' and source_uri='https://example.invalid/guide.pdf'`;
  const source = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(source);
  assert.equal(source.sourceRawSha256, rawSha256);
  const reviewedFact = buildSyntheticReviewedCompanyFact({
    grantId, sourceId, runId, sourceRevisionSha256: source.sourceRevisionSha256,
  });
  assert.match(reviewedFact.conditionKey, /^cf2_[0-9a-f]{64}$/u);
  const manualFile = manualConfirmationEvaluationsFilePath("kstartup", sourceId, runId);
  await mkdir(dirname(manualFile), { recursive: true });
  await saveManualConfirmationEvaluations(reviewedFact.artifact, reviewedFact.run, manualFile);
  const formalFixture = await createQuestionPreparationFormalFixture({
    run: reviewedFact.run, review: reviewedFact.review,
    selectedManual: {
      artifact: reviewedFact.artifact, selection: reviewedFact.selection,
      path: "/tmp/synthetic-product-review.json", legacyShaOnly: false,
    },
    sourceRevisionSha256: source.sourceRevisionSha256,
    sourceRawSha256: rawSha256,
  });
  assert.equal(formalFixture.candidate.sourceArtifact.runId, runId);

  const baselinePlan = buildQuestionPreparationFixturePlan({
    grantId,
    runId,
    stableKey,
    sourceRevisionSha256: source.sourceRevisionSha256,
    sourceRawSha256: rawSha256,
    includeQuestion: false,
  });
  const baselineManifest = buildQuestionPreparationFixtureManifest({
    grantId,
    plan: baselinePlan,
    sourceRevisionSha256: source.sourceRevisionSha256,
    before: promotionGrantSnapshotHashes(await loadPromotionGrantSnapshot(db, grantId)),
    releaseId: `question-preparation-parent-${grantId}`,
    includeQuestion: false,
  });
  const baselineSnapshot = await loadPromotionGrantSnapshot(db, grantId);
  await seedQuestionPreparationFixtureAppliedRelease({
    admin: input.admin,
    manifest: baselineManifest,
    snapshot: baselineSnapshot,
    appliedAt: new Date("2026-09-22T00:00:00.000Z"),
  });

  const loadSnapshot = async () => {
    const rows = await loadCurrentGrantReadiness({ db, asOf, limit: 100 });
    const row = rows.find((candidate) => candidate.grantId === grantId);
    assert.ok(row, "격리 공고가 current readiness inventory에 있어야 한다");
    return createGrantNextWorkSnapshot({
      grantId,
      readinessInput: row.input,
      sourceChangeImpact: row.sourceChangeImpact ?? null,
    });
  };
  const before = await loadSnapshot();
  assert.equal(
    before.readiness.category,
    "B",
    `초기 준비도 blocker: ${JSON.stringify(before.readiness.blockerCodes)}`,
  );
  assert.equal(before.nextWork.action, "question_preparation");
  assert.equal(before.readiness.eligibleQuestionCount, 1);
  assert.equal(before.readiness.eligibleQuestionCoveredCount, 0);
  const [beforeSupply] = await assessPublishedGrantSupply({ db, grantIds: [grantId], asOf });
  assert.equal(beforeSupply?.schema, "grant-supply-plan-v1");
  assert.equal(beforeSupply?.schema === "grant-supply-plan-v1" ? beforeSupply.stage : null, "await_approved_release");
  assert.equal(beforeSupply?.schema === "grant-supply-plan-v1" ? beforeSupply.evidenceSha256 : null,
    before.evidenceSha256);

  const beforePromotionSnapshot = await loadPromotionGrantSnapshot(db, grantId);
  const releasePlan = buildQuestionPreparationFixturePlan({
    grantId,
    runId,
    stableKey,
    sourceRevisionSha256: source.sourceRevisionSha256,
    sourceRawSha256: rawSha256,
    includeQuestion: true,
    resolutionScope: "company_fact",
    conditionKey: reviewedFact.conditionKey,
    manualSelection: reviewedFact.selection,
  });
  const releaseId = `question-preparation-release-${grantId}`;
  const fixtureManifest = buildQuestionPreparationFixtureManifest({
    grantId,
    plan: releasePlan,
    sourceRevisionSha256: source.sourceRevisionSha256,
    before: promotionGrantSnapshotHashes(beforePromotionSnapshot),
    releaseId,
    includeQuestion: true,
  });
  const releaseManifest = createPromotionReleaseManifest({
    releaseId, revision: 1, createdAt: fixtureManifest.createdAt,
    gitCommit: fixtureManifest.gitCommit, buildDigest: fixtureManifest.buildDigest,
    cohortLabel: fixtureManifest.cohortLabel, canaryGrantIds: [grantId],
    sourceArtifacts: [formalFixture.candidate.sourceArtifact],
    plans: [{ ...fixtureManifest.plans[0]!, analysisLaunchReadiness: formalFixture.candidate.readiness }],
  });
  const releaseDbId = crypto.randomUUID();
  const releaseItemId = crypto.randomUUID();
  const gateSummary = {
    aggregateSha256: "d".repeat(64),
    shadowSha256: "e".repeat(64),
    dryRunSha256: "f".repeat(64),
  };
  await writeImmutablePromotionArtifact(promotionReleaseArtifactPath(releaseId, "manifest.json"), releaseManifest);
  const approvalFile = promotionReleaseArtifactPath(releaseId, "approval.json");
  await writeImmutablePromotionArtifact(approvalFile, {
    schema: "analysis-lab-promotion-approval-v1", releaseId,
    manifestSha256: releaseManifest.manifestSha256,
    releasePlanSha256: releaseManifest.releasePlanSha256,
    approvedBy: "question-approver", approvedAt: "2026-09-22T00:10:00.000Z",
    ...gateSummary,
  });
  const approvalArtifactSha256 = await hashFile(approvalFile);
  await input.admin`insert into analysis_lab_promotion_releases
    (id,release_id,revision,manifest_sha256,release_plan_sha256,manifest,git_commit,build_digest,
     status,gate_summary,created_by,approved_by,approved_at,approval_artifact_sha256)
    values (${releaseDbId},${releaseId},1,${releaseManifest.manifestSha256},
      ${releaseManifest.releasePlanSha256},${JSON.stringify(releaseManifest)}::jsonb,
      ${releaseManifest.gitCommit},${releaseManifest.buildDigest},'approved',
      ${JSON.stringify(gateSummary)}::jsonb,'question-preparer','question-approver',
      '2026-09-22T00:10:00.000Z',${approvalArtifactSha256})`;
  await input.admin`insert into analysis_lab_promotion_items
    (id,release_db_id,grant_id,run_id,plan_sha256,before_snapshot,before_sha256,status)
    values (${releaseItemId},${releaseDbId},${grantId},${runId},${planSha256(releasePlan)},
      ${JSON.stringify(beforePromotionSnapshot)}::jsonb,
      ${promotionGrantSnapshotStateSha256(beforePromotionSnapshot)},'prepared')`;

  // 격리 의존성 없이 실제 파일 진입점은 이 작업트리에 없는 합성 receipt를 거부한다.
  await assert.rejects(() => applyApprovedPromotionCanary({
    db: db as CunoteDb, releaseId, grantId,
    expectedManifestSha256: releaseManifest.manifestSha256,
    actor: "question-executor",
  }), /승격 source를 현재 검증할 수 없습니다|analysis_launch_unavailable/u);
  assert.equal((await input.admin`select status from analysis_lab_promotion_items
    where id=${releaseItemId}`)[0]?.status, "prepared");

  const unrelatedSocket = await mkdtemp("/tmp/cunote-product-pg-");
  process.env.CUNOTE_PRODUCT_TEST_SOCKET = unrelatedSocket;
  try {
    await assert.rejects(() => applyApprovedPromotionCanary({
      db: db as CunoteDb, releaseId, grantId,
      expectedManifestSha256: releaseManifest.manifestSha256,
      actor: "question-executor", isolatedAnalysisLaunch: formalFixture.dependencies,
    }), /DB socket binding failed/u);
  } finally {
    process.env.CUNOTE_PRODUCT_TEST_SOCKET = input.socket;
    await rm(unrelatedSocket, { recursive: true, force: true });
  }

  const port = createApprovedQuestionPreparationReleasePort(db as CunoteDb, formalFixture.dependencies);
  const adapter = createQuestionPreparationAdapter({
    releaseId,
    expectedManifestSha256: releaseManifest.manifestSha256,
    executedBy: "question-executor",
    port,
  });
  const result = await executeApprovedGrantSupply({
    db,
    grantId,
    expectedEvidenceSha256: before.evidenceSha256,
    asOf,
    adapters: new Map([["question_preparation", adapter]]),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.nextAction, "reuse_ready");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.externalWrites, 1);
  assert.equal((await input.admin`select status from analysis_lab_promotion_items
    where id=${releaseItemId}`)[0]?.status, "applied");
  assert.equal((await input.admin`select status from analysis_lab_promotion_releases
    where id=${releaseDbId}`)[0]?.status, "canary_passed");
  const replay = await applyApprovedPromotionCanary({
    db: db as CunoteDb, releaseId, grantId,
    expectedManifestSha256: releaseManifest.manifestSha256,
    actor: "question-executor", isolatedAnalysisLaunch: formalFixture.dependencies,
  });
  assert.equal(replay.replayed, true);
  assert.equal(replay.externalWrites, 0);
  const after = await loadSnapshot();
  assert.equal(after.readiness.category, "A");
  assert.equal(after.readiness.eligibleQuestionCoveredCount, 1);
  const [afterSupply] = await assessPublishedGrantSupply({ db, grantIds: [grantId], asOf });
  assert.equal(afterSupply?.schema === "grant-supply-plan-v1" ? afterSupply.stage : null, "ready");
  assert.equal((await input.admin`select id from grant_criteria where id=${criterionId}`).length, 1);
  const [question] = await input.admin<{
    id: string;
    evaluation_contract_version: string;
    source_revision_sha256: string;
    source_raw_sha256: string;
    reusable: string;
    condition_key: string | null;
  }[]>`select id,evaluation_contract_version,source_revision_sha256,source_raw_sha256,reusable,condition_key
      from grant_confirmation_questions where grant_id=${grantId} and invalidated_at is null`;
  assert.equal(question?.evaluation_contract_version, "confirmation-evaluation-v2");
  assert.equal(question?.source_revision_sha256, source.sourceRevisionSha256);
  assert.equal(question?.source_raw_sha256, rawSha256);
  assert.equal(question?.reusable, "company_fact");
  assert.equal(question?.condition_key, reviewedFact.conditionKey);

  const relatedGrantIds: string[] = [];
  const negativeGrantIds: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const relatedGrantId = crypto.randomUUID();
    const relatedCriterionId = crypto.randomUUID();
    const relatedQuestionId = crypto.randomUUID();
    const relatedSourceId = `question-preparation-related-${index}-${grantId}`;
    const relatedRawSha256 = String(index + 1).repeat(64);
    const sameMeaning = index < 3;
    const criterionValue = sameMeaning
      ? { fact_scope: "registered_business", basis_date: "2026-09-22" }
      : index === 3 ? { fact_scope: "headquarters", basis_date: "2026-09-22" }
      : index === 4 ? { fact_scope: "registered_business", basis_date: "2026-01-01" }
      : { fact_scope: "registered_business", basis_date: "2026-09-22", fact_kind: "different" };
    await input.admin`insert into grants(id,source,source_id,title,status,overall_confidence)
      values (${relatedGrantId},'bizinfo',${relatedSourceId},'회사 사실 관련 격리 공고','open',1)`;
    await input.admin`insert into grant_raw(source,source_id,payload,attachments,raw_hash,status)
      values ('bizinfo',${relatedSourceId},'{}','[]',${relatedRawSha256},'normalized')`;
    await input.admin`insert into grant_criteria
      (id,grant_id,dimension,operator,value,kind,confidence,source_span,stable_key,needs_review)
      values (${relatedCriterionId},${relatedGrantId},'industry','text_only',
        ${JSON.stringify(criterionValue)}::jsonb,
        'required',1,'식품·생활용품·가정용품 분야 중소기업',${stableKey},false)`;
    const relatedSource = await loadDeepAnalysisSourceBinding({ db, grantId: relatedGrantId });
    assert.ok(relatedSource);
    const definitionSha256 = questionDefinitionSha256({
      prompt: "귀사는 공고에 열거된 업종에 해당하나요?",
      options: OPTIONS,
      answerType: "single",
      reusable: "company_fact",
      conditionKey: reviewedFact.conditionKey,
      evaluationContractVersion: "confirmation-evaluation-v2",
      sourceRevisionSha256: relatedSource.sourceRevisionSha256,
      sourceRawSha256: relatedRawSha256,
    });
    await input.admin`insert into grant_confirmation_questions
      (id,grant_id,evaluation_criterion_id,evaluation_contract_version,source_revision_sha256,
       source_raw_sha256,criterion_stable_key,definition_sha256,version,prompt,options,answer_type,
       reusable,condition_key,prompt_ver,provenance)
      values (${relatedQuestionId},${relatedGrantId},${relatedCriterionId},'confirmation-evaluation-v2',
        ${relatedSource.sourceRevisionSha256},${relatedRawSha256},${stableKey},${definitionSha256},1,
        '귀사는 공고에 열거된 업종에 해당하나요?',${JSON.stringify(OPTIONS)}::jsonb,
        'single','company_fact',${reviewedFact.conditionKey},'fixture-v1','{}')`;
    (sameMeaning ? relatedGrantIds : negativeGrantIds).push(relatedGrantId);
  }

  const initial = await listGrantConfirmations({ companyId: input.companyId, grantId }, db);
  const target = initial.questions.find((entry) => entry.id === question?.id);
  assert.ok(target?.binding, "발행된 신규 회사 사실 질문이 실제 답변 경로에 보여야 한다");
  const repositories = createDrizzleRepositories({ dialect: "drizzle", client: db });
  const recalculation = {
    repositories,
    resolveProfile: async () => ({ profile: {}, stateScope: "company" as const }),
    annotateCards: async <T>(cards: T[]) => cards,
  };
  for (const negativeGrantId of negativeGrantIds) {
    const initialNegative = await recalculateGrantMatch({
      companyId: input.companyId, userId: input.userId, grantId: negativeGrantId,
      questionCount: 1, asOf: new Date(asOf.getTime() - 60_000),
    }, recalculation);
    assert.equal(initialNegative.refresh.status, "succeeded");
  }
  const negativeBefore = await input.admin`select grant_id,eligibility,calculation_as_of from match_state
    where company_id=${input.companyId} and grant_id in (${negativeGrantIds[0]!},
      ${negativeGrantIds[1]!},${negativeGrantIds[2]!}) order by grant_id`;
  assert.equal(negativeBefore.length, 3);
  const saved = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{
      questionId: question!.id,
      values: ["yes"],
      binding: target.binding,
      expectedAnswerRevision: 0,
      expectedCompanyFactRevision: null,
    }],
    asOf,
  }, { db, recalculation });
  assert.equal(saved.refresh.status, "succeeded");
  assert.equal(saved.refresh.savedCount, 4);
  const yesStates = await input.admin`select grant_id,eligibility from match_state
    where company_id=${input.companyId} and grant_id in (${grantId}, ${relatedGrantIds[0]!},
      ${relatedGrantIds[1]!}, ${relatedGrantIds[2]!}) order by grant_id`;
  assert.equal(yesStates.length, 4);
  assert.ok(yesStates.every((state) => state.eligibility === "eligible"));
  assert.deepEqual(await input.admin`select grant_id,eligibility,calculation_as_of from match_state
    where company_id=${input.companyId} and grant_id in (${negativeGrantIds[0]!},
      ${negativeGrantIds[1]!},${negativeGrantIds[2]!}) order by grant_id`, negativeBefore);
  assert.equal((await input.admin`select count(*)::int as count from match_state
    where company_id=${input.companyId} and grant_id in (${grantId}, ${relatedGrantIds[0]!},
      ${relatedGrantIds[1]!}, ${relatedGrantIds[2]!})`)[0]?.count, 4);
  for (const relatedGrantId of relatedGrantIds) {
    assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId: relatedGrantId }, db))
      .answers[0]?.evaluation, "satisfied");
  }
  for (const negativeGrantId of negativeGrantIds) {
    assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId: negativeGrantId }, db))
      .answers.length, 0);
  }
  const changed = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{
      questionId: question!.id,
      values: ["no"],
      binding: target.binding,
      expectedAnswerRevision: saved.saved[0]!.answerRevision!,
      expectedCompanyFactRevision: saved.saved[0]!.companyFactRevision!,
    }],
    asOf: new Date(asOf.getTime() + 60_000),
  }, { db, recalculation });
  assert.equal(changed.refresh.status, "succeeded");
  assert.equal(changed.refresh.savedCount, 4);
  const noStates = await input.admin`select grant_id,eligibility from match_state
    where company_id=${input.companyId} and grant_id in (${grantId}, ${relatedGrantIds[0]!},
      ${relatedGrantIds[1]!}, ${relatedGrantIds[2]!}) order by grant_id`;
  assert.equal(noStates.length, 4);
  assert.ok(noStates.every((state) => state.eligibility === "ineligible"));
  for (const relatedGrantId of relatedGrantIds) {
    assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId: relatedGrantId }, db))
      .answers[0]?.evaluation, "unsatisfied");
  }
  const withdrawn = await withdrawGrantConfirmation({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    questionId: question!.id,
    binding: target.binding,
    expectedAnswerRevision: changed.saved[0]!.answerRevision!,
    expectedCompanyFactRevision: changed.saved[0]!.companyFactRevision!,
    asOf: new Date(asOf.getTime() + 120_000),
  }, { db, recalculation });
  assert.equal(withdrawn.refresh.status, "succeeded");
  assert.equal(withdrawn.refresh.savedCount, 4);
  for (const relatedGrantId of relatedGrantIds) {
    assert.equal((await listGrantConfirmations({ companyId: input.companyId, grantId: relatedGrantId }, db))
      .answers.length, 0);
  }
  // 답변 commit 이후 재계산이 실패해도 성공 영수증을 보존하고 실제 matcher로 재개한다.
  const failedRefresh = await submitGrantConfirmations({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    answers: [{
      questionId: question!.id,
      values: ["yes"],
      binding: target.binding,
      expectedAnswerRevision: withdrawn.saved[0]?.answerRevision ?? 3,
      expectedCompanyFactRevision: null,
    }],
    asOf: new Date(asOf.getTime() + 180_000),
  }, { db, recalculate: async () => { throw new Error("synthetic refresh outage"); } });
  assert.equal(failedRefresh.saved.length, 1);
  assert.equal(failedRefresh.refresh.status, "failed");
  const retried = await recalculateGrantMatch({
    companyId: input.companyId,
    userId: input.userId,
    grantId,
    relatedGrantIds,
    questionCount: 1,
    asOf: new Date(asOf.getTime() + 181_000),
  }, recalculation);
  assert.equal(retried.refresh.status, "succeeded");
  assert.equal(retried.refresh.savedCount, 4);
  assert.deepEqual(await input.admin`select grant_id,eligibility,calculation_as_of from match_state
    where company_id=${input.companyId} and grant_id in (${negativeGrantIds[0]!},
      ${negativeGrantIds[1]!},${negativeGrantIds[2]!}) order by grant_id`, negativeBefore);
  console.log("PASS: 신규 company_fact 답변·수정·철회와 실제 matcher match_state 저장, 실패 후 재평가 재개");
  await rm(promotionReleaseDir(releaseId), { recursive: true, force: true });
  await rm(dirname(manualFile), { recursive: true, force: true });
  await rm(formalFixture.root, { recursive: true, force: true });
}

export function buildQuestionPreparationFixturePlan(input: {
  grantId: string;
  runId: string;
  stableKey: string;
  sourceRevisionSha256: string;
  sourceRawSha256: string;
  includeQuestion: boolean;
  resolutionScope?: "per_notice" | "company_fact";
  conditionKey?: string;
  manualSelection?: ReturnType<typeof manualConfirmationEvaluationSelectionForArtifact>;
}): GrantPromotionPlan {
  const sourceSpan = "식품·생활용품·가정용품 분야 중소기업";
  const criterion = {
    id: `${input.grantId}:llm-1`,
    dimension: "industry" as const,
    operator: "text_only" as const,
    value: { fact_scope: "registered_business", basis_date: "2026-09-22" },
    kind: "required" as const,
    confidence: 1,
    source_span: sourceSpan,
    raw_text: sourceSpan,
    source_field: "지원대상",
    needs_review: false,
    parser_version: "fixture-v1",
  };
  const base = {
    criteriaPosition: 0,
    criterionIndex: 0,
    prompt: "귀사는 공고에 열거된 업종에 해당하나요?",
    options: OPTIONS,
    answerType: "single" as const,
    reusable: input.resolutionScope ?? "per_notice",
    conditionKey: input.resolutionScope === "company_fact" ? input.conditionKey ?? null : null,
    promptVer: "manual-confirmation-evaluations-revision-v1",
    inline: false,
    provenance: {
      runId: input.runId,
      auditState: "analysis_launch_independent_review" as const,
      criterionIndex: 0,
    },
    criterionRef: {
      dimension: "industry",
      kind: "required",
      sourceSpanHash: sourceSpanHash(sourceSpan),
    },
    criterionStableKey: input.stableKey,
    resolutionState: "analysis_launch_reviewed" as const,
    evaluationContractVersion: "confirmation-evaluation-v2" as const,
    sourceRevisionSha256: input.sourceRevisionSha256,
    sourceRawSha256: input.sourceRawSha256,
  };
  return {
    grantId: input.grantId,
    runId: input.runId,
    title: "질문 준비 격리 검증 공고",
    origin: "analysis_launch",
    auditState: "analysis_launch_independent_review",
    criteria: [criterion],
    criterionIndexByPosition: [0],
    criterionStableKeys: [input.stableKey],
    resolutions: [{
      criterionIndex: 0,
      state: "analysis_launch_reviewed",
      decidedBy: "d".repeat(64),
      note: null,
    }],
    conversion: {
      grantId: input.grantId,
      runId: input.runId,
      verdicts: { correct: 1, needs_edit: 0, wrong: 0, unsure: 0 },
      missedConditions: 0,
      inputRows: 1,
      converted: 1,
      downgraded: 0,
      dropped: 0,
      error: null,
    },
    scopeRejectedCriterionIndexes: [],
    questions: input.includeQuestion ? [{
      ...base,
      definitionSha256: questionDefinitionSha256(base),
    }] : [],
    ...(input.includeQuestion ? {
      manualConfirmationEvaluationSelection: input.manualSelection ?? {
        schema: "manual-confirmation-evaluation-selection-v1" as const,
        revision: 1,
        artifactSha256: "c".repeat(64),
        itemCount: 1,
        intent: "active" as const,
      },
    } : {}),
    droppedQuestionCandidates: 0,
  };
}

export function buildSyntheticReviewedCompanyFact(input: {
  grantId: string;
  sourceId: string;
  runId: string;
  sourceRevisionSha256: string;
}) {
  const run: LabRun = {
    runId: input.runId, grantId: input.grantId, source: "kstartup", sourceId: input.sourceId,
    title: "질문 준비 격리 검증 공고", model: "claude-opus-5", transport: "claude-cli",
    promptVersion: ANALYSIS_LAB_PROMPT_VERSION, startedAt: "2026-09-22T03:00:00.000Z", durationMs: 1,
    inputBlocks: [], inputTotalChars: 1, inputSha256: "1".repeat(64),
    sourceRevisionSha256: input.sourceRevisionSha256,
    attachmentManifestSha256: "f".repeat(64), usage: null, costUsd: null,
    analysisMarkdown: "합성 검수 fixture", programIntent: null,
    criteria: [{
      dimension: "industry", kind: "required", operator: "text_only",
      value: { fact_scope: "registered_business", basis_date: "2026-09-22" },
      confidence: 1, sourceSpan: "식품·생활용품·가정용품 분야 중소기업",
      spanVerified: true, note: null,
    }],
    axisAssessments: [{
      dimension: "size", status: "ambiguous", confidence: 0.5,
      comment: "합성 검수 fixture의 미해소 축",
    }],
    taxonomyProposals: [], dimensionDiffs: [], primaryRepairCount: 0,
    primaryValidationOutcome: "publishable", matchingReadiness: "conditional",
    primaryRepairProvenance: {
      deterministicPrimaryRepairCount: 0, modelPrimaryRepairCount: 0,
      newIssueAfterRepairCount: 0, blockingNewIssueAfterRepairCount: 0,
      sourceIncompleteIssueAfterRepairCount: 0,
    },
    error: null,
  };
  const review: LabReview = {
    grantId: input.grantId, runId: input.runId,
    reviewerEmail: "reviewer@example.invalid",
    createdAt: "2026-09-22T03:01:00.000Z", updatedAt: "2026-09-22T03:01:00.000Z",
    criterionReviews: [{ criterionIndex: 0, verdict: "correct", note: null }],
    axisReviews: [], overallNote: null,
  };
  const reviewArtifactSha256 = createHash("sha256")
    .update(`${JSON.stringify(review, null, 2)}\n`).digest("hex");
  const artifact = buildManualConfirmationEvaluationsArtifact({
    run, review, createdAt: "2026-09-22T03:02:00.000Z", reviewArtifactSha256,
    questionAuthorEmail: "author@example.invalid",
    items: [{
      criterionIndex: 0, resolutionScope: "company_fact", conditionKey: "registered_business_fact",
      companyFactReview: {
        meaning: "기준일에 등록 사업장이 있는지",
        definitionKey: "registered_business_fact", definitionSource: "new_review",
        scopeField: "fact_scope", scopeValue: "registered_business",
        asOfField: "basis_date", asOfDate: "2026-09-22", reviewArtifactSha256,
      },
      prompt: "귀사는 공고에 열거된 업종에 해당하나요?", options: OPTIONS,
    }],
  });
  const conditionKey = artifact.items[0]?.conditionKey;
  assert.ok(conditionKey);
  return { run, review, artifact, selection: manualConfirmationEvaluationSelectionForArtifact(artifact), conditionKey };
}

export function buildQuestionPreparationFixtureManifest(input: {
  grantId: string;
  plan: GrantPromotionPlan;
  sourceRevisionSha256: string;
  before: ReturnType<typeof promotionGrantSnapshotHashes>;
  releaseId: string;
  includeQuestion: boolean;
}): PromotionReleaseManifest {
  const launchReceiptSha256 = "d".repeat(64);
  const independentReviewAggregateSha256 = "e".repeat(64);
  const attachmentManifestSha256 = "f".repeat(64);
  const inputSha256 = "1".repeat(64);
  const planItem: PromotionReleasePlanItem = {
    grantId: input.grantId,
    planSha256: planSha256(input.plan),
    promotionPlan: input.plan,
    analysisLaunchReadiness: {
      schema: "analysis-launch-promotion-readiness-v1",
      disposition: "ready",
      reasons: [],
      unresolvedAxes: [],
      sourceRevisionSha256: input.sourceRevisionSha256,
      inputSha256,
      attachmentManifestSha256,
      launchReceiptSha256,
      independentReviewAggregateSha256,
      applicationRoundtripStatus: null,
      applicationRoundtripRunId: null,
      applicationDocumentCount: null,
      fieldReadyDocumentCount: null,
      recognizedFieldCount: null,
      runFeatureReadiness: {
        schema: "analysis-feature-readiness-v1",
        matching: { status: "ready", sourceDisposition: "ready", reasons: [] },
        authoring: {
          status: "held",
          sourceDisposition: "not_applicable",
          reasons: ["application_field_analysis_not_applicable"],
        },
      },
      runFeatureReadinessVerification: "verified",
      authoringEvidenceStatus: "held",
      authoringEvidenceReasons: ["application_field_analysis_not_applicable"],
      primaryMatchingProjectionStatus: "unverified",
      primaryMatchingProjectionSnapshotSha256: null,
    },
    beforeCriteriaSha256: input.before.criteriaSha256,
    beforeQuestionsSha256: input.before.questionsSha256,
    dedupComponentSha256: input.before.dedupComponentSha256,
    criteriaCountBefore: 1,
    criteriaCountAfter: 1,
    questionCountAfter: input.includeQuestion ? 1 : 0,
    pendingCount: 0,
    downgradedCount: 0,
    transport: "claude-cli",
    costUsd: null,
  };
  return createPromotionReleaseManifest({
    releaseId: input.releaseId,
    revision: 1,
    createdAt: "2026-09-22T00:00:00.000Z",
    gitCommit: "5".repeat(40),
    buildDigest: "6".repeat(40),
    cohortLabel: "question-preparation-postgres",
    canaryGrantIds: [input.grantId],
    sourceArtifacts: [{
      grantId: input.grantId,
      runId: input.plan.runId,
      runSha256: "7".repeat(64),
      overlaySha256: null,
      confirmationsSha256: null,
      ...(input.includeQuestion ? {
        manualConfirmationEvaluationsSha256:
          input.plan.manualConfirmationEvaluationSelection?.artifactSha256 ?? "c".repeat(64),
        manualConfirmationEvaluationSelection:
          input.plan.manualConfirmationEvaluationSelection,
      } : {}),
      sourceRevisionSha256: input.sourceRevisionSha256,
      localLabEvidence: {
        schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
        transport: "claude-cli",
        model: "claude-opus-5",
        promptVersion: "lab-deep-v7",
        inputSha256,
        reviewMethod: "analysis_launch_independent_review",
        analysisLaunch: {
          schema: VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA,
          launchReceiptSha256,
          launchManifestSha256: "8".repeat(64),
          launchGrantSha256: "9".repeat(64),
          launchSequence: 0,
          independentReviewManifestSha256: "0".repeat(64),
          independentReviewAggregateSha256,
          attachmentManifestSha256,
          sourceRevisionSha256: input.sourceRevisionSha256,
          executionGitSha: "a".repeat(40),
          packageRuntimeSha256: "b".repeat(64),
          validatorVersion: "deep-analysis-validator-v21",
          applicationFieldAnalysisVersion: null,
        },
      },
    }],
    plans: [planItem],
  });
}

export async function seedQuestionPreparationFixtureAppliedRelease(input: {
  admin: postgres.Sql;
  manifest: PromotionReleaseManifest;
  snapshot: Awaited<ReturnType<typeof loadPromotionGrantSnapshot>>;
  appliedAt: Date;
}): Promise<void> {
  const releaseDbId = crypto.randomUUID();
  const item = input.manifest.plans[0]!;
  const appliedAt = input.appliedAt.toISOString();
  await input.admin`insert into analysis_lab_promotion_releases
    (id,release_id,revision,manifest_sha256,release_plan_sha256,manifest,git_commit,build_digest,
     status,created_by,approved_by,approved_at,executed_by,started_at,completed_at)
    values (${releaseDbId},${input.manifest.releaseId},1,${input.manifest.manifestSha256},
      ${input.manifest.releasePlanSha256},${JSON.stringify(input.manifest)}::jsonb,
      ${input.manifest.gitCommit},${input.manifest.buildDigest},'active','fixture-preparer',
      'fixture-approver',${appliedAt},'fixture-executor',${appliedAt},${appliedAt})`;
  await input.admin`insert into analysis_lab_promotion_items
    (release_db_id,grant_id,run_id,plan_sha256,before_snapshot,before_sha256,
     after_snapshot,after_sha256,status,applied_at)
    values (${releaseDbId},${item.grantId},${item.promotionPlan.runId},${item.planSha256},'{}',
      ${"2".repeat(64)},${JSON.stringify(input.snapshot)}::jsonb,
      ${promotionGrantSnapshotStateSha256(input.snapshot)},'applied',${appliedAt})`;
}
