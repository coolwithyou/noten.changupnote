import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  DEEP_ANALYSIS_SERVING_MONITOR_STALE_SECONDS,
  DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
  type DeepAnalysisStageKey,
} from "@cunote/contracts";
import { sha256Hex, stableJson } from "./sourceRevision";

export const DEEP_ANALYSIS_COHORT_REQUIRED_STAGES = [
  "source_fresh",
  "attachment_inventory_complete",
  "attachment_archive_complete",
  "attachment_text_complete",
  "input_coverage_verified",
  "input_sealed",
  "model_call_passed",
  "response_contract_valid",
  "axis_coverage_complete",
  "evidence_grounded",
  "independent_audit_passed",
  "analysis_complete",
] as const satisfies readonly DeepAnalysisStageKey[];

export const DEEP_ANALYSIS_COHORT_SERVING_STAGES = [
  "publication_complete",
  "serving_complete",
  "analysis_fresh",
] as const satisfies readonly DeepAnalysisStageKey[];

export type DeepAnalysisCohortServingStage =
  (typeof DEEP_ANALYSIS_COHORT_SERVING_STAGES)[number];

export interface DeepAnalysisCohortPromotion {
  itemId: string;
  itemStatus: string;
  releaseId: string;
  releaseStatus: string;
  afterSha256: string | null;
}

export interface DeepAnalysisCohortServingReceipt {
  status: string | null;
  verifierVersion: string | null;
  evidence: Record<string, unknown>;
  evidenceSha256: string | null;
  artifactKey: string | null;
  createdAt: Date | null;
}

export interface DeepAnalysisCohortObservationItem {
  grantId: string;
  source: string | null;
  sourceId: string | null;
  active: boolean;
  hasHwp: boolean;
  jobId: string | null;
  jobStatus: string | null;
  jobSourceRevisionSha256: string | null;
  runId: string | null;
  runStatus: string | null;
  runSourceRevisionSha256: string | null;
  runInputSha256: string | null;
  runStartedAt: Date | null;
  runCompletedAt: Date | null;
  stageStatuses: Partial<Record<DeepAnalysisStageKey, string>>;
  axisCount: number;
  auditVerdict: string | null;
  currentInputSealed: boolean;
  currentSourceRevisionSha256: string | null;
  currentInputSha256: string | null;
  currentInputBlockerCodes: string[];
  currentInputVerificationError: string | null;
  promotion: DeepAnalysisCohortPromotion | null;
  servingReceipts: Partial<
    Record<DeepAnalysisCohortServingStage, DeepAnalysisCohortServingReceipt>
  >;
  costUsdSinceActivation: number;
}

export interface DeepAnalysisCohortObservation {
  schema: "deep-analysis-cohort-observation-v2";
  verdict: "PASS" | "IN_PROGRESS" | "FAIL";
  generatedAt: string;
  activatedAt: string;
  claimCohortSha256: string;
  expectedCount: number;
  observedCount: number;
  activeCount: number;
  sourceCounts: Record<string, number>;
  hwpCount: number;
  outOfCohortRunCount: number;
  analysisCompleteCount: number;
  publicationCompleteCount: number;
  servingCompleteCount: number;
  analysisFreshCount: number;
  servingFreshCount: number;
  pendingCount: number;
  terminalFailureCount: number;
  totalCostUsd: number;
  maxPerGrantCostUsd: number;
  analysisLatencySeconds: {
    completedCount: number;
    average: number | null;
    p95: number | null;
    maximum: number | null;
  };
  failures: string[];
  items: Array<{
    grantId: string;
    source: string | null;
    sourceId: string | null;
    active: boolean;
    hasHwp: boolean;
    jobId: string | null;
    jobStatus: string | null;
    runId: string | null;
    runStatus: string | null;
    analysisComplete: boolean;
    publicationComplete: boolean;
    servingComplete: boolean;
    analysisFresh: boolean;
    servingFresh: boolean;
    promotionItemId: string | null;
    promotionReleaseId: string | null;
    axisCount: number;
    auditVerdict: string | null;
    currentInputSealed: boolean;
    currentInputBlockerCodes: string[];
    currentInputVerificationError: string | null;
    costUsdSinceActivation: number;
  }>;
}

