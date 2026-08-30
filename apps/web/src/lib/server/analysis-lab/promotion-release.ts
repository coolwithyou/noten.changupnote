import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeepAnalysisPromotionReadiness } from "../deep-analysis/promotion";
import type { DeepRepairPromotionReadiness } from "./deep-repair-promotion";
import type { AnalysisLaunchPromotionReadiness } from "./analysis-launch-promotion";
import type { GrantPromotionPlan } from "./promote";
import {
  validatePromotionApplicationPrecomputeEvidence,
  type PromotionApplicationPrecomputeEvidence,
} from "./application-precompute-release";
import { LAB_DETERMINISTIC_AUDIT_POLICY_VERSION } from "./deterministic-audit-resolution";
import { analysisLabDir } from "./run-store";

export const PROMOTION_RELEASE_SCHEMA = "analysis-lab-promotion-release-v1" as const;
export const PROMOTION_AGGREGATE_SCHEMA = "analysis-lab-promotion-aggregate-v2" as const;
export const PROMOTION_DRY_RUN_SCHEMA = "analysis-lab-promotion-dry-run-v1" as const;
export const PROMOTION_APPROVAL_SCHEMA = "analysis-lab-promotion-approval-v1" as const;
export const VERIFIED_LOCAL_LAB_SOURCE_SCHEMA = "verified-local-lab-source-v1" as const;
export const VERIFIED_DEEP_REPAIR_SOURCE_SCHEMA = "verified-deep-repair-source-v1" as const;
export const VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA = "verified-analysis-launch-source-v1" as const;
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
  reviewMethod:
    | "human"
    | "ai_audit"
    | "deep_repair_receipt"
    | "analysis_launch_independent_review";
  reviewModel?: string;
  reviewPromptVersion?: string;
  reviewTransport?: "claude-cli";
  auditModel?: string;
  auditPromptVersion?: string;
  auditTransport?: "claude-cli";
  deterministicPolicyVersion?: string;
  deterministicResolvedCriterionIndexes?: number[];
  deepRepair?: VerifiedDeepRepairSourceEvidence;
  analysisLaunch?: VerifiedAnalysisLaunchSourceEvidence;
}

/**
 * deep-repair 실험의 통계 판정과 출시 자격을 분리한 source provenance.
 * terminal/evaluator receipt는 실행 결속만 증명하고, 실제 출시 분류는 해당 run의
 * publishable/readiness/repair transition과 prepare 시점 current revision이 소유한다.
 */
export interface VerifiedDeepRepairSourceEvidence {
  schema: typeof VERIFIED_DEEP_REPAIR_SOURCE_SCHEMA;
  seriesId: string;
  sequence: number;
  proposalSha256: string;
  planSha256: string;
  planArtifactSha256: string;
  manifestSha256: string;
  receiptSha256: string;
  observationsSha256: string;
  evaluatorReceiptSha256: string;
  attachmentManifestSha256: string;
  sourceRevisionSha256: string;
  executionGitSha: string;
  packageRuntimeSha256: string;
  validatorVersion: string;
}

