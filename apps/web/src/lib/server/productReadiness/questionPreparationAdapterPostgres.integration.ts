import assert from "node:assert/strict";
import type postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadDeepAnalysisSourceBinding } from "../deep-analysis/prepareInput";
import {
  createPromotionReleaseManifest,
  planSha256,
  VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionReleaseManifest,
  type PromotionReleasePlanItem,
} from "../analysis-lab/promotion-release";
import {
  executePromotionWrites,
  questionDefinitionSha256,
  sourceSpanHash,
  type GrantPromotionPlan,
} from "../analysis-lab/promote";
import { createDrizzlePromotionPort } from "../analysis-lab/promote-cli";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotHashes,
  promotionGrantSnapshotStateSha256,
} from "../analysis-lab/promotion-snapshot";
import { loadCurrentGrantReadiness } from "./grantReadinessLoader";
import {
  createGrantNextWorkSnapshot,
  executeGrantNextWork,
} from "./grantNextWorkExecution";
import {
  createQuestionPreparationAdapter,
  type ApprovedQuestionPreparationReleasePort,
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
}): Promise<void> {
  assert.equal(input.socket, process.env.CUNOTE_PRODUCT_TEST_SOCKET);
  assert.match(input.socket, /^\/tmp\/cunote-product-pg-[a-zA-Z0-9]+$/u);
  const db = drizzle(input.admin, { schema });
  const grantId = crypto.randomUUID();
  const criterionId = crypto.randomUUID();
  const sourceId = `question-preparation-${grantId}`;
  const rawSha256 = "b".repeat(64);
  const stableKey = "criterion:industry:manual";
  const runId = `question-preparation-run-${grantId}`;
  const asOf = new Date("2026-09-22T03:00:00.000Z");

  await input.admin`insert into grants
    (id,source,source_id,title,apply_start,apply_end,status,serving_state,overall_confidence)
    values (${grantId},'bizinfo',${sourceId},'질문 준비 격리 검증 공고',
      '2026-09-01T00:00:00.000Z','2026-10-01T00:00:00.000Z','open','visible',1)`;
  await input.admin`insert into grant_raw(source,source_id,payload,attachments,raw_hash,status)
    values ('bizinfo',${sourceId},'{}',
      ${JSON.stringify([{ filename: "guide.pdf", url: "https://example.invalid/guide.pdf" }])}::jsonb,
      ${rawSha256},'normalized')`;
  await input.admin`insert into grant_attachment_archives
    (source,source_id,filename,source_uri,sha256,conversion_status)
    values ('bizinfo',${sourceId},'guide.pdf','https://example.invalid/guide.pdf',
      ${"a".repeat(64)},'archived')`;
  await input.admin`insert into grant_criteria
    (id,grant_id,dimension,operator,value,kind,confidence,source_span,raw_text,source_field,
     stable_key,needs_review,parser_version)
    values (${criterionId},${grantId},'industry','text_only','{"note":"공고 열거 업종"}',
      'required',1,'식품·생활용품·가정용품 분야 중소기업',
      '식품·생활용품·가정용품 분야 중소기업','지원대상',${stableKey},false,'fixture-v1')`;
  const source = await loadDeepAnalysisSourceBinding({ db, grantId });
  assert.ok(source);
  assert.equal(source.sourceRawSha256, rawSha256);

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

  const beforePromotionSnapshot = await loadPromotionGrantSnapshot(db, grantId);
  const releasePlan = buildQuestionPreparationFixturePlan({
    grantId,
    runId,
    stableKey,
    sourceRevisionSha256: source.sourceRevisionSha256,
    sourceRawSha256: rawSha256,
    includeQuestion: true,
  });
  const releaseId = `question-preparation-release-${grantId}`;
  const releaseManifest = buildQuestionPreparationFixtureManifest({
    grantId,
    plan: releasePlan,
    sourceRevisionSha256: source.sourceRevisionSha256,
    before: promotionGrantSnapshotHashes(beforePromotionSnapshot),
    releaseId,
    includeQuestion: true,
  });
  const releaseDbId = crypto.randomUUID();
  const releaseItemId = crypto.randomUUID();
  const approvalArtifactSha256 = "c".repeat(64);
  const gateSummary = {
    aggregateSha256: "d".repeat(64),
    shadowSha256: "e".repeat(64),
    dryRunSha256: "f".repeat(64),
  };
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

  const port: ApprovedQuestionPreparationReleasePort = {
    loadApprovedRelease: async (request) => {
      const [row] = await input.admin<{
        status: "approved" | "canary_running";
        manifest: unknown;
        manifest_sha256: string;
        release_plan_sha256: string;
        approved_by: string;
        approved_at: string;
        approval_artifact_sha256: string;
        gate_summary: typeof gateSummary;
      }[]>`select status,manifest,manifest_sha256,release_plan_sha256,approved_by,approved_at,
                   approval_artifact_sha256,gate_summary
            from analysis_lab_promotion_releases
            where release_id=${request.releaseId} and manifest_sha256=${request.expectedManifestSha256}`;
      assert.ok(row);
      return {
        status: row.status,
        manifest: row.manifest,
        manifestSha256: row.manifest_sha256,
        releasePlanSha256: row.release_plan_sha256,
        approvedBy: row.approved_by,
        approvedAt: new Date(row.approved_at).toISOString(),
        approvalArtifactSha256: row.approval_artifact_sha256,
        gateSummary: row.gate_summary,
      };
    },
    applyApprovedCanary: async (binding) => {
      const claimed = await input.admin`update analysis_lab_promotion_releases
        set status='canary_running',executed_by='question-executor',started_at=now()
        where id=${releaseDbId} and status='approved' returning id`;
      assert.equal(claimed.length, 1);
      const promotionPort = createDrizzlePromotionPort(db as CunoteDb, [], {
        releaseDbId,
        itemByGrantId: new Map([[grantId, binding.item]]),
      });
      const [outcome] = await executePromotionWrites([binding.item.promotionPlan], promotionPort);
      if (!outcome || outcome.error) {
        await input.admin`update analysis_lab_promotion_items
          set status='failed',error=${outcome?.error ?? "unknown failure"},updated_at=now()
          where id=${releaseItemId}`;
        await input.admin`update analysis_lab_promotion_releases
          set status='partial_failed' where id=${releaseDbId}`;
        throw new Error(outcome?.error ?? "question preparation writer failure");
      }
      await input.admin`update analysis_lab_promotion_releases
        set status='canary_passed' where id=${releaseDbId}`;
      const [applied] = await input.admin<{ after_sha256: string }[]>`
        select after_sha256 from analysis_lab_promotion_items where id=${releaseItemId}`;
      assert.ok(applied?.after_sha256);
      return { afterStateSha256: applied.after_sha256, replayed: false, externalWrites: 1 };
    },
  };
  const adapter = createQuestionPreparationAdapter({
    releaseId,
    expectedManifestSha256: releaseManifest.manifestSha256,
    executedBy: "question-executor",
    port,
  });
  const result = await executeGrantNextWork({
    grantId,
    expectedEvidenceSha256: before.evidenceSha256,
    loadSnapshot: async () => loadSnapshot(),
    adapters: new Map([["question_preparation", adapter]]),
  });
  assert.equal(result.status, "completed");
  assert.equal(result.nextAction, "reuse_ready");
  assert.equal(result.modelCalls, 0);
  assert.equal(result.externalWrites, 1);
  const after = await loadSnapshot();
  assert.equal(after.readiness.category, "A");
  assert.equal(after.readiness.eligibleQuestionCoveredCount, 1);
  assert.equal((await input.admin`select id from grant_criteria where id=${criterionId}`).length, 1);
  const [question] = await input.admin<{
    evaluation_contract_version: string;
    source_revision_sha256: string;
    source_raw_sha256: string;
    reusable: string;
  }[]>`select evaluation_contract_version,source_revision_sha256,source_raw_sha256,reusable
      from grant_confirmation_questions where grant_id=${grantId} and invalidated_at is null`;
  assert.deepEqual(question, {
    evaluation_contract_version: "confirmation-evaluation-v2",
    source_revision_sha256: source.sourceRevisionSha256,
    source_raw_sha256: rawSha256,
    reusable: "per_notice",
  });
  console.log("PASS: reviewed question preparation canary advances isolated readiness B to A with zero model calls");
}

export function buildQuestionPreparationFixturePlan(input: {
  grantId: string;
  runId: string;
  stableKey: string;
  sourceRevisionSha256: string;
  sourceRawSha256: string;
  includeQuestion: boolean;
}): GrantPromotionPlan {
  const sourceSpan = "식품·생활용품·가정용품 분야 중소기업";
  const criterion = {
    id: `${input.grantId}:llm-1`,
    dimension: "industry" as const,
    operator: "text_only" as const,
    value: { note: "공고 열거 업종" },
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
    reusable: "per_notice" as const,
    conditionKey: null,
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
      manualConfirmationEvaluationSelection: {
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
        manualConfirmationEvaluationsSha256: "c".repeat(64),
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
