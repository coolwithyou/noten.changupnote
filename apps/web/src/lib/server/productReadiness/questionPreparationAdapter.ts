import {
  sha256Canonical,
  validatePromotionReleaseManifest,
  type PromotionReleaseManifest,
  type PromotionReleasePlanItem,
} from "../analysis-serving/promotionReleaseContract";
import { eq } from "drizzle-orm";
import type { CunoteDb } from "../db/client";
import type { AnalysisLaunchPromotionDependencies } from "../analysis-lab/analysis-launch-promotion";
import * as schema from "../db/schema";
import {
  assertReceiptBackedPromotionMutationAdmitted,
} from "../analysis-lab/promotion-mutation-admission";
import { releasePlanItemHasUnsafePendingCriteria } from "../analysis-lab/promotion-release";
import type {
  GrantNextWorkAdapter,
  GrantNextWorkSnapshot,
} from "./grantNextWorkExecution";
import { buildCompanyFactReuseIdentity } from "../matches/companyFactReuse";

export const QUESTION_PREPARATION_ADAPTER_RECEIPT_SCHEMA =
  "question-preparation-adapter-receipt-v1" as const;

export interface ApprovedQuestionPreparationRelease {
  readonly status: "approved" | "canary_running" | "partial_failed" | "canary_passed";
  readonly manifest: unknown;
  readonly manifestSha256: string;
  readonly releasePlanSha256: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly approvalArtifactSha256: string;
  readonly gateSummary: {
    readonly aggregateSha256: string;
    readonly shadowSha256: string;
    readonly dryRunSha256: string;
  };
}

export interface QuestionPreparationReleaseBinding {
  readonly release: ApprovedQuestionPreparationRelease;
  readonly manifest: PromotionReleaseManifest;
  readonly item: PromotionReleasePlanItem;
  readonly grantId: string;
  readonly expectedEvidenceSha256: string;
  /** 최초 공급 plan 전체(자산 선택 포함)의 exact hash. writer item에 원자적으로 기록한다. */
  readonly supplyPlanEvidenceSha256: string;
  readonly executedBy: string;
}

export interface QuestionPreparationReleaseApplyResult {
  readonly afterStateSha256: string;
  /** exact release item이 이미 적용된 경우 true. */
  readonly replayed: boolean;
  /** 논리적 외부 쓰기 단위. SQL statement 수가 아니다. */
  readonly externalWrites: number;
}

export interface ApprovedQuestionPreparationReleasePort {
  loadApprovedRelease(input: {
    readonly releaseId: string;
    readonly expectedManifestSha256: string;
    readonly grantId: string;
  }): Promise<ApprovedQuestionPreparationRelease>;
  applyApprovedCanary(
    binding: QuestionPreparationReleaseBinding,
  ): Promise<QuestionPreparationReleaseApplyResult>;
}

/** 실제 release 원장과 기존 promotion CLI writer를 공유하는 B 질문 발행 포트. */
export function createApprovedQuestionPreparationReleasePort(
  db: CunoteDb,
  isolatedAnalysisLaunch?: AnalysisLaunchPromotionDependencies,
): ApprovedQuestionPreparationReleasePort {
  return {
    async loadApprovedRelease(request) {
      const [release] = await db.select().from(schema.analysisLabPromotionReleases)
        .where(eq(schema.analysisLabPromotionReleases.releaseId, request.releaseId)).limit(1);
      if (!release || release.manifestSha256 !== request.expectedManifestSha256
          || !release.approvedBy || !release.approvedAt || !release.approvalArtifactSha256
          || !release.gateSummary || !["approved", "canary_running", "partial_failed", "canary_passed"].includes(release.status)) {
        throw new Error("question_preparation_approved_release_unavailable");
      }
      const gate = release.gateSummary as Record<string, unknown>;
      if (typeof gate.aggregateSha256 !== "string" || typeof gate.shadowSha256 !== "string"
          || typeof gate.dryRunSha256 !== "string") {
        throw new Error("question_preparation_release_gate_missing");
      }
      return {
        status: release.status as ApprovedQuestionPreparationRelease["status"],
        manifest: release.manifest,
        manifestSha256: release.manifestSha256,
        releasePlanSha256: release.releasePlanSha256,
        approvedBy: release.approvedBy,
        approvedAt: release.approvedAt.toISOString(),
        approvalArtifactSha256: release.approvalArtifactSha256,
        gateSummary: {
          aggregateSha256: gate.aggregateSha256,
          shadowSha256: gate.shadowSha256,
          dryRunSha256: gate.dryRunSha256,
        },
      };
    },
    async applyApprovedCanary(binding) {
      const { applyApprovedPromotionCanary } = await import("../analysis-lab/promote-cli");
      return applyApprovedPromotionCanary({
        db,
        releaseId: binding.manifest.releaseId,
        grantId: binding.grantId,
        expectedManifestSha256: binding.manifest.manifestSha256,
        actor: binding.executedBy,
        supplyPlanEvidenceSha256: binding.supplyPlanEvidenceSha256,
        ...(isolatedAnalysisLaunch ? { isolatedAnalysisLaunch } : {}),
      });
    },
  };
}

