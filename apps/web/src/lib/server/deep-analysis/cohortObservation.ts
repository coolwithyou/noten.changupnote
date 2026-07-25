import {
  DEEP_ANALYSIS_DEFAULT_LIMITS,
  type DeepAnalysisStageKey,
} from "@cunote/contracts";

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
  costUsdSinceActivation: number;
}

export interface DeepAnalysisCohortObservation {
  schema: "deep-analysis-cohort-observation-v1";
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
  let pendingCount = 0;
  const terminalFailureGrantIds = new Set<string>();
  let totalCostUsd = 0;
  let maxPerGrantCostUsd = 0;
  const sourceCounts: Record<string, number> = {};
  const latencies: number[] = [];

  for (const item of input.items) {
    const label = item.grantId;
    const source = item.source ?? "missing";
    const analysisComplete = item.stageStatuses.analysis_complete === "passed";
    sourceCounts[source] = (sourceCounts[source] ?? 0) + 1;
    totalCostUsd += item.costUsdSinceActivation;
    maxPerGrantCostUsd = Math.max(maxPerGrantCostUsd, item.costUsdSinceActivation);

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
  const completed = analysisCompleteCount === input.expectedCount;
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
    schema: "deep-analysis-cohort-observation-v1",
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
      analysisComplete: item.stageStatuses.analysis_complete === "passed",
      axisCount: item.axisCount,
      auditVerdict: item.auditVerdict,
      currentInputSealed: item.currentInputSealed,
      currentInputBlockerCodes: item.currentInputBlockerCodes,
      currentInputVerificationError: item.currentInputVerificationError,
      costUsdSinceActivation: roundUsd(item.costUsdSinceActivation),
    })),
  };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
