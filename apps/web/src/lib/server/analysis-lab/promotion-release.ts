import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeepAnalysisPromotionReadiness } from "../deep-analysis/promotion";
import type { GrantPromotionPlan } from "./promote";
import {
  validatePromotionApplicationPrecomputeEvidence,
  type PromotionApplicationPrecomputeEvidence,
} from "./application-precompute-release";
import { LAB_DETERMINISTIC_AUDIT_POLICY_VERSION } from "./deterministic-audit-resolution";
import { analysisLabDir } from "./run-store";

export const PROMOTION_RELEASE_SCHEMA = "analysis-lab-promotion-release-v1" as const;
export const PROMOTION_DRY_RUN_SCHEMA = "analysis-lab-promotion-dry-run-v1" as const;
export const PROMOTION_APPROVAL_SCHEMA = "analysis-lab-promotion-approval-v1" as const;
export const VERIFIED_LOCAL_LAB_SOURCE_SCHEMA = "verified-local-lab-source-v1" as const;
export const MIN_CONFIRM_HASH_PREFIX = 12;

export type PromotionServingProvenance =
  | "production_deep_run"
  | "verified_local_lab"
  | "experiment_only";

export interface VerifiedLocalLabSourceEvidence {
  schema: typeof VERIFIED_LOCAL_LAB_SOURCE_SCHEMA;
  transport: "claude-cli";
  model: string;
  promptVersion: string;
  inputSha256: string;
  reviewMethod: "human" | "ai_audit";
  reviewModel?: string;
  reviewPromptVersion?: string;
  reviewTransport?: "claude-cli";
  auditModel?: string;
  auditPromptVersion?: string;
  auditTransport?: "claude-cli";
  deterministicPolicyVersion?: string;
  deterministicResolvedCriterionIndexes?: number[];
}

export interface PromotionSourceArtifact {
  grantId: string;
  runId: string;
  runSha256: string;
  reviewSha256?: string | null;
  aiReviewSha256?: string | null;
  auditSha256?: string | null;
  overlaySha256: string | null;
  confirmationsSha256: string | null;
  /**
   * 프로덕션 deep-analysis 원장에서 온 source. 이 필드가 있으면 source verifier는
   * 로컬 spike 파일 대신 DB run/job/S11/audit와 private R2 artifact를 검증한다.
   */
  deepAnalysisRunId?: string;
  sourceRevisionSha256?: string;
  inputSha256?: string;
  outputArtifactKey?: string;
  auditArtifactKey?: string;
  /** 조건부 승격도 원본 audit 판정과 함께 manifest hash에 봉인한다. */
  auditVerdict?: "concur" | "unsure";
  /**
   * 로컬 구독 분석을 운영 deep run으로 위장하지 않고 별도 provenance로 봉인한다.
   * 이 증거와 review/audit 파일 해시가 모두 있을 때만 제품 서빙 후보가 된다.
   */
  localLabEvidence?: VerifiedLocalLabSourceEvidence;
  /** clean worktree에서도 재현 가능한 고품질 구독 Kordoc release 번들. */
  applicationPrecompute?: PromotionApplicationPrecomputeEvidence;
}

export interface PromotionReleasePlanItem {
  grantId: string;
  planSha256: string;
  promotionPlan: GrantPromotionPlan;
  /**
   * 프로덕션 deep-analysis release만 기록한다. 사람이 확정하지 않은
   * needs_review criterion이 matcher에서 안전하게 conditional로 남는 위치인지
   * 자동 검수 결정과 함께 manifest hash에 묶는다.
   */
  deepAnalysisReadiness?: DeepAnalysisPromotionReadiness;
  deepAnalysisConditionalOnlyCriteria?: number[];
  beforeCriteriaSha256: string;
  beforeQuestionsSha256: string;
  dedupComponentSha256: string;
  criteriaCountBefore: number;
  criteriaCountAfter: number;
  questionCountAfter: number;
  pendingCount: number;
  downgradedCount: number;
  costUsd: number | null;
}

