import type { GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";
import type { DeepAnalysisInputSeal } from "./inputManifest";

export const ACTIVE_SERVING_MONITOR_SCHEMA = "deep-analysis-active-serving-monitor-v2" as const;
export const ACTIVE_SERVING_MONITOR_SENTINEL_LIMIT = 5_001;
export const ACTIVE_SERVING_MONITOR_ITEM_LOG_MAX_BYTES = 200 * 1_024;

export type ActiveServingMonitorReleaseStatus = "active" | "canary_passed";
export type ActiveServingMonitorEvidenceKind = "production_deep_run" | "verified_local_lab";
export type ActiveServingMonitorExclusionReason =
  | "superseded_binding"
  | "grant_missing"
  | "not_visible"
  | "confirmed_duplicate"
  | "inactive_status"
  | "deadline_elapsed"
  | "stale_undated"
  | "source_marked_closed";

export interface ActiveServingMonitorBinding {
  promotionItemId: string;
  releaseDbId: string;
  releaseId: string;
  releaseStatus: ActiveServingMonitorReleaseStatus;
  grantId: string;
  runId: string;
  planSha256: string;
  deepAnalysisRunId: string | null;
  evidenceKind: ActiveServingMonitorEvidenceKind;
  appliedAt: string | null;
  /** pre/post inventory에서 release/item/manifest 결속의 ABA를 탐지한다. */
  verificationBindingSha256: string;
}

export interface ActiveServingMonitorCandidate<
  TBinding extends ActiveServingMonitorBinding = ActiveServingMonitorBinding,
> {
  binding: TBinding;
  /** canonical reader가 제외한 경우에만 설정한다. null인데 목록에 없으면 불일치다. */
  canonicalExclusionReason: ActiveServingMonitorExclusionReason | null;
}

export interface ActiveServingMonitorIssue {
  code:
    | "canonical_id_missing"
    | "canonical_duplicate"
    | "sentinel_overflow"
    | "binding_missing"
    | "binding_applied_at_missing"
    | "binding_latest_ambiguous"
    | "canonical_reader_mismatch"
    | "canonical_exclusion_conflict";
  detail: string;
  grantId?: string;
  promotionItemId?: string;
}

export interface ActiveServingMonitorTarget<
  TEntry extends NormalizedGrant = NormalizedGrant,
  TBinding extends ActiveServingMonitorBinding = ActiveServingMonitorBinding,
> {
  entry: TEntry;
  binding: TBinding;
}

export interface ActiveServingMonitorPlan<
  TEntry extends NormalizedGrant = NormalizedGrant,
  TBinding extends ActiveServingMonitorBinding = ActiveServingMonitorBinding,
> {
  verdict: "READY" | "FAIL" | "NO_TARGETS";
  actualServingItems: number;
  admittedItems: number;
  targets: Array<ActiveServingMonitorTarget<TEntry, TBinding>>;
  excluded: Array<{
    promotionItemId: string;
    grantId: string;
    reason: ActiveServingMonitorExclusionReason;
  }>;
  issues: ActiveServingMonitorIssue[];
}

export type ActiveServingMonitorStageStatus = "passed" | "failed" | "error" | "not_reached";

export interface ActiveServingMonitorStageResult {
  status: ActiveServingMonitorStageStatus;
  issues: string[];
  evidence?: Record<string, unknown>;
}

export interface ActiveServingMonitorTargetResult {
  promotionItemId: string;
  grantId: string;
  releaseId: string;
  evidenceKind: ActiveServingMonitorEvidenceKind;
  verdict: "PASS" | "FAIL";
  publication: ActiveServingMonitorStageResult;
  serving: ActiveServingMonitorStageResult;
  freshness: ActiveServingMonitorStageResult;
}

export type LocalOperationalInputMaterialIssueCode =
  | "invalid_waiver"
  | "artifact_hash_mismatch"
  | "artifact_read_failed";

export interface LocalOperationalInputState {
  /** Operational preparation policy/cap gaps are telemetry, not local-lab source drift. */
  readinessBlockers: DeepAnalysisInputSeal["blockers"];
  /** Fail-closed integrity findings for artifacts the operational inventory claims exist. */
  materialIssues: Array<{
    code: LocalOperationalInputMaterialIssueCode;
    attachmentId: string | null;
  }>;
}

/**
 * Verified-local releases and operational inputs have different sealing contracts. Ordinary
 * fetch/conversion/cap gaps are readiness telemetry, while corruption of an artifact or waiver
 * that the operational inventory claims exists remains a material verification failure.
 */
export function classifyLocalOperationalInputState(
  input: Pick<DeepAnalysisInputSeal, "attachments" | "blockers">,
): LocalOperationalInputState {
  const attachmentById = new Map(input.attachments.map((attachment) => [
    attachment.id,
    attachment,
  ]));
  const readinessBlockers: DeepAnalysisInputSeal["blockers"] = [];
  const materialIssues: LocalOperationalInputState["materialIssues"] = [];

  for (const blocker of input.blockers) {
    if (blocker.code === "invalid_waiver") {
      materialIssues.push({ code: "invalid_waiver", attachmentId: blocker.attachmentId });
      continue;
    }
    const attachment = blocker.attachmentId
      ? attachmentById.get(blocker.attachmentId)
      : undefined;
    const referencedArtifact = Boolean(
      attachment?.markdownStorageKey && attachment.markdownSha256,
    );
    const reason = attachment?.dispositionReason ?? "";
    const ordinaryReadinessReason = reason === "markdown conversion 미완료"
      || reason === "원본 archive 미완료";
    if (referencedArtifact && !ordinaryReadinessReason) {
      materialIssues.push({
        code: /SHA-256 mismatch/i.test(reason)
          ? "artifact_hash_mismatch"
          : "artifact_read_failed",
        attachmentId: blocker.attachmentId,
      });
      continue;
    }
    readinessBlockers.push(blocker);
  }

  return { readinessBlockers, materialIssues };
}

export interface ActiveServingMonitorEvaluation {
  schema: typeof ACTIVE_SERVING_MONITOR_SCHEMA;
  verdict: "PASS" | "FAIL" | "NO_TARGETS";
  actualServingItems: number;
  admittedItems: number;
  checkedItems: number;
  passedItems: number;
  failedItems: number;
  unverifiedServingItems: number;
  excludedBindings: number;
  exclusionCounts: Partial<Record<ActiveServingMonitorExclusionReason, number>>;
  stageCounts: Record<
    "publication" | "serving" | "freshness",
    Record<ActiveServingMonitorStageStatus, number>
  >;
  coverageIssues: string[];
  results: ActiveServingMonitorTargetResult[];
}

export function summarizeActiveServingMonitorEvaluation(
  evaluation: ActiveServingMonitorEvaluation,
): Omit<ActiveServingMonitorEvaluation, "coverageIssues" | "results"> & {
  resultsCount: number;
  resultsSha256: string;
  coverageIssueCount: number;
  coverageIssues: string[];
  coverageIssuesSha256: string;
} {
  const { results, coverageIssues, ...summary } = evaluation;
  return {
    ...summary,
    resultsCount: results.length,
    resultsSha256: sha256Canonical(results),
    coverageIssueCount: coverageIssues.length,
    coverageIssues: coverageIssues.slice(0, 20).map((issue) => issue.slice(0, 512)),
    coverageIssuesSha256: sha256Canonical(coverageIssues),
  };
}

export function buildActiveServingMonitorPlan<
  TEntry extends NormalizedGrant,
  TBinding extends ActiveServingMonitorBinding,
>(input: {
  canonicalEntries: TEntry[];
  candidates: Array<ActiveServingMonitorCandidate<TBinding>>;
  sentinelLimit?: number;
}): ActiveServingMonitorPlan<TEntry, TBinding> {
  const sentinelLimit = input.sentinelLimit ?? ACTIVE_SERVING_MONITOR_SENTINEL_LIMIT;
  const issues: ActiveServingMonitorIssue[] = [];
  const entryByGrantId = new Map<string, TEntry>();
  for (const entry of input.canonicalEntries) {
    const grantId = entry.grant.id;
    if (!grantId) {
      issues.push({ code: "canonical_id_missing", detail: "canonical serving DTO has no grant ID" });
      continue;
    }
    if (entryByGrantId.has(grantId)) {
      issues.push({
        code: "canonical_duplicate",
        detail: "canonical serving reader returned a duplicate grant",
        grantId,
      });
      continue;
    }
    entryByGrantId.set(grantId, entry);
  }
  if (input.canonicalEntries.length >= sentinelLimit) {
    issues.push({
      code: "sentinel_overflow",
      detail: `canonical serving reader reached sentinel limit ${sentinelLimit}`,
    });
  }

  const candidatesByGrantId = new Map<string, Array<ActiveServingMonitorCandidate<TBinding>>>();
  for (const candidate of input.candidates) {
    const current = candidatesByGrantId.get(candidate.binding.grantId) ?? [];
    current.push(candidate);
    candidatesByGrantId.set(candidate.binding.grantId, current);
  }

  const targets: Array<ActiveServingMonitorTarget<TEntry, TBinding>> = [];
  const excluded: ActiveServingMonitorPlan<TEntry, TBinding>["excluded"] = [];
  for (const [grantId, entry] of entryByGrantId) {
    const candidates = candidatesByGrantId.get(grantId) ?? [];
    for (const candidate of candidates) {
      if (candidate.canonicalExclusionReason) {
        issues.push({
          code: "canonical_exclusion_conflict",
          detail: `canonical serving grant was classified as ${candidate.canonicalExclusionReason}`,
          grantId,
          promotionItemId: candidate.binding.promotionItemId,
        });
      }
    }
    if (candidates.length === 0) {
      issues.push({
        code: "binding_missing",
        detail: "canonical serving grant has no eligible applied active/canary binding",
        grantId,
      });
      continue;
    }
    const dated = candidates.flatMap((candidate) => {
      if (!candidate.binding.appliedAt) {
        issues.push({
          code: "binding_applied_at_missing",
          detail: "eligible applied binding has no appliedAt",
          grantId,
          promotionItemId: candidate.binding.promotionItemId,
        });
        return [];
      }
      const appliedAt = Date.parse(candidate.binding.appliedAt);
      if (!Number.isFinite(appliedAt)) {
        issues.push({
          code: "binding_applied_at_missing",
          detail: `eligible applied binding has invalid appliedAt ${candidate.binding.appliedAt}`,
          grantId,
          promotionItemId: candidate.binding.promotionItemId,
        });
        return [];
      }
      return [{ candidate, appliedAt }];
    }).sort((left, right) => right.appliedAt - left.appliedAt);
    const latestAt = dated[0]?.appliedAt;
    const latest = latestAt === undefined
      ? []
      : dated.filter((candidate) => candidate.appliedAt === latestAt);
    if (latest.length !== 1) {
      issues.push({
        code: latest.length === 0 ? "binding_missing" : "binding_latest_ambiguous",
        detail: latest.length === 0
          ? "canonical serving grant has no selectable applied binding"
          : `canonical serving grant has ${latest.length} bindings at the latest appliedAt`,
        grantId,
      });
      continue;
    }
    const selected = latest[0]!.candidate;
    targets.push({ entry, binding: selected.binding });
    for (const candidate of candidates) {
      if (candidate.binding.promotionItemId === selected.binding.promotionItemId) continue;
      excluded.push({
        promotionItemId: candidate.binding.promotionItemId,
        grantId,
        reason: "superseded_binding",
      });
    }
  }

  for (const candidate of input.candidates) {
    if (entryByGrantId.has(candidate.binding.grantId)) continue;
    if (!candidate.canonicalExclusionReason) {
      issues.push({
        code: "canonical_reader_mismatch",
        detail: "eligible binding grant was not returned and has no canonical exclusion reason",
        grantId: candidate.binding.grantId,
        promotionItemId: candidate.binding.promotionItemId,
      });
      continue;
    }
    excluded.push({
      promotionItemId: candidate.binding.promotionItemId,
      grantId: candidate.binding.grantId,
      reason: candidate.canonicalExclusionReason,
    });
  }

  const actualServingItems = entryByGrantId.size;
  return {
    verdict: issues.length > 0
      ? "FAIL"
      : actualServingItems === 0
        ? "NO_TARGETS"
        : targets.length === actualServingItems
          ? "READY"
          : "FAIL",
    actualServingItems,
    admittedItems: targets.length,
    targets,
    excluded,
    issues,
  };
}

export function evaluateActiveServingMonitor(input: {
  plan: ActiveServingMonitorPlan;
  results: ActiveServingMonitorTargetResult[];
  inventoryStable: boolean;
}): ActiveServingMonitorEvaluation {
  const coverageIssues = input.plan.issues.map((issue) => `${issue.code}:${issue.detail}`);
  if (!input.inventoryStable) coverageIssues.push("inventory_drift:pre/post serving inventory changed");
  const expectedByItemId = new Map(
    input.plan.targets.map((target) => [target.binding.promotionItemId, target]),
  );
  const seen = new Set<string>();
  const exactResults: ActiveServingMonitorTargetResult[] = [];
  for (const result of input.results) {
    if (seen.has(result.promotionItemId)) {
      coverageIssues.push(`result_duplicate:${result.promotionItemId}`);
      continue;
    }
    seen.add(result.promotionItemId);
    const expected = expectedByItemId.get(result.promotionItemId);
    if (!expected) {
      coverageIssues.push(`result_unexpected:${result.promotionItemId}`);
      continue;
    }
    const identityMatches = result.grantId === expected.binding.grantId
      && result.releaseId === expected.binding.releaseId
      && result.evidenceKind === expected.binding.evidenceKind;
    if (!identityMatches) {
      coverageIssues.push(`result_binding_mismatch:${result.promotionItemId}`);
      continue;
    }
    exactResults.push(result);
  }
  for (const promotionItemId of expectedByItemId.keys()) {
    if (!seen.has(promotionItemId)) coverageIssues.push(`result_missing:${promotionItemId}`);
  }
  for (const result of exactResults) {
    const stagesPassed = [result.publication, result.serving, result.freshness]
      .every((stage) => stage.status === "passed");
    if ((result.verdict === "PASS") !== stagesPassed) {
      coverageIssues.push(`result_verdict_mismatch:${result.promotionItemId}`);
    }
  }
  const checkedItems = exactResults.length;
  const passedItems = exactResults.filter((result) =>
    result.verdict === "PASS"
    && [result.publication, result.serving, result.freshness]
      .every((stage) => stage.status === "passed")).length;
  const failedItems = checkedItems - passedItems;
  const unverifiedServingItems = Math.max(0, input.plan.actualServingItems - checkedItems);
  const exclusionCounts: ActiveServingMonitorEvaluation["exclusionCounts"] = {};
  for (const item of input.plan.excluded) {
    exclusionCounts[item.reason] = (exclusionCounts[item.reason] ?? 0) + 1;
  }
  const stageCounts = Object.fromEntries(
    (["publication", "serving", "freshness"] as const).map((stage) => [
      stage,
      Object.fromEntries(
        (["passed", "failed", "error", "not_reached"] as const).map((status) => [
          status,
          exactResults.filter((result) => result[stage].status === status).length,
        ]),
      ),
    ]),
  ) as ActiveServingMonitorEvaluation["stageCounts"];
  if (input.plan.actualServingItems > 0 && checkedItems === 0) {
    coverageIssues.push("zero_checked_with_positive_supply:canonical serving supply is positive");
  }
  if (input.plan.admittedItems !== input.plan.actualServingItems) {
    coverageIssues.push(
      `admission_coverage_mismatch:${input.plan.admittedItems}/${input.plan.actualServingItems}`,
    );
  }
  if (checkedItems !== input.plan.admittedItems) {
    coverageIssues.push(`checked_coverage_mismatch:${checkedItems}/${input.plan.admittedItems}`);
  }
  const verdict = coverageIssues.length > 0 || failedItems > 0
    ? "FAIL"
    : input.plan.actualServingItems === 0
      ? "NO_TARGETS"
      : "PASS";
  return {
    schema: ACTIVE_SERVING_MONITOR_SCHEMA,
    verdict,
    actualServingItems: input.plan.actualServingItems,
    admittedItems: input.plan.admittedItems,
    checkedItems,
    passedItems,
    failedItems,
    unverifiedServingItems,
    excludedBindings: input.plan.excluded.length,
    exclusionCounts,
    stageCounts,
    coverageIssues,
    results: exactResults,
  };
}

export async function runActiveServingMonitorTargets<
  TEntry extends NormalizedGrant,
  TBinding extends ActiveServingMonitorBinding,
>(
  targets: Array<ActiveServingMonitorTarget<TEntry, TBinding>>,
  verify: (
    target: ActiveServingMonitorTarget<TEntry, TBinding>,
  ) => Promise<ActiveServingMonitorTargetResult>,
  onResult?: (result: ActiveServingMonitorTargetResult, index: number) => void,
): Promise<ActiveServingMonitorTargetResult[]> {
  const results: ActiveServingMonitorTargetResult[] = [];
  for (const [index, target] of targets.entries()) {
    let result: ActiveServingMonitorTargetResult;
    try {
      result = await verify(target);
    } catch (error) {
      result = {
        promotionItemId: target.binding.promotionItemId,
        grantId: target.binding.grantId,
        releaseId: target.binding.releaseId,
        evidenceKind: target.binding.evidenceKind,
        verdict: "FAIL",
        publication: {
          status: "error",
          issues: [error instanceof Error ? error.message : String(error)],
        },
        serving: { status: "not_reached", issues: [] },
        freshness: { status: "not_reached", issues: [] },
      };
    }
    results.push(result);
    onResult?.(result, index);
  }
  return results;
}

/** Cloud Logging 256KiB 한도 아래에서 target별 진행 증거를 한 JSON line으로 직렬화한다. */
export function serializeActiveServingMonitorItemLog(input: {
  monitorExecutionId: string;
  index: number;
  total: number;
  result: ActiveServingMonitorTargetResult;
  maxBytes?: number;
}): string {
  const resultSha256 = sha256Canonical(input.result);
  const full = {
    schema: "deep-analysis-active-serving-monitor-item-v1",
    monitorExecutionId: input.monitorExecutionId,
    index: input.index,
    total: input.total,
    resultSha256,
    truncated: false,
    result: input.result,
  };
  const fullJson = JSON.stringify(full);
  const maxBytes = input.maxBytes ?? ACTIVE_SERVING_MONITOR_ITEM_LOG_MAX_BYTES;
  if (Buffer.byteLength(fullJson) <= maxBytes) return fullJson;
  return JSON.stringify({
    schema: full.schema,
    monitorExecutionId: input.monitorExecutionId,
    index: input.index,
    total: input.total,
    resultSha256,
    truncated: true,
    result: {
      promotionItemId: input.result.promotionItemId,
      grantId: input.result.grantId,
      releaseId: input.result.releaseId,
      evidenceKind: input.result.evidenceKind,
      verdict: input.result.verdict,
      publication: compactStage(input.result.publication),
      serving: compactStage(input.result.serving),
      freshness: compactStage(input.result.freshness),
    },
  });
}

function compactStage(stage: ActiveServingMonitorStageResult): Record<string, unknown> {
  return {
    status: stage.status,
    issueCount: stage.issues.length,
    issueSamples: stage.issues.slice(0, 3).map((issue) =>
      issue.length <= 512 ? issue : `${issue.slice(0, 509)}...`),
    evidenceSha256: stage.evidence ? sha256Canonical(stage.evidence) : null,
  };
}

export function canonicalServingProjection(
  snapshotCriteria: Array<Record<string, unknown>>,
  repositoryCriteria: GrantCriterion[],
): {
  snapshotCriteriaSha256: string;
  repositoryCriteriaSha256: string;
  issues: string[];
} {
  const project = (criterion: Record<string, unknown>): Record<string, unknown> => ({
    id: criterion.id,
    dimension: criterion.dimension,
    operator: criterion.operator,
    value: criterion.value,
    kind: criterion.kind,
    weight: criterion.weight ?? null,
    confidence: criterion.confidence,
    sourceSpan: criterion.sourceSpan ?? criterion.source_span ?? null,
    rawText: criterion.rawText ?? criterion.raw_text ?? null,
    sourceField: criterion.sourceField ?? criterion.source_field ?? null,
    needsReview: criterion.needsReview ?? criterion.needs_review ?? false,
    parserVersion: criterion.parserVersion ?? criterion.parser_version ?? null,
  });
  const sort = (left: Record<string, unknown>, right: Record<string, unknown>) =>
    String(left.id).localeCompare(String(right.id));
  const snapshotCriteriaSha256 = sha256Canonical(snapshotCriteria.map(project).sort(sort));
  const repositoryCriteriaSha256 = sha256Canonical(
    repositoryCriteria.map((criterion) => project(criterion as unknown as Record<string, unknown>)).sort(sort),
  );
  return {
    snapshotCriteriaSha256,
    repositoryCriteriaSha256,
    issues: snapshotCriteriaSha256 === repositoryCriteriaSha256
      ? []
      : ["canonical serving DTO criteria hash가 promotion snapshot과 다릅니다."],
  };
}

export function activeServingMonitorInventorySha256(input: {
  canonicalEntries: NormalizedGrant[];
  candidates: Array<ActiveServingMonitorCandidate>;
}): string {
  return sha256Canonical({
    canonicalEntries: [...input.canonicalEntries]
      .map((entry) => {
        const { updated_at: _updatedAt, ...grant } = entry.grant;
        const { collected_at: _collectedAt, ...raw } = entry.raw;
        const { extraction_manifest: extractionManifest, ...entryWithoutManifest } = entry;
        if (!extractionManifest) return { ...entryWithoutManifest, grant, raw };
        const {
          completedAt: _completedAt,
          revision,
          ...materialExtractionManifest
        } = extractionManifest;
        const revisionUsesObservationFallback = !entry.raw.raw_hash && (
          revision === entry.raw.collected_at
          || revision === entry.grant.updated_at
        );
        return {
          ...entryWithoutManifest,
          grant,
          raw,
          extraction_manifest: {
            ...materialExtractionManifest,
            revision: revisionUsesObservationFallback
              ? "observation_timestamp_ignored"
              : revision,
          },
        };
      })
      .sort((left, right) => String(left.grant.id).localeCompare(String(right.grant.id))),
    candidates: [...input.candidates]
      .map(({ binding, canonicalExclusionReason }) => ({
        binding: {
          promotionItemId: binding.promotionItemId,
          releaseDbId: binding.releaseDbId,
          releaseId: binding.releaseId,
          releaseStatus: binding.releaseStatus,
          grantId: binding.grantId,
          runId: binding.runId,
          planSha256: binding.planSha256,
          deepAnalysisRunId: binding.deepAnalysisRunId,
          evidenceKind: binding.evidenceKind,
          appliedAt: binding.appliedAt,
          verificationBindingSha256: binding.verificationBindingSha256,
        },
        canonicalExclusionReason,
      }))
      .sort((left, right) =>
        left.binding.promotionItemId.localeCompare(right.binding.promotionItemId)),
  });
}