/**
 * R3-1 질문 준비 adapter. 질문을 직접 만들거나 모델을 호출하지 않는다. 사람 검수 질문
 * revision을 포함하고 기존 aggregate/shadow/dry-run 승인을 통과한 exact promotion canary만
 * 기존 writer 포트에 전달한다.
 */
export function createQuestionPreparationAdapter(input: {
  readonly releaseId: string;
  readonly expectedManifestSha256: string;
  readonly executedBy: string;
  readonly port: ApprovedQuestionPreparationReleasePort;
}): GrantNextWorkAdapter {
  const releaseId = nonEmpty(input.releaseId, "release_id");
  const expectedManifestSha256 = exactSha(input.expectedManifestSha256, "manifest");
  const executedBy = nonEmpty(input.executedBy, "executed_by");
  return {
    action: "question_preparation",
    async execute(execution) {
      if (execution.snapshot.nextWork.action !== "question_preparation") {
        throw new Error("question_preparation_action_mismatch");
      }
      if (
        execution.snapshot.grantId !== execution.grantId
        || execution.snapshot.evidenceSha256 !== execution.expectedEvidenceSha256
      ) {
        throw new Error("question_preparation_snapshot_mismatch");
      }
      const release = await input.port.loadApprovedRelease({
        releaseId,
        expectedManifestSha256,
        grantId: execution.grantId,
      });
      const binding = bindQuestionPreparationRelease({
        releaseId,
        expectedManifestSha256,
        executedBy,
        release,
        snapshot: execution.snapshot,
      });
      const applied = validateApplyResult(
        await input.port.applyApprovedCanary(binding),
      );
      const receipt = {
        schema: QUESTION_PREPARATION_ADAPTER_RECEIPT_SCHEMA,
        action: "question_preparation" as const,
        grantId: execution.grantId,
        beforeEvidenceSha256: execution.expectedEvidenceSha256,
        releaseId: binding.manifest.releaseId,
        manifestSha256: binding.manifest.manifestSha256,
        releasePlanSha256: binding.manifest.releasePlanSha256,
        planSha256: binding.item.planSha256,
        manualConfirmationEvaluationSelection:
          binding.item.promotionPlan.manualConfirmationEvaluationSelection,
        approvalArtifactSha256: binding.release.approvalArtifactSha256,
        executedBy,
        gateSummary: binding.release.gateSummary,
        afterStateSha256: applied.afterStateSha256,
        replayed: applied.replayed,
        modelCalls: 0,
        externalWrites: applied.externalWrites,
      };
      return {
        action: "question_preparation",
        receiptSha256: sha256Canonical(receipt),
        modelCalls: 0,
        externalWrites: applied.externalWrites,
      };
    },
  };
}

export function bindQuestionPreparationRelease(input: {
  readonly releaseId: string;
  readonly expectedManifestSha256: string;
  readonly executedBy: string;
  readonly release: ApprovedQuestionPreparationRelease;
  readonly snapshot: GrantNextWorkSnapshot;
}): QuestionPreparationReleaseBinding {
  if (!["approved", "canary_running", "partial_failed", "canary_passed"].includes(input.release.status)) {
    throw new Error("question_preparation_release_not_approved");
  }
  if (
    input.release.manifestSha256 !== input.expectedManifestSha256
    || exactSha(input.release.releasePlanSha256, "release_plan") !== input.release.releasePlanSha256
  ) {
    throw new Error("question_preparation_release_ledger_mismatch");
  }
  nonEmpty(input.release.approvedBy, "approved_by");
  if (input.release.approvedBy === nonEmpty(input.executedBy, "executed_by")) {
    throw new Error("question_preparation_actor_separation_required");
  }
  canonicalIso(input.release.approvedAt, "approved_at");
  exactSha(input.release.approvalArtifactSha256, "approval_artifact");
  exactSha(input.release.gateSummary.aggregateSha256, "aggregate_gate");
  exactSha(input.release.gateSummary.shadowSha256, "shadow_gate");
  exactSha(input.release.gateSummary.dryRunSha256, "dry_run_gate");

  const manifest = validatePromotionReleaseManifest(input.release.manifest);
  if (
    manifest.releaseId !== input.releaseId
    || manifest.manifestSha256 !== input.expectedManifestSha256
    || manifest.releasePlanSha256 !== input.release.releasePlanSha256
  ) {
    throw new Error("question_preparation_manifest_mismatch");
  }
  assertReceiptBackedPromotionMutationAdmitted(manifest);
  if (!manifest.canaryGrantIds.includes(input.snapshot.grantId)) {
    throw new Error("question_preparation_grant_not_canary");
  }
  const item = manifest.plans.find((candidate) => candidate.grantId === input.snapshot.grantId);
  if (!item) throw new Error("question_preparation_plan_missing");
  const source = manifest.sourceArtifacts.find((candidate) => candidate.grantId === input.snapshot.grantId);
  if (
    !source
    || source.runId !== item.promotionPlan.runId
    || source.sourceRevisionSha256 !== input.snapshot.readinessInput.source.revisionSha256
  ) {
    throw new Error("question_preparation_source_binding_mismatch");
  }
  validateQuestionPreparationPlan(item, input.snapshot);
  return Object.freeze({
    release: input.release,
    manifest,
    item,
    grantId: input.snapshot.grantId,
    expectedEvidenceSha256: input.snapshot.evidenceSha256,
    supplyPlanEvidenceSha256: input.snapshot.evidenceSha256,
    executedBy: input.executedBy,
  });
}