export interface PromotionReleaseManifestBody {
  schema: typeof PROMOTION_RELEASE_SCHEMA;
  releaseId: string;
  revision: number;
  createdAt: string;
  gitCommit: string;
  buildDigest: string;
  cohortLabel: string;
  canaryGrantIds: string[];
  /** 구 release에는 없으며, 부재 시 experiment_only와 동일하게 서빙에서 제외한다. */
  servingProvenance?: PromotionServingProvenance;
  releasePlanSha256: string;
  sourceArtifacts: PromotionSourceArtifact[];
  plans: PromotionReleasePlanItem[];
}

export interface PromotionReleaseManifest extends PromotionReleaseManifestBody {
  manifestSha256: string;
}

export interface PromotionDryRunItem {
  grantId: string;
  planSha256: string;
  beforeCriteriaSha256: string;
  beforeQuestionsSha256: string;
  dedupComponentSha256: string;
  baselineMatches: boolean;
  guard: "pass" | "conversion_error" | "empty_criteria" | "pending_criteria";
  criteriaCountAfter: number;
  questionCountAfter: number;
}

export interface PromotionDryRunArtifact {
  schema: typeof PROMOTION_DRY_RUN_SCHEMA;
  releaseId: string;
  releasePlanSha256: string;
  manifestSha256: string;
  createdAt: string;
  items: PromotionDryRunItem[];
  verdict: "PASS" | "FAIL";
}

export interface PromotionApprovalArtifact {
  schema: typeof PROMOTION_APPROVAL_SCHEMA;
  releaseId: string;
  releasePlanSha256: string;
  manifestSha256: string;
  aggregateSha256: string;
  shadowSha256: string;
  dryRunSha256: string;
  approvedBy: string;
  approvedAt: string;
}

export interface PromotionApprovalGateEvidence {
  aggregateSha256: string;
  shadowSha256: string;
  dryRunSha256: string;
}

/**
 * 승인 단계는 준비 단계가 이미 기록한 cohort 전용 gate를 지우지 않는다.
 * 통합공고 release의 case/child PASS 증적도 이후 S12~S14가 다시 사용한다.
 */
export function mergePromotionApprovalGateEvidence(
  existing: Record<string, unknown> | null,
  approval: PromotionApprovalGateEvidence,
): Record<string, unknown> {
  return {
    ...(existing ?? {}),
    ...approval,
  };
}