export function evaluateDeepAnalysisCohortObservation(input: {
  activatedAt: Date;
  now: Date;
  claimCohortSha256: string;
  expectedCount: number;
  outOfCohortRunCount: number;
  servingReceiptMaxAgeMs?: number;
  items: readonly DeepAnalysisCohortObservationItem[];
}): DeepAnalysisCohortObservation {
  const failures: string[] = [];
  const uniqueGrantIds = new Set(input.items.map((item) => item.grantId));
  if (input.items.length !== input.expectedCount) {
    failures.push(
      `cohort_count_mismatch:${input.items.length}/${input.expectedCount}`,
    );
  }
  if (uniqueGrantIds.size !== input.items.length) {
    failures.push("cohort_grant_id_duplicate");
  }
  if (input.outOfCohortRunCount > 0) {
    failures.push(`out_of_cohort_run:${input.outOfCohortRunCount}`);
  }

  let analysisCompleteCount = 0;
  let publicationCompleteCount = 0;
  let servingCompleteCount = 0;
  let analysisFreshCount = 0;
  let servingFreshCount = 0;
  let pendingCount = 0;
  const terminalFailureGrantIds = new Set<string>();
  let totalCostUsd = 0;
  let maxPerGrantCostUsd = 0;
  const sourceCounts: Record<string, number> = {};
  const latencies: number[] = [];
  const servingStateByGrant = new Map<
    string,
    ReturnType<typeof evaluateCohortServingState>
  >();
  const servingReceiptMaxAgeMs = input.servingReceiptMaxAgeMs
    ?? DEEP_ANALYSIS_SERVING_MONITOR_STALE_SECONDS * 1_000;

  for (const item of input.items) {
    const label = item.grantId;
    const source = item.source ?? "missing";
    const stageAnalysisComplete = (
      item.stageStatuses.analysis_complete === "passed"
    );
    const runStartedAtMs = item.runStartedAt?.getTime() ?? null;
    const runBeforeActivation = (
      runStartedAtMs !== null
      && runStartedAtMs < input.activatedAt.getTime()
    );
    const analysisComplete = (
      stageAnalysisComplete
      && runStartedAtMs !== null
      && !runBeforeActivation
    );
    sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
    totalCostUsd += item.costUsdSinceActivation;
    maxPerGrantCostUsd = Math.max(maxPerGrantCostUsd, item.costUsdSinceActivation);

    if (runBeforeActivation) {
      failures.push(`run_before_activation:${label}`);
    }
    if (stageAnalysisComplete && runStartedAtMs === null) {
      failures.push(`analysis_complete_without_run_started_at:${label}`);
    }
    if (!item.active) failures.push(`inactive_grant:${label}`);
    if (!item.jobId) failures.push(`current_job_missing:${label}`);
    if (
      item.jobStatus === "blocked"
      || item.jobStatus === "dead_letter"
      || item.jobStatus === "canceled"
    ) {
      terminalFailureGrantIds.add(label);
      failures.push(`terminal_job:${label}:${item.jobStatus}`);
    }
    if (
      item.runStatus === "failed"
      || item.runStatus === "blocked"
      || item.runStatus === "stale"
    ) {
      terminalFailureGrantIds.add(label);
      failures.push(`terminal_run:${label}:${item.runStatus}`);
    }
    if (item.auditVerdict && item.auditVerdict !== "concur") {
      failures.push(`audit_${item.auditVerdict}:${label}`);
    }
    if (item.currentInputVerificationError) {
      failures.push(`input_verification_error:${label}`);
    }
    if (!item.currentInputSealed) {
      failures.push(`input_not_sealed:${label}`);
    }
    if (
      item.jobSourceRevisionSha256
      && item.currentSourceRevisionSha256
      && item.jobSourceRevisionSha256 !== item.currentSourceRevisionSha256
    ) {
      failures.push(`job_source_revision_stale:${label}`);
    }
    if (
      item.runSourceRevisionSha256
      && item.currentSourceRevisionSha256
      && item.runSourceRevisionSha256 !== item.currentSourceRevisionSha256
    ) {
      failures.push(`run_source_revision_stale:${label}`);
    }
    if (
      item.runInputSha256
      && item.currentInputSha256
      && item.runInputSha256 !== item.currentInputSha256
    ) {
      failures.push(`run_input_stale:${label}`);
    }
    if (
      item.costUsdSinceActivation
      > DEEP_ANALYSIS_DEFAULT_LIMITS.perNoticeCostCapUsd + 1e-9
    ) {
      failures.push(`per_grant_cost_cap:${label}`);
    }

    if (analysisComplete) {
      analysisCompleteCount += 1;
      if (item.runStatus !== "passed") {
        failures.push(`analysis_complete_run_not_passed:${label}`);
      }
      if (item.axisCount !== 22) failures.push(`axis_count:${label}:${item.axisCount}`);
      if (item.auditVerdict !== "concur") {
        failures.push(`analysis_complete_without_concur:${label}`);
      }
      for (const stage of DEEP_ANALYSIS_COHORT_REQUIRED_STAGES) {
        if (item.stageStatuses[stage] !== "passed") {
          failures.push(`required_stage:${label}:${stage}`);
        }
      }
      const servingState = evaluateCohortServingState({
        item,
        now: input.now,
        maxAgeMs: servingReceiptMaxAgeMs,
      });
      servingStateByGrant.set(label, servingState);
      failures.push(...servingState.failures);
      if (servingState.publicationComplete) publicationCompleteCount += 1;
      if (servingState.servingComplete) servingCompleteCount += 1;
      if (servingState.analysisFresh) analysisFreshCount += 1;
      if (servingState.servingFresh) servingFreshCount += 1;
    } else if (
      item.jobStatus !== "blocked"
      && item.jobStatus !== "dead_letter"
      && item.jobStatus !== "canceled"
      && item.runStatus !== "failed"
      && item.runStatus !== "blocked"
      && item.runStatus !== "stale"
    ) {
      pendingCount += 1;
    }
    if (item.jobStatus === "succeeded" && !analysisComplete) {
      failures.push(`succeeded_job_without_analysis_complete:${label}`);
    }
    if (item.runStatus === "passed" && !analysisComplete) {
      failures.push(`passed_run_without_analysis_complete:${label}`);
    }
    if (analysisComplete && item.runStartedAt && item.runCompletedAt) {
      latencies.push(Math.max(
        0,
        (item.runCompletedAt.getTime() - item.runStartedAt.getTime()) / 1_000,
      ));
    }
  }

  const cohortCostCapUsd = Math.min(
    DEEP_ANALYSIS_DEFAULT_LIMITS.dailyCostCapUsd,
    input.expectedCount * DEEP_ANALYSIS_DEFAULT_LIMITS.perNoticeCostCapUsd,
  );
  if (totalCostUsd > cohortCostCapUsd + 1e-9) {
    failures.push(`cohort_cost_cap:${totalCostUsd.toFixed(6)}/${cohortCostCapUsd}`);
  }
  const uniqueFailures = [...new Set(failures)].sort();
  const completed = servingFreshCount === input.expectedCount;
  const verdict = uniqueFailures.length > 0
    ? "FAIL"
    : completed
      ? "PASS"
      : "IN_PROGRESS";
  const sortedLatencies = [...latencies].sort((left, right) => left - right);
  const sumLatency = sortedLatencies.reduce((sum, value) => sum + value, 0);
  const p95Index = sortedLatencies.length === 0
    ? -1
    : Math.max(0, Math.ceil(sortedLatencies.length * 0.95) - 1);

  return {
    schema: "deep-analysis-cohort-observation-v2",
    verdict,
    generatedAt: input.now.toISOString(),
    activatedAt: input.activatedAt.toISOString(),
    claimCohortSha256: input.claimCohortSha256,
    expectedCount: input.expectedCount,
    observedCount: input.items.length,
    activeCount: input.items.filter((item) => item.active).length,
    sourceCounts,
    hwpCount: input.items.filter((item) => item.hasHwp).length,
    outOfCohortRunCount: input.outOfCohortRunCount,
    analysisCompleteCount,
    publicationCompleteCount,
    servingCompleteCount,
    analysisFreshCount,
    servingFreshCount,
    pendingCount,
    terminalFailureCount: terminalFailureGrantIds.size,
    totalCostUsd: roundUsd(totalCostUsd),
    maxPerGrantCostUsd: roundUsd(maxPerGrantCostUsd),
    analysisLatencySeconds: {
      completedCount: sortedLatencies.length,
      average: sortedLatencies.length > 0
        ? Math.round((sumLatency / sortedLatencies.length) * 1_000) / 1_000
        : null,
      p95: p95Index >= 0 ? sortedLatencies[p95Index] ?? null : null,
      maximum: sortedLatencies.at(-1) ?? null,
    },
    failures: uniqueFailures,
    items: input.items.map((item) => ({
      grantId: item.grantId,
      source: item.source,
      sourceId: item.sourceId,
      active: item.active,
      hasHwp: item.hasHwp,
      jobId: item.jobId,
      jobStatus: item.jobStatus,
      runId: item.runId,
      runStatus: item.runStatus,
      analysisComplete: (
        item.stageStatuses.analysis_complete === "passed"
        && item.runStartedAt !== null
        && item.runStartedAt.getTime() >= input.activatedAt.getTime()
      ),
      publicationComplete: (
        servingStateByGrant.get(item.grantId)?.publicationComplete ?? false
      ),
      servingComplete: (
        servingStateByGrant.get(item.grantId)?.servingComplete ?? false
      ),
      analysisFresh: (
        servingStateByGrant.get(item.grantId)?.analysisFresh ?? false
      ),
      servingFresh: (
        servingStateByGrant.get(item.grantId)?.servingFresh ?? false
      ),
      promotionItemId: item.promotion?.itemId ?? null,
      promotionReleaseId: item.promotion?.releaseId ?? null,
      axisCount: item.axisCount,
      auditVerdict: item.auditVerdict,
      currentInputSealed: item.currentInputSealed,
      currentInputBlockerCodes: item.currentInputBlockerCodes,
      currentInputVerificationError: item.currentInputVerificationError,
      costUsdSinceActivation: roundUsd(item.costUsdSinceActivation),
    })),
  };
}