function validateQuestionPreparationPlan(
  item: PromotionReleasePlanItem,
  snapshot: GrantNextWorkSnapshot,
): void {
  const plan = item.promotionPlan;
  const selection = plan.manualConfirmationEvaluationSelection;
  if (!selection || selection.intent !== "active" || selection.itemCount < 1) {
    throw new Error("question_preparation_manual_review_missing");
  }
  if (
    plan.criteria.length === 0
    || plan.conversion.error
    || releasePlanItemHasUnsafePendingCriteria(item)
    || item.pendingCount !== 0
  ) {
    throw new Error("question_preparation_plan_not_publishable");
  }
  if (
    item.criteriaCountAfter !== plan.criteria.length
    || item.questionCountAfter !== plan.questions.length
  ) {
    throw new Error("question_preparation_plan_count_mismatch");
  }
  const expectedKeys = uniqueSorted(
    snapshot.readinessInput.analysis.eligibleQuestionCriterionStableKeys,
  );
  const questions = plan.questions.filter(
    (question) => question.evaluationContractVersion === "confirmation-evaluation-v2",
  );
  const actualKeys = uniqueSorted(questions.map((question) => question.criterionStableKey));
  if (
    snapshot.readiness.category !== "B"
    || expectedKeys.length !== snapshot.readiness.eligibleQuestionCount
    || questions.length !== selection.itemCount
    || expectedKeys.length !== actualKeys.length
    || expectedKeys.some((key, index) => key !== actualKeys[index])
  ) {
    throw new Error("question_preparation_question_coverage_mismatch");
  }
  const revision = snapshot.readinessInput.source.revisionSha256;
  const raw = snapshot.readinessInput.source.rawSha256;
  if (!revision || !raw) throw new Error("question_preparation_source_binding_missing");
  for (const question of questions) {
    const criterion = plan.criteria[question.criteriaPosition];
    const companyFactValid = question.reusable !== "company_fact" || Boolean(criterion &&
      buildCompanyFactReuseIdentity({
        questionId: `${plan.runId}:${question.criterionIndex}`,
        grantId: plan.grantId,
        reusable: question.reusable,
        conditionKey: question.conditionKey,
        evaluationContractVersion: question.evaluationContractVersion ?? null,
        answerType: question.answerType,
        options: question.options,
        criterion: {
          dimension: criterion.dimension,
          kind: criterion.kind,
          operator: criterion.operator,
          value: criterion.value,
        },
      }));
    if (
      question.answerType !== "single"
      || (question.reusable !== "per_notice" && question.reusable !== "company_fact")
      || (question.reusable === "per_notice" && question.conditionKey !== null)
      || !companyFactValid
      || question.sourceRevisionSha256 !== revision
      || question.sourceRawSha256 !== raw
      || question.provenance.runId !== plan.runId
      || !hasExactEvaluationStates(question.options)
    ) {
      throw new Error("question_preparation_question_contract_invalid");
    }
  }
  if (
    item.promotionPlan.grantId !== snapshot.grantId
    || item.promotionPlan.questions.some((question) => (
      question.evaluationContractVersion === "confirmation-evaluation-v2"
      && question.sourceRevisionSha256 !== revision
    ))
  ) throw new Error("question_preparation_source_binding_mismatch");
}

function validateApplyResult(
  result: QuestionPreparationReleaseApplyResult,
): QuestionPreparationReleaseApplyResult {
  exactSha(result.afterStateSha256, "after_state");
  if (!Number.isSafeInteger(result.externalWrites) || result.externalWrites < 0) {
    throw new Error("question_preparation_external_writes_invalid");
  }
  if (result.replayed && result.externalWrites !== 0) {
    throw new Error("question_preparation_replay_writes_invalid");
  }
  return result;
}

function hasExactEvaluationStates(
  options: readonly { evaluation?: unknown }[],
): boolean {
  return options.length === 3
    && [...options.map((option) => option.evaluation)].sort().join(",")
      === "satisfied,unknown,unsatisfied";
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort();
}

function exactSha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`question_preparation_${label}_invalid`);
  return value;
}

function nonEmpty(value: string, label: string): string {
  if (!value.trim()) throw new Error(`question_preparation_${label}_missing`);
  return value.trim();
}

function canonicalIso(value: string, label: string): string {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new Error(`question_preparation_${label}_invalid`);
  }
  return value;
}