export function canonicalJson(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

/** 릴리스 아티팩트에는 원본 companyId/사업자번호 대신 릴리스별 HMAC 가명키만 남긴다. */
export function pseudonymizePromotionCompanyKey(
  secret: string,
  releaseId: string,
  rawKey: string,
): string {
  if (secret.length < 32) throw new Error("회사 키 가명화 secret은 32자 이상이어야 합니다.");
  assertSafeReleaseId(releaseId);
  return `company-${createHmac("sha256", secret)
    .update(`${releaseId}\u001f${rawKey}`)
    .digest("hex")
    .slice(0, 20)}`;
}

export function planSha256(plan: GrantPromotionPlan): string {
  return sha256Canonical(plan);
}

export function releasePlanSha256(items: PromotionReleasePlanItem[]): string {
  return sha256Canonical(
    [...items]
      .sort((left, right) => left.grantId.localeCompare(right.grantId))
      .map((item) => ({
        grantId: item.grantId,
        planSha256: item.planSha256,
        promotionPlan: item.promotionPlan,
        deepAnalysisReadiness: item.deepAnalysisReadiness,
        deepAnalysisConditionalOnlyCriteria: item.deepAnalysisConditionalOnlyCriteria,
      })),
  );
}

export function isAutoPromotableDeepAnalysisReadiness(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const readiness = value as Partial<DeepAnalysisPromotionReadiness>;
  return readiness.schema === "deep-analysis-promotion-readiness-v1"
    && readiness.analysisComplete === "passed"
    && readiness.auditComplete === "passed"
    && readiness.matcherRepresentable === "passed"
    && readiness.autoPromotable === "passed"
    && readiness.humanReviewRequired === false
    && readiness.terminalRoute === "auto_promotable"
    && Array.isArray(readiness.blockers)
    && readiness.blockers.length === 0;
}

export function isConditionalPromotableDeepAnalysisReadiness(
  value: unknown,
): boolean {
  if (!value || typeof value !== "object") return false;
  const readiness = value as Partial<DeepAnalysisPromotionReadiness>;
  return readiness.schema === "deep-analysis-promotion-readiness-v1"
    && readiness.analysisComplete === "passed"
    && readiness.autoPromotable === "blocked"
    && readiness.conditionalPromotable === "passed"
    && readiness.humanReviewRequired === false
    && readiness.terminalRoute === "conditional_promotable"
    && Array.isArray(readiness.deferredCriterionIndexes)
    && Array.isArray(readiness.blockers)
    && readiness.blockers.length === 0
    && Array.isArray(readiness.deferrals)
    && readiness.deferrals.length > 0;
}

export function isPromotableDeepAnalysisReadiness(value: unknown): boolean {
  return isAutoPromotableDeepAnalysisReadiness(value)
    || isConditionalPromotableDeepAnalysisReadiness(value);
}

export type PromotionAggregateGateId =
  | "strict_precision"
  | "wrong_rate"
  | "missed_per_notice"
  | "coverage_ratio"
  | "cost_per_notice_usd"
  | "structured_ratio";

export interface PromotionAggregateVerdictCounts {
  correct: number;
  needsEdit: number;
  wrong: number;
  unsure: number;
}

export interface PromotionAggregateEffectiveCounts extends PromotionAggregateVerdictCounts {
  missed: number;
}

/**
 * 조건부 local-lab plan에서 이미 매칭 계산에서 억제한 ranking-only 오류를 정확성·누락
 * 게이트의 실패로 다시 세지 않는다. 원래 totals는 manifest에 그대로 보존하고, 이 함수의
 * effective 값만 게이트 계산에 사용한다.
 */
export function promotionAggregateEffectiveCounts(
  plans: readonly Pick<PromotionReleasePlanItem, "promotionPlan">[],
  counts: PromotionAggregateEffectiveCounts,
): PromotionAggregateEffectiveCounts {
  const deferred = plans.reduce((total, item) => {
    const risk = item.promotionPlan.reviewRisk;
    if (!risk || risk.disposition !== "conditional") return total;
    return {
      needsEdit: total.needsEdit + risk.suppressedVerdicts.needsEdit,
      wrong: total.wrong + risk.suppressedVerdicts.wrong,
      unsure: total.unsure + risk.suppressedVerdicts.unsure,
      missed: total.missed + risk.deferredMissedConditions,
    };
  }, { needsEdit: 0, wrong: 0, unsure: 0, missed: 0 });
  return {
    correct: counts.correct,
    needsEdit: Math.max(0, counts.needsEdit - deferred.needsEdit),
    wrong: Math.max(0, counts.wrong - deferred.wrong),
    unsure: Math.max(0, counts.unsure - deferred.unsure),
    missed: Math.max(0, counts.missed - deferred.missed),
  };
}

/**
 * 일반 사람 검수 release의 unsure는 기존처럼 미확정 판정으로 정밀도 분모에 남긴다.
 * production deep-analysis release에서는 자동 검수 결정이 봉인한 unsure가 모두
 * 사용자 확인 질문으로 이관된 deferral이므로 확정 판정의 정밀도/오류율 분모에서 뺀다.
 */
export function promotionAggregateDecidedCount(
  plans: readonly Pick<
    PromotionReleasePlanItem,
    "deepAnalysisReadiness" | "promotionPlan"
  >[],
  verdicts: PromotionAggregateVerdictCounts,
): number {
  const effective = promotionAggregateEffectiveCounts(plans, {
    ...verdicts,
    missed: 0,
  });
  const deferredUnsure = isPromotableAnalysisRelease(plans)
    ? effective.unsure
    : 0;
  return (
    effective.correct
    + effective.needsEdit
    + effective.wrong
    + effective.unsure
    - deferredUnsure
  );
}

/**
 * 사람 검수 실험 release의 6개 게이트는 그대로 유지한다. 다만 독립 감사와 matcher
 * readiness까지 봉인된 production deep-analysis release와 독립 감사된 단일 local
 * conditional canary에서는 정확성·누락·비용과 source drift만 발행 차단 조건이다.
 * 상대 coverage와 structured 비율은 도입 성과 지표라 개별 공고의 문서 특성만으로
 * 안전한 conditional 발행을 막지 않는다.
 */
export function isPromotionAggregateGateBlocking(
  plans: readonly Pick<PromotionReleasePlanItem, "deepAnalysisReadiness" | "promotionPlan">[],
  gateId: PromotionAggregateGateId,
): boolean {
  if (!isPromotableAnalysisRelease(plans)) return true;
  return gateId !== "coverage_ratio" && gateId !== "structured_ratio";
}

function isPromotableAnalysisRelease(
  plans: readonly Pick<PromotionReleasePlanItem, "deepAnalysisReadiness" | "promotionPlan">[],
): boolean {
  return plans.length > 0
    && plans.every((item) => (
      isPromotableDeepAnalysisReadiness(item.deepAnalysisReadiness)
      || isAuditedLocalConditionalPlan(item.promotionPlan)
    ));
}

function isAuditedLocalConditionalPlan(plan: GrantPromotionPlan): boolean {
  return plan.origin === "audited"
    && (plan.auditState === "ai_audit_concur" || plan.auditState === "deterministic_contract")
    && plan.reviewRisk?.disposition === "conditional"
    && plan.reviewRisk.blockers.length === 0;
}

/**
 * 일반 Lab release는 기존처럼 needs_review를 fail-closed한다. 프로덕션
 * deep-analysis release와 독립 감사된 local conditional canary만 결정 근거가
 * manifest에 봉인된 경우 needs_review criterion을 unknown으로 보존할 수 있다.
 */
export function releasePlanItemHasUnsafePendingCriteria(
  item: PromotionReleasePlanItem,
): boolean {
  const needsReviewPositions = item.promotionPlan.criteria.flatMap(
    (criterion, position) => criterion.needs_review === true ? [position] : [],
  );
  if (needsReviewPositions.length === 0) return false;
  if (isAuditedLocalConditionalPlan(item.promotionPlan)) return false;
  if (!isPromotableDeepAnalysisReadiness(item.deepAnalysisReadiness)) return true;
  const conditionalOnly = new Set(item.deepAnalysisConditionalOnlyCriteria ?? []);
  return needsReviewPositions.some((position) => !conditionalOnly.has(position));
}

/**
 * local-lab release 준비에서 미해소 criterion이 실제로 발행을 막아야 하는지 판정한다.
 * 기본 정책은 기존처럼 pending/needs_review를 모두 차단한다. 단, 정확히 한 공고를
 * `--audited-local-canary`로 지정한 경우에는 두 독립 AI의 감사가 끝났고 reviewRisk가
 * conditional인 plan의 needs_review만 허용한다. 이 criterion은 matcher에서 hard fail로
 * 쓰이지 않고 unknown으로 남으므로, 카나리에서 질문·조건부 노출을 검증할 수 있다.
 *
 * reviewRisk가 명시적으로 억제한 preferred criterion의 resolution은 발행 배열에서 이미
 * 제외됐으므로 pending이어도 차단하지 않는다. 그 밖의 pending은 예외 없이 차단한다.
 */
export function promotionPlanHasUnsafeUnresolvedCriteria(
  plan: GrantPromotionPlan,
  options: { auditedLocalCanary?: boolean } = {},
): boolean {
  const suppressed = new Set(plan.reviewRisk?.suppressedCriterionIndexes ?? []);
  if (plan.resolutions.some((resolution) =>
    resolution.state === "pending" && !suppressed.has(resolution.criterionIndex))) {
    return true;
  }

  const hasNeedsReview = plan.criteria.some((criterion) => criterion.needs_review === true);
  if (!hasNeedsReview) return false;
  return !(
    options.auditedLocalCanary === true
    && plan.origin === "audited"
    && (plan.auditState === "ai_audit_concur" || plan.auditState === "deterministic_contract")
    && plan.reviewRisk?.disposition === "conditional"
    && plan.reviewRisk.blockers.length === 0
  );
}

interface PromotionShadowState {
  eligibility: string;
  tier: string;
  decided: number;
  unknownHard: number;
}

/**
 * 판정(pass/fail) 없이 결과가 바뀌면 원칙적으로 차단한다. 단, eligibility는
 * conditional로 유지되는 두 안전한 전환은 설명 가능하다.
 * - 새 hard unknown 근거가 늘어 needs_profile_input→needs_core_review로 보수화
 * - 비구조 text-only를 질문 가능한 criterion으로 바꿔 needs_core_review→needs_profile_input
 *   (unknown hard를 줄이지 않아 조건 삭제에 의한 상태 개선은 허용하지 않는다)
 */
export function isUnexplainedPromotionShadowTransition(
  before: PromotionShadowState,
  after: PromotionShadowState,
): boolean {
  const changed =
    before.eligibility !== after.eligibility || before.tier !== after.tier;
  if (!changed || after.decided > 0) return false;
  const explainedConditionalReview =
    before.eligibility === "conditional"
    && after.eligibility === "conditional"
    && before.tier === "needs_profile_input"
    && after.tier === "needs_core_review"
    && after.unknownHard > before.unknownHard;
  const explainedActionableProfileInput =
    before.eligibility === "conditional"
    && after.eligibility === "conditional"
    && before.tier === "needs_core_review"
    && after.tier === "needs_profile_input"
    && after.unknownHard >= before.unknownHard;
  return !explainedConditionalReview && !explainedActionableProfileInput;
}

export function createPromotionReleaseManifest(
  input: Omit<PromotionReleaseManifestBody, "schema" | "releasePlanSha256" | "servingProvenance">,
): PromotionReleaseManifest {
  const plans = [...input.plans].sort((left, right) => left.grantId.localeCompare(right.grantId));
  const sourceArtifacts = [...input.sourceArtifacts]
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
  const canaryGrantIds = [...new Set(input.canaryGrantIds)].sort();
  const body: PromotionReleaseManifestBody = {
    ...input,
    schema: PROMOTION_RELEASE_SCHEMA,
    canaryGrantIds,
    servingProvenance: resolvePromotionServingProvenance(sourceArtifacts),
    sourceArtifacts,
    plans,
    releasePlanSha256: releasePlanSha256(plans),
  };
  return { ...body, manifestSha256: sha256Canonical(body) };
}

export function validatePromotionReleaseManifest(value: unknown): PromotionReleaseManifest {
  if (!value || typeof value !== "object") throw new Error("release manifest가 객체가 아닙니다.");
  const manifest = value as Partial<PromotionReleaseManifest>;
  if (
    manifest.schema !== PROMOTION_RELEASE_SCHEMA
    || typeof manifest.releaseId !== "string"
    || !Number.isInteger(manifest.revision)
    || !Array.isArray(manifest.plans)
    || !Array.isArray(manifest.sourceArtifacts)
    || !Array.isArray(manifest.canaryGrantIds)
    || typeof manifest.releasePlanSha256 !== "string"
    || typeof manifest.manifestSha256 !== "string"
  ) {
    throw new Error("release manifest 형식이 올바르지 않습니다.");
  }
  assertSafeReleaseId(manifest.releaseId);
  const typed = manifest as PromotionReleaseManifest;
  if (
    typed.servingProvenance !== undefined
    && typed.servingProvenance !== resolvePromotionServingProvenance(typed.sourceArtifacts)
  ) {
    throw new Error("release serving provenance가 source artifact와 일치하지 않습니다.");
  }
  const expectedPlanHash = releasePlanSha256(typed.plans);
  if (expectedPlanHash !== typed.releasePlanSha256) {
    throw new Error("release plan hash가 manifest 내용과 일치하지 않습니다.");
  }
  const { manifestSha256: _stored, ...body } = typed;
  const expectedManifestHash = sha256Canonical(body);
  if (expectedManifestHash !== typed.manifestSha256) {
    throw new Error("manifest hash가 내용과 일치하지 않습니다.");
  }
  const artifactGrantIds = new Set(typed.sourceArtifacts.map((item) => item.grantId));
  const sourceArtifactByGrantId = new Map(
    typed.sourceArtifacts.map((item) => [item.grantId, item]),
  );
  const seenGrantIds = new Set<string>();
  for (const item of typed.plans) {
    if (seenGrantIds.has(item.grantId)) throw new Error(`manifest grant 중복: ${item.grantId}`);
    seenGrantIds.add(item.grantId);
    if (planSha256(item.promotionPlan) !== item.planSha256) {
      throw new Error(`plan hash 불일치: ${item.grantId}`);
    }
    if (item.promotionPlan.grantId !== item.grantId) {
      throw new Error(`plan grantId 불일치: ${item.grantId}`);
    }
    if (!artifactGrantIds.has(item.grantId)) {
      throw new Error(`source artifact 누락: ${item.grantId}`);
    }
    if (item.deepAnalysisReadiness !== undefined) {
      const source = sourceArtifactByGrantId.get(item.grantId);
      const conditionalOnly = item.deepAnalysisConditionalOnlyCriteria;
      const needsReviewPositions = item.promotionPlan.criteria.flatMap(
        (criterion, position) => criterion.needs_review === true ? [position] : [],
      );
      if (
        !source?.deepAnalysisRunId
        || !isPromotableDeepAnalysisReadiness(item.deepAnalysisReadiness)
        || !Array.isArray(conditionalOnly)
        || new Set(conditionalOnly).size !== conditionalOnly.length
        || conditionalOnly.length !== needsReviewPositions.length
        || needsReviewPositions.some((position) => !conditionalOnly.includes(position))
        || conditionalOnly.some(
          (position) =>
            !Number.isInteger(position)
            || position < 0
            || item.promotionPlan.criteria[position]?.needs_review !== true,
        )
      ) {
        throw new Error(`deep-analysis readiness 불일치: ${item.grantId}`);
      }
    } else if (item.deepAnalysisConditionalOnlyCriteria !== undefined) {
      throw new Error(`deep-analysis readiness 없는 conditional 분류: ${item.grantId}`);
    }
  }
  for (const grantId of typed.canaryGrantIds) {
    if (!seenGrantIds.has(grantId)) throw new Error(`canary가 release plan 밖에 있습니다: ${grantId}`);
  }
  for (const artifact of typed.sourceArtifacts) {
    if (artifact.applicationPrecompute !== undefined) {
      validatePromotionApplicationPrecomputeEvidence(artifact.applicationPrecompute);
      if (
        artifact.applicationPrecompute.releaseId !== typed.releaseId
        || artifact.applicationPrecompute.grantId !== artifact.grantId
        || artifact.applicationPrecompute.parentLabRunId !== artifact.runId
      ) {
        throw new Error(`Kordoc release evidence 결속이 올바르지 않습니다: ${artifact.grantId}`);
      }
    }
  }
  return typed;
}

export function resolvePromotionServingProvenance(
  artifacts: readonly PromotionSourceArtifact[],
): PromotionServingProvenance {
  if (artifacts.length === 0) return "experiment_only";
  if (artifacts.every((artifact) => Boolean(artifact.deepAnalysisRunId))) {
    return "production_deep_run";
  }
  if (artifacts.every(isVerifiedLocalLabSourceArtifact)) {
    return "verified_local_lab";
  }
  return "experiment_only";
}

export function isVerifiedLocalLabSourceArtifact(
  artifact: PromotionSourceArtifact,
): boolean {
  const evidence = artifact.localLabEvidence;
  if (
    artifact.deepAnalysisRunId
    || evidence?.schema !== VERIFIED_LOCAL_LAB_SOURCE_SCHEMA
    || evidence.transport !== "claude-cli"
    || !evidence.model.trim()
    || !evidence.promptVersion.trim()
    || !isSha256(evidence.inputSha256)
    || !isSha256(artifact.runSha256)
  ) {
    return false;
  }
  if (evidence.reviewMethod === "human") return isSha256(artifact.reviewSha256);
  if (evidence.reviewMethod === "ai_audit") {
    const deterministicIndexes = evidence.deterministicResolvedCriterionIndexes;
    const deterministicEvidenceValid = evidence.deterministicPolicyVersion === undefined
      ? evidence.deterministicResolvedCriterionIndexes === undefined
      : evidence.deterministicPolicyVersion === LAB_DETERMINISTIC_AUDIT_POLICY_VERSION
        && Array.isArray(deterministicIndexes)
        && deterministicIndexes.length > 0
        && deterministicIndexes.every((index) => Number.isInteger(index) && index >= 0)
        && new Set(deterministicIndexes).size === deterministicIndexes.length;
    return deterministicEvidenceValid
      && isSha256(artifact.aiReviewSha256)
      && isSha256(artifact.auditSha256)
      && Boolean(evidence.reviewModel?.trim())
      && Boolean(evidence.reviewPromptVersion?.trim())
      && evidence.reviewTransport === "claude-cli"
      && Boolean(evidence.auditModel?.trim())
      && Boolean(evidence.auditPromptVersion?.trim())
      && evidence.auditTransport === "claude-cli";
  }
  return false;
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function assertManifestConfirmation(
  manifest: PromotionReleaseManifest,
  confirmation: string | undefined,
): void {
  const prefix = confirmation?.trim().toLowerCase() ?? "";
  if (prefix.length < MIN_CONFIRM_HASH_PREFIX) {
    throw new Error(`--confirm은 manifest hash 앞 ${MIN_CONFIRM_HASH_PREFIX}자 이상이어야 합니다.`);
  }
  if (!manifest.manifestSha256.startsWith(prefix)) {
    throw new Error("--confirm 값이 manifest hash와 일치하지 않습니다.");
  }
}

export function promotionReleaseDir(releaseId: string): string {
  assertSafeReleaseId(releaseId);
  return join(analysisLabDir(), "releases", releaseId);
}

export function promotionReleaseArtifactPath(
  releaseId: string,
  name: "manifest.json" | "aggregate.json" | "shadow.json" | "dry-run.json"
    | "approval.json" | "verification.json" | "verification.canary.json" | "verification.all.json",
): string {
  return join(promotionReleaseDir(releaseId), name);
}

export async function writeImmutablePromotionArtifact(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

export async function readPromotionReleaseManifest(releaseId: string): Promise<PromotionReleaseManifest> {
  const path = promotionReleaseArtifactPath(releaseId, "manifest.json");
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  const manifest = validatePromotionReleaseManifest(parsed);
  if (manifest.releaseId !== releaseId) throw new Error("manifest releaseId와 경로가 일치하지 않습니다.");
  return manifest;
}

export async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function hashFileIfPresent(path: string): Promise<string | undefined> {
  try {
    return await hashFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function assertSafeReleaseId(releaseId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/.test(releaseId)) {
    throw new Error(`허용되지 않는 releaseId: ${releaseId}`);
  }
}