function evaluateCohortServingState(input: {
  item: DeepAnalysisCohortObservationItem;
  now: Date;
  maxAgeMs: number;
}): {
  publicationComplete: boolean;
  servingComplete: boolean;
  analysisFresh: boolean;
  servingFresh: boolean;
  failures: string[];
} {
  const { item, now, maxAgeMs } = input;
  const failures: string[] = [];
  const label = item.grantId;
  const promotion = item.promotion;
  const validSha256 = (value: unknown): value is string =>
    typeof value === "string" && /^[0-9a-f]{64}$/.test(value);

  let promotionValid = true;
  if (!promotion) {
    promotionValid = false;
    failures.push(`promotion_missing:${label}`);
  } else {
    if (promotion.itemStatus !== "applied") {
      promotionValid = false;
      failures.push(`promotion_item_not_applied:${label}:${promotion.itemStatus}`);
    }
    if (promotion.releaseStatus !== "active") {
      promotionValid = false;
      failures.push(`promotion_release_not_active:${label}:${promotion.releaseStatus}`);
    }
    if (!validSha256(promotion.afterSha256)) {
      promotionValid = false;
      failures.push(`promotion_after_hash_invalid:${label}`);
    }
  }

  const receiptValid = new Map<DeepAnalysisCohortServingStage, boolean>();
  for (const stage of DEEP_ANALYSIS_COHORT_SERVING_STAGES) {
    const receipt = item.servingReceipts[stage];
    let valid = true;
    if (!receipt) {
      receiptValid.set(stage, false);
      failures.push(`serving_receipt_missing:${label}:${stage}`);
      continue;
    }
    if (receipt.status !== "passed") {
      valid = false;
      failures.push(`serving_receipt_not_passed:${label}:${stage}:${receipt.status ?? "null"}`);
    }
    if (receipt.verifierVersion !== DEEP_ANALYSIS_SERVING_VERIFIER_VERSION) {
      valid = false;
      failures.push(`serving_receipt_verifier_mismatch:${label}:${stage}`);
    }
    if (sha256Hex(stableJson(receipt.evidence)) !== receipt.evidenceSha256) {
      valid = false;
      failures.push(`serving_receipt_evidence_hash_mismatch:${label}:${stage}`);
    }
    if (!receipt.artifactKey) {
      valid = false;
      failures.push(`serving_receipt_artifact_missing:${label}:${stage}`);
    }
    const createdAtMs = receipt.createdAt?.getTime() ?? Number.NaN;
    const ageMs = now.getTime() - createdAtMs;
    if (
      !Number.isFinite(createdAtMs)
      || ageMs < 0
      || ageMs > maxAgeMs
    ) {
      valid = false;
      failures.push(`serving_receipt_stale:${label}:${stage}`);
    }
    if (
      !promotion
      || receipt.evidence.promotionItemId !== promotion.itemId
      || receipt.evidence.releaseId !== promotion.releaseId
    ) {
      valid = false;
      failures.push(`serving_receipt_promotion_mismatch:${label}:${stage}`);
    }

    if (stage === "publication_complete") {
      if (
        !promotion
        || receipt.evidence.expectedAfterSha256 !== promotion.afterSha256
        || receipt.evidence.actualAfterSha256 !== promotion.afterSha256
      ) {
        valid = false;
        failures.push(`publication_hash_mismatch:${label}`);
      }
    } else if (stage === "serving_complete") {
      const snapshotCriteriaSha256 = receipt.evidence.snapshotCriteriaSha256;
      const repositoryCriteriaSha256 = receipt.evidence.repositoryCriteriaSha256;
      if (
        !validSha256(snapshotCriteriaSha256)
        || snapshotCriteriaSha256 !== repositoryCriteriaSha256
      ) {
        valid = false;
        failures.push(`serving_repository_hash_mismatch:${label}`);
      }
      if (!validSha256(receipt.evidence.traceSha256)) {
        valid = false;
        failures.push(`serving_trace_hash_invalid:${label}`);
      }
    } else {
      if (
        receipt.evidence.runSourceRevisionSha256 !== item.runSourceRevisionSha256
        || receipt.evidence.currentSourceRevisionSha256
          !== item.currentSourceRevisionSha256
        || receipt.evidence.runSourceRevisionSha256
          !== receipt.evidence.currentSourceRevisionSha256
      ) {
        valid = false;
        failures.push(`analysis_fresh_source_hash_mismatch:${label}`);
      }
      if (
        receipt.evidence.runInputSha256 !== item.runInputSha256
        || receipt.evidence.currentInputSha256 !== item.currentInputSha256
        || receipt.evidence.runInputSha256 !== receipt.evidence.currentInputSha256
      ) {
        valid = false;
        failures.push(`analysis_fresh_input_hash_mismatch:${label}`);
      }
    }
    receiptValid.set(stage, valid);
  }

  const publicationComplete = (
    promotionValid && receiptValid.get("publication_complete") === true
  );
  const servingComplete = (
    publicationComplete && receiptValid.get("serving_complete") === true
  );
  const analysisFresh = receiptValid.get("analysis_fresh") === true;
  return {
    publicationComplete,
    servingComplete,
    analysisFresh,
    servingFresh: servingComplete && analysisFresh,
    failures,
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