/** formal launch, 구독 실행, target별 Codex 독립 검수 PASS를 한 source로 봉인한다. */
export interface VerifiedAnalysisLaunchSourceEvidence {
  schema: typeof VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA;
  launchReceiptSha256: string;
  launchManifestSha256: string;
  launchGrantSha256: string;
  launchSequence: number;
  independentReviewManifestSha256: string;
  independentReviewAggregateSha256: string;
  attachmentManifestSha256: string;
  sourceRevisionSha256: string;
  executionGitSha: string;
  packageRuntimeSha256: string;
  validatorVersion: string;
  applicationFieldAnalysisVersion: string;
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
  /** local deep-repair receipt 기반 closed-beta 분류와 current revision 결속. */
  deepRepairReadiness?: DeepRepairPromotionReadiness;
  /** formal launch + target별 독립 검수 PASS 기반 분류와 current revision 결속. */
  analysisLaunchReadiness?: AnalysisLaunchPromotionReadiness;
  beforeCriteriaSha256: string;
  beforeQuestionsSha256: string;
  dedupComponentSha256: string;
  criteriaCountBefore: number;
  criteriaCountAfter: number;
  questionCountAfter: number;
  pendingCount: number;
  downgradedCount: number;
  /** 기록 이전 release(undefined)는 legacy API 실행으로 해석한다. */
  transport?: "api" | "claude-cli";
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

/**
 * transport 도입 전 release는 plan 대신 source artifact에만 실행 provenance가 있다.
 * 명시값은 manifest 검증 후 사용하고, legacy는 검증된 local source만 구독으로 복원한다.
 */
export function resolvePromotionReleaseTransport(
  plan: Pick<PromotionReleasePlanItem, "transport">,
  source: PromotionSourceArtifact | undefined,
): "api" | "claude-cli" {
  if (plan.transport !== undefined) return plan.transport;
  if (!source || source.deepAnalysisRunId) return "api";
  return isVerifiedLocalLabSourceArtifact(source) ? "claude-cli" : "api";
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

export interface PromotionReleaseContinuationBinding {
  plans: PromotionReleasePlanItem[];
  sourceArtifacts: PromotionSourceArtifact[];
}

/**
 * 실패한 immutable gate를 새 release revision으로 다시 실행할 때의 권한 상속 경계.
 *
 * source revision 문자열만 바뀌었다는 이유로 사용자 승인을 다시 요구하지 않되, 같은 run,
 * 분석 입력, 첨부 manifest, 승격 plan, 현재 DB snapshot 결속은 모두 그대로여야 한다. 이
 * 함수가 허용하는 유일한 차이는 current source provenance를 다시 봉인한 두 revision 필드다.
 */
export function assertPromotionReleaseContinuationBinding(
  previous: Pick<PromotionReleaseManifest, "plans" | "sourceArtifacts">,
  current: PromotionReleaseContinuationBinding,
): { refreshedSourceGrantIds: string[] } {
  const previousPlans = new Map(previous.plans.map((item) => [item.grantId, item]));
  const currentPlans = new Map(current.plans.map((item) => [item.grantId, item]));
  const previousSources = new Map(previous.sourceArtifacts.map((item) => [item.grantId, item]));
  const currentSources = new Map(current.sourceArtifacts.map((item) => [item.grantId, item]));
  const grantIds = [...new Set([
    ...previousPlans.keys(),
    ...currentPlans.keys(),
    ...previousSources.keys(),
    ...currentSources.keys(),
  ])].sort();
  const changed: string[] = [];
  const refreshedSourceGrantIds: string[] = [];

  for (const grantId of grantIds) {
    const previousPlan = previousPlans.get(grantId);
    const currentPlan = currentPlans.get(grantId);
    const previousSource = previousSources.get(grantId);
    const currentSource = currentSources.get(grantId);
    if (!previousPlan || !currentPlan || !previousSource || !currentSource) {
      changed.push(`${grantId}:cohort_binding`);
      continue;
    }
    if (
      sha256Canonical(continuationPlanProjection(previousPlan))
      !== sha256Canonical(continuationPlanProjection(currentPlan))
    ) {
      changed.push(`${grantId}:promotion_material`);
    }
    if (
      sha256Canonical(continuationSourceProjection(previousSource))
      !== sha256Canonical(continuationSourceProjection(currentSource))
    ) {
      changed.push(`${grantId}:source_material`);
    }
    if (previousSource.sourceRevisionSha256 !== currentSource.sourceRevisionSha256) {
      refreshedSourceGrantIds.push(grantId);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `이전 failed release와 현재 promotion material 결속이 다릅니다: ${changed.join(", ")}`,
    );
  }
  return { refreshedSourceGrantIds };
}

function continuationPlanProjection(item: PromotionReleasePlanItem): PromotionReleasePlanItem {
  if (item.analysisLaunchReadiness) {
    return {
      ...item,
      analysisLaunchReadiness: {
        ...item.analysisLaunchReadiness,
        sourceRevisionSha256: "current-source-revision",
      },
    };
  }
  if (!item.deepRepairReadiness) return item;
  return {
    ...item,
    deepRepairReadiness: {
      ...item.deepRepairReadiness,
      sourceRevisionSha256: "current-source-revision",
    },
  };
}

function continuationSourceProjection(item: PromotionSourceArtifact): PromotionSourceArtifact {
  const deepRepair = item.localLabEvidence?.deepRepair;
  const analysisLaunch = item.localLabEvidence?.analysisLaunch;
  if (analysisLaunch) {
    return {
      ...item,
      sourceRevisionSha256: "current-source-revision",
      ...(item.applicationPrecompute
        ? {
            applicationPrecompute: {
              ...item.applicationPrecompute,
              releaseId: "current-release-revision",
            },
          }
        : {}),
      localLabEvidence: {
        ...item.localLabEvidence!,
        analysisLaunch: {
          ...analysisLaunch,
          sourceRevisionSha256: "current-source-revision",
        },
      },
    };
  }
  if (!deepRepair) return item;
  return {
    ...item,
    sourceRevisionSha256: "current-source-revision",
    ...(item.applicationPrecompute
      ? {
          applicationPrecompute: {
            ...item.applicationPrecompute,
            releaseId: "current-release-revision",
          },
        }
      : {}),
    localLabEvidence: {
      ...item.localLabEvidence!,
      deepRepair: {
        ...deepRepair,
        sourceRevisionSha256: "current-source-revision",
      },
    },
  };
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
        deepRepairReadiness: item.deepRepairReadiness,
        analysisLaunchReadiness: item.analysisLaunchReadiness,
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

export function isPromotableAnalysisRelease(
  plans: readonly Pick<PromotionReleasePlanItem, "deepAnalysisReadiness" | "promotionPlan">[],
): boolean {
  return plans.length > 0
    && plans.every((item) => {
      if (
        item.promotionPlan.origin === "deep_repair"
        || item.promotionPlan.auditState === "deep_repair_receipt"
      ) {
        return isDeepRepairReceiptAcceptedPlan(item.promotionPlan);
      }
      if (
        item.promotionPlan.origin === "analysis_launch"
        || item.promotionPlan.auditState === "analysis_launch_independent_review"
      ) {
        return isAnalysisLaunchAcceptedPlan(item.promotionPlan);
      }
      if (item.deepAnalysisReadiness !== undefined) {
        return isPromotableDeepAnalysisReadiness(item.deepAnalysisReadiness);
      }
      return isAuditedLocalAcceptedPlan(item.promotionPlan);
    });
}

export function isDeepRepairReceiptAcceptedPlan(plan: GrantPromotionPlan): boolean {
  return plan.origin === "deep_repair"
    && plan.auditState === "deep_repair_receipt"
    && plan.resolutions.length > 0
    && plan.resolutions.every((resolution) => resolution.state === "deep_repair_receipt")
    && plan.conversion.error === null
    && plan.conversion.dropped === (plan.scopeRejectedCriterionIndexes?.length ?? -1);
}

export function isAnalysisLaunchAcceptedPlan(plan: GrantPromotionPlan): boolean {
  return plan.origin === "analysis_launch"
    && plan.auditState === "analysis_launch_independent_review"
    && plan.resolutions.length > 0
    && plan.resolutions.every((resolution) => resolution.state === "analysis_launch_reviewed")
    && plan.conversion.error === null
    && plan.conversion.dropped === (plan.scopeRejectedCriterionIndexes?.length ?? -1);
}

/**
 * 독립 감사된 local canary의 reviewRisk가 blocked가 아니면 승격 가드가 받아들인다.
 * verified는 conditional보다 강한 판정이므로, 변환 과정에서 text_only 등이
 * needs_review로 강등됐다는 이유만으로 더 약한 conditional보다 엄격히 막아서는 안 된다.
 * 두 경우 모두 matcher는 needs_review를 unknown으로 보존한다.
 */
function isAuditedLocalAcceptedPlan(plan: GrantPromotionPlan): boolean {
  return plan.origin === "audited"
    && (plan.auditState === "ai_audit_concur" || plan.auditState === "deterministic_contract")
    && (plan.reviewRisk?.disposition === "verified" || plan.reviewRisk?.disposition === "conditional")
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
  if (isAuditedLocalAcceptedPlan(item.promotionPlan)) return false;
  if (isDeepRepairReceiptAcceptedPlan(item.promotionPlan)) return false;
  if (isAnalysisLaunchAcceptedPlan(item.promotionPlan)) return false;
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
  if (isDeepRepairReceiptAcceptedPlan(plan)) return false;
  if (isAnalysisLaunchAcceptedPlan(plan)) return false;
  return !(
    options.auditedLocalCanary === true
    && plan.origin === "audited"
    && (plan.auditState === "ai_audit_concur" || plan.auditState === "deterministic_contract")
    && (plan.reviewRisk?.disposition === "verified" || plan.reviewRisk?.disposition === "conditional")
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
  const artifactGrantIds = new Set<string>();
  for (const source of typed.sourceArtifacts) {
    if (artifactGrantIds.has(source.grantId)) {
      throw new Error(`source artifact grant 중복: ${source.grantId}`);
    }
    artifactGrantIds.add(source.grantId);
  }
  const sourceArtifactByGrantId = new Map(
    typed.sourceArtifacts.map((item) => [item.grantId, item]),
  );
  for (const source of typed.sourceArtifacts) {
    if (source.deepAnalysisRunId && source.localLabEvidence) {
      throw new Error(`release source provenance는 상호배타여야 합니다: ${source.grantId}`);
    }
  }
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
    const source = sourceArtifactByGrantId.get(item.grantId);
    if (source?.runId !== item.promotionPlan.runId) {
      throw new Error(`release source runId가 promotion plan과 불일치합니다: ${item.grantId}`);
    }
    if (item.transport !== undefined) {
      const sourceTransport = resolvePromotionReleaseTransport({}, source);
      if (item.transport !== sourceTransport) {
        throw new Error(`release transport provenance 불일치: ${item.grantId}`);
      }
    }
    if (item.deepAnalysisReadiness !== undefined) {
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
    if (item.promotionPlan.origin === "deep_repair") {
      const readiness = item.deepRepairReadiness;
      const evidence = source?.localLabEvidence?.deepRepair;
      if (
        !readiness
        || (readiness.disposition !== "ready" && readiness.disposition !== "conditional")
        || readiness.reasons.length > 0
        || source?.localLabEvidence?.reviewMethod !== "deep_repair_receipt"
        || !evidence
        || evidence.receiptSha256 !== readiness.receiptSha256
        || evidence.sourceRevisionSha256 !== readiness.sourceRevisionSha256
        || source.localLabEvidence.inputSha256 !== readiness.inputSha256
        || evidence.attachmentManifestSha256 !== readiness.attachmentManifestSha256
        || item.promotionPlan.conversion.error !== null
        || item.promotionPlan.conversion.dropped
          !== (item.promotionPlan.scopeRejectedCriterionIndexes?.length ?? -1)
      ) {
        throw new Error(`deep-repair readiness 불일치: ${item.grantId}`);
      }
    } else if (item.deepRepairReadiness !== undefined) {
      throw new Error(`deep-repair plan 없는 readiness: ${item.grantId}`);
    }
    if (item.promotionPlan.origin === "analysis_launch") {
      const readiness = item.analysisLaunchReadiness;
      const evidence = source?.localLabEvidence?.analysisLaunch;
      if (
        !readiness
        || (readiness.disposition !== "ready" && readiness.disposition !== "conditional")
        || readiness.reasons.length > 0
        || source?.localLabEvidence?.reviewMethod !== "analysis_launch_independent_review"
        || !evidence
        || evidence.launchReceiptSha256 !== readiness.launchReceiptSha256
        || evidence.independentReviewAggregateSha256 !== readiness.independentReviewAggregateSha256
        || evidence.sourceRevisionSha256 !== readiness.sourceRevisionSha256
        || source.localLabEvidence.inputSha256 !== readiness.inputSha256
        || evidence.attachmentManifestSha256 !== readiness.attachmentManifestSha256
        || Boolean(source.applicationPrecompute)
          !== Boolean(readiness.applicationRoundtripRunId)
        || item.promotionPlan.conversion.error !== null
        || item.promotionPlan.conversion.dropped
          !== (item.promotionPlan.scopeRejectedCriterionIndexes?.length ?? -1)
      ) {
        throw new Error(`analysis-launch readiness 불일치: ${item.grantId}`);
      }
    } else if (item.analysisLaunchReadiness !== undefined) {
      throw new Error(`analysis-launch plan 없는 readiness: ${item.grantId}`);
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
      const launchAdmission = artifact.applicationPrecompute.launchAdmission;
      const launchSource = artifact.localLabEvidence?.analysisLaunch;
      if (launchAdmission && (
        !launchSource
        || launchAdmission.launchReceiptSha256 !== launchSource.launchReceiptSha256
        || launchAdmission.launchManifestSha256 !== launchSource.launchManifestSha256
        || launchAdmission.launchGrantSha256 !== launchSource.launchGrantSha256
        || launchAdmission.launchSequence !== launchSource.launchSequence
        || launchAdmission.independentReviewManifestSha256
          !== launchSource.independentReviewManifestSha256
        || launchAdmission.independentReviewAggregateSha256
          !== launchSource.independentReviewAggregateSha256
        || launchAdmission.runArtifactSha256 !== artifact.runSha256
        || launchAdmission.applicationFieldAnalysisVersion
          !== launchSource.applicationFieldAnalysisVersion
      )) {
        throw new Error(`formal launch RHWP release evidence 결속이 올바르지 않습니다: ${artifact.grantId}`);
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
  if (evidence.reviewMethod === "deep_repair_receipt") {
    const deepRepair = evidence.deepRepair;
    return deepRepair?.schema === VERIFIED_DEEP_REPAIR_SOURCE_SCHEMA
      && Boolean(deepRepair.seriesId.trim())
      && Number.isInteger(deepRepair.sequence)
      && deepRepair.sequence >= 0
      && isSha256(deepRepair.proposalSha256)
      && isSha256(deepRepair.planSha256)
      && isSha256(deepRepair.planArtifactSha256)
      && isSha256(deepRepair.manifestSha256)
      && isSha256(deepRepair.receiptSha256)
      && isSha256(deepRepair.observationsSha256)
      && isSha256(deepRepair.evaluatorReceiptSha256)
      && isSha256(deepRepair.attachmentManifestSha256)
      && isSha256(deepRepair.sourceRevisionSha256)
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(deepRepair.executionGitSha)
      && isSha256(deepRepair.packageRuntimeSha256)
      && Boolean(deepRepair.validatorVersion.trim())
      && artifact.sourceRevisionSha256 === deepRepair.sourceRevisionSha256
      && artifact.aiReviewSha256 === undefined
      && artifact.auditSha256 === undefined
      && artifact.reviewSha256 === undefined;
  }
  if (evidence.reviewMethod === "analysis_launch_independent_review") {
    const launch = evidence.analysisLaunch;
    return launch?.schema === VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA
      && isSha256(launch.launchReceiptSha256)
      && isSha256(launch.launchManifestSha256)
      && isSha256(launch.launchGrantSha256)
      && Number.isInteger(launch.launchSequence)
      && launch.launchSequence >= 0
      && isSha256(launch.independentReviewManifestSha256)
      && isSha256(launch.independentReviewAggregateSha256)
      && isSha256(launch.attachmentManifestSha256)
      && isSha256(launch.sourceRevisionSha256)
      && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(launch.executionGitSha)
      && isSha256(launch.packageRuntimeSha256)
      && Boolean(launch.validatorVersion.trim())
      && Boolean(launch.applicationFieldAnalysisVersion.trim())
      && artifact.sourceRevisionSha256 === launch.sourceRevisionSha256
      && artifact.aiReviewSha256 === undefined
      && artifact.auditSha256 === undefined
      && artifact.reviewSha256 === undefined;
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
