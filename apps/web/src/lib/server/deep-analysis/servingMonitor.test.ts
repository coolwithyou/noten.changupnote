import assert from "node:assert/strict";
import test from "node:test";
import type { GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import {
  activeServingMonitorInventorySha256,
  buildActiveServingMonitorPlan,
  canonicalServingProjection,
  classifyLocalOperationalInputState,
  evaluateActiveServingMonitor,
  runActiveServingMonitorTargets,
  serializeActiveServingMonitorItemLog,
  summarizeActiveServingMonitorEvaluation,
  type ActiveServingMonitorBinding,
  type ActiveServingMonitorTarget,
  type ActiveServingMonitorTargetResult,
} from "./servingMonitor";

function grantEntry(id: string): NormalizedGrant<Record<string, never>> {
  return {
    raw: {
      source: "bizinfo",
      source_id: `source-${id}`,
      payload: {},
      status: "published",
    },
    grant: {
      id,
      source: "bizinfo",
      source_id: `source-${id}`,
      title: `공고 ${id}`,
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria: [],
  };
}

function binding(
  promotionItemId: string,
  grantId: string,
  overrides: Partial<ActiveServingMonitorBinding> = {},
): ActiveServingMonitorBinding {
  return {
    promotionItemId,
    releaseDbId: `release-db-${promotionItemId}`,
    releaseId: `release-${promotionItemId}`,
    releaseStatus: "active",
    grantId,
    runId: `run-${promotionItemId}`,
    planSha256: `plan-${promotionItemId}`,
    deepAnalysisRunId: null,
    evidenceKind: "production_deep_run",
    appliedAt: "2026-09-09T00:00:00.000Z",
    verificationBindingSha256: `verification-${promotionItemId}`,
    ...overrides,
  };
}

function target(
  promotionItemId: string,
  grantId: string,
): ActiveServingMonitorTarget<NormalizedGrant<Record<string, never>>, ActiveServingMonitorBinding> {
  return {
    entry: grantEntry(grantId),
    binding: binding(promotionItemId, grantId),
  };
}

function passingResult(
  value: ActiveServingMonitorTarget<NormalizedGrant<Record<string, never>>, ActiveServingMonitorBinding>,
): ActiveServingMonitorTargetResult {
  return {
    promotionItemId: value.binding.promotionItemId,
    grantId: value.binding.grantId,
    releaseId: value.binding.releaseId,
    evidenceKind: value.binding.evidenceKind,
    verdict: "PASS",
    publication: { status: "passed", issues: [] },
    serving: { status: "passed", issues: [] },
    freshness: { status: "passed", issues: [] },
  };
}

test("verified local active candidate is admitted", () => {
  const localBinding = binding("item-local", "grant-local", {
    evidenceKind: "verified_local_lab",
    releaseStatus: "active",
  });
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [grantEntry("grant-local")],
    candidates: [{ binding: localBinding, canonicalExclusionReason: null }],
  });

  assert.equal(plan.verdict, "READY");
  assert.equal(plan.admittedItems, 1);
  assert.equal(plan.targets[0]?.binding, localBinding);
  assert.deepEqual(plan.issues, []);
});

test("production canary candidate is admitted", () => {
  const productionBinding = binding("item-production", "grant-production", {
    evidenceKind: "production_deep_run",
    releaseStatus: "canary_passed",
  });
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [grantEntry("grant-production")],
    candidates: [{ binding: productionBinding, canonicalExclusionReason: null }],
  });

  assert.equal(plan.verdict, "READY");
  assert.equal(plan.targets[0]?.binding, productionBinding);
});

test("mixed local and production candidates select the latest binding independent of evidence kind and status", () => {
  const olderProduction = binding("item-production-old", "grant-mixed", {
    evidenceKind: "production_deep_run",
    releaseStatus: "active",
    appliedAt: "2026-09-08T00:00:00.000Z",
  });
  const newerLocalCanary = binding("item-local-new", "grant-mixed", {
    evidenceKind: "verified_local_lab",
    releaseStatus: "canary_passed",
    appliedAt: "2026-09-09T00:00:00.000Z",
  });
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [grantEntry("grant-mixed")],
    candidates: [
      { binding: olderProduction, canonicalExclusionReason: null },
      { binding: newerLocalCanary, canonicalExclusionReason: null },
    ],
  });

  assert.equal(plan.verdict, "READY");
  assert.equal(plan.targets[0]?.binding, newerLocalCanary);
  assert.deepEqual(plan.excluded, [{
    promotionItemId: olderProduction.promotionItemId,
    grantId: "grant-mixed",
    reason: "superseded_binding",
  }]);
});

test("latest appliedAt wins even when candidates arrive newest-first", () => {
  const oldest = binding("item-oldest", "grant-latest", {
    appliedAt: "2026-09-07T00:00:00.000Z",
  });
  const latest = binding("item-latest", "grant-latest", {
    appliedAt: "2026-09-09T00:00:00.000Z",
  });
  const middle = binding("item-middle", "grant-latest", {
    appliedAt: "2026-09-08T00:00:00.000Z",
  });
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [grantEntry("grant-latest")],
    candidates: [
      { binding: latest, canonicalExclusionReason: null },
      { binding: oldest, canonicalExclusionReason: null },
      { binding: middle, canonicalExclusionReason: null },
    ],
  });

  assert.equal(plan.verdict, "READY");
  assert.equal(plan.targets[0]?.binding.promotionItemId, "item-latest");
  assert.deepEqual(
    plan.excluded.map((item) => item.promotionItemId),
    ["item-oldest", "item-middle"],
  );
});

test("bindings tied at the latest instant fail closed", () => {
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [grantEntry("grant-tied")],
    candidates: [
      {
        binding: binding("item-tied-z", "grant-tied", {
          appliedAt: "2026-09-09T00:00:00.000Z",
        }),
        canonicalExclusionReason: null,
      },
      {
        binding: binding("item-tied-offset", "grant-tied", {
          appliedAt: "2026-09-09T09:00:00.000+09:00",
        }),
        canonicalExclusionReason: null,
      },
    ],
  });

  assert.equal(plan.verdict, "FAIL");
  assert.equal(plan.admittedItems, 0);
  assert.equal(plan.targets.length, 0);
  assert.ok(plan.issues.some((issue) => issue.code === "binding_latest_ambiguous"));
});

test("a null appliedAt binding cannot be selected", () => {
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [grantEntry("grant-undated")],
    candidates: [{
      binding: binding("item-undated", "grant-undated", { appliedAt: null }),
      canonicalExclusionReason: null,
    }],
  });

  assert.equal(plan.verdict, "FAIL");
  assert.equal(plan.admittedItems, 0);
  assert.equal(plan.targets.length, 0);
  assert.ok(plan.issues.some((issue) =>
    issue.code === "binding_applied_at_missing"
    && issue.promotionItemId === "item-undated"));
  assert.ok(plan.issues.some((issue) => issue.code === "binding_missing"));
});

test("only a truly empty inventory returns NO_TARGETS", () => {
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [],
    candidates: [],
  });

  assert.equal(plan.verdict, "NO_TARGETS");
  assert.equal(plan.actualServingItems, 0);
  assert.equal(plan.admittedItems, 0);
  assert.deepEqual(plan.targets, []);
  assert.deepEqual(plan.excluded, []);
  assert.deepEqual(plan.issues, []);
});

test("zero canonical entries with an unexplained eligible candidate is FAIL, not NO_TARGETS", () => {
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [],
    candidates: [{
      binding: binding("item-reader-mismatch", "grant-reader-mismatch"),
      canonicalExclusionReason: null,
    }],
  });

  assert.equal(plan.verdict, "FAIL");
  assert.equal(plan.actualServingItems, 0);
  assert.equal(plan.admittedItems, 0);
  assert.deepEqual(plan.issues.map((issue) => issue.code), ["canonical_reader_mismatch"]);
});

test("reaching the sentinel limit fails the plan even when every returned grant has a binding", () => {
  const sentinelBinding = binding("item-sentinel", "grant-sentinel");
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [grantEntry("grant-sentinel")],
    candidates: [{ binding: sentinelBinding, canonicalExclusionReason: null }],
    sentinelLimit: 1,
  });

  assert.equal(plan.verdict, "FAIL");
  assert.equal(plan.admittedItems, 1);
  assert.ok(plan.issues.some((issue) => issue.code === "sentinel_overflow"));
});

test("canonical criteria projection detects kind drift", () => {
  const criterion: GrantCriterion = {
    id: "criterion-1",
    grant_id: "grant-criteria",
    dimension: "region",
    operator: "in",
    value: { regions: ["서울"] },
    kind: "required",
    weight: 1,
    confidence: 0.95,
    source_span: "서울 소재 기업",
    raw_text: "서울 소재 기업",
    source_field: "eligibility",
    needs_review: false,
    parser_version: "criteria-v1",
  };
  const snapshotCriterion: Record<string, unknown> = { ...criterion };

  const matching = canonicalServingProjection([snapshotCriterion], [criterion]);
  assert.equal(matching.snapshotCriteriaSha256, matching.repositoryCriteriaSha256);
  assert.deepEqual(matching.issues, []);

  const drifted = canonicalServingProjection(
    [snapshotCriterion],
    [{ ...criterion, kind: "preferred" }],
  );
  assert.notEqual(drifted.snapshotCriteriaSha256, drifted.repositoryCriteriaSha256);
  assert.deepEqual(drifted.issues, [
    "canonical serving DTO criteria hash가 promotion snapshot과 다릅니다.",
  ]);
});

test("per-target verification exceptions become FAIL results and later targets still run", async () => {
  const first = target("item-error", "grant-error");
  const second = target("item-after-error", "grant-after-error");
  const visited: string[] = [];

  const results = await runActiveServingMonitorTargets([first, second], async (value) => {
    visited.push(value.binding.promotionItemId);
    if (value.binding.promotionItemId === "item-error") {
      throw new Error("publication probe failed");
    }
    return passingResult(value);
  });

  assert.deepEqual(visited, ["item-error", "item-after-error"]);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], {
    promotionItemId: "item-error",
    grantId: "grant-error",
    releaseId: "release-item-error",
    evidenceKind: "production_deep_run",
    verdict: "FAIL",
    publication: { status: "error", issues: ["publication probe failed"] },
    serving: { status: "not_reached", issues: [] },
    freshness: { status: "not_reached", issues: [] },
  });
  assert.deepEqual(results[1], passingResult(second));
});

test("evaluation requires an exact unique result for every admitted binding", () => {
  const expected = target("item-exact", "grant-exact");
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [expected.entry],
    candidates: [{ binding: expected.binding, canonicalExclusionReason: null }],
  });
  const pass = evaluateActiveServingMonitor({
    plan,
    results: [passingResult(expected)],
    inventoryStable: true,
  });
  assert.equal(pass.verdict, "PASS");
  assert.equal(pass.checkedItems, 1);

  const duplicate = evaluateActiveServingMonitor({
    plan,
    results: [passingResult(expected), passingResult(expected)],
    inventoryStable: true,
  });
  assert.equal(duplicate.verdict, "FAIL");
  assert.ok(duplicate.coverageIssues.includes("result_duplicate:item-exact"));

  const wrongBinding = evaluateActiveServingMonitor({
    plan,
    results: [{ ...passingResult(expected), grantId: "grant-wrong" }],
    inventoryStable: true,
  });
  assert.equal(wrongBinding.verdict, "FAIL");
  assert.equal(wrongBinding.checkedItems, 0);
  assert.ok(wrongBinding.coverageIssues.includes("result_binding_mismatch:item-exact"));
  assert.ok(wrongBinding.coverageIssues.includes("checked_coverage_mismatch:0/1"));

  const missing = evaluateActiveServingMonitor({
    plan,
    results: [],
    inventoryStable: true,
  });
  assert.equal(missing.verdict, "FAIL");
  assert.ok(missing.coverageIssues.includes("result_missing:item-exact"));
  assert.ok(missing.coverageIssues.some((issue) => issue.startsWith("zero_checked_with_positive_supply:")));
});

test("evaluation rejects a PASS label when any verification stage did not pass", () => {
  const expected = target("item-malformed", "grant-malformed");
  const plan = buildActiveServingMonitorPlan({
    canonicalEntries: [expected.entry],
    candidates: [{ binding: expected.binding, canonicalExclusionReason: null }],
  });
  const malformed = {
    ...passingResult(expected),
    freshness: { status: "not_reached" as const, issues: [] },
  };
  const evaluation = evaluateActiveServingMonitor({
    plan,
    results: [malformed],
    inventoryStable: true,
  });
  assert.equal(evaluation.verdict, "FAIL");
  assert.equal(evaluation.passedItems, 0);
  assert.equal(evaluation.failedItems, 1);
  assert.ok(evaluation.coverageIssues.includes("result_verdict_mismatch:item-malformed"));
  assert.equal(evaluation.stageCounts.freshness.not_reached, 1);
});

test("per-item Cloud Logging line stays bounded for very large multilingual issues", () => {
  const expected = target("item-log", "grant-log");
  const huge = "검증 실패 원인".repeat(100_000);
  const result: ActiveServingMonitorTargetResult = {
    ...passingResult(expected),
    verdict: "FAIL",
    publication: { status: "failed", issues: [huge], evidence: { detail: huge } },
    serving: { status: "not_reached", issues: [] },
    freshness: { status: "not_reached", issues: [] },
  };
  const line = serializeActiveServingMonitorItemLog({
    monitorExecutionId: "execution-log",
    index: 0,
    total: 1,
    result,
  });
  assert.ok(Buffer.byteLength(line) <= 200 * 1_024);
  const parsed = JSON.parse(line) as { truncated: boolean; resultSha256: string };
  assert.equal(parsed.truncated, true);
  assert.equal(parsed.resultSha256.length, 64);
});

test("inventory hash ignores collection timestamps but keeps material DTO state", () => {
  const first = grantEntry("grant-inventory");
  first.grant.updated_at = "2026-09-09T00:00:00.000Z";
  first.raw.collected_at = "2026-09-09T00:00:00.000Z";
  first.extraction_manifest = {
    grantId: "bizinfo:source-grant-inventory",
    revision: first.raw.collected_at,
    sourceFieldsSeen: ["title"],
    attachmentsExpected: 0,
    attachmentsFetched: 0,
    attachmentsConverted: 0,
    sectionsDetected: ["required"],
    extractorVersion: "reviewer-v1",
    completedAt: first.raw.collected_at,
    warnings: [],
    readiness: "reviewed",
    reviewedAt: "2026-09-08T00:00:00.000Z",
  };
  const second = structuredClone(first);
  second.grant.updated_at = "2026-09-09T00:05:00.000Z";
  second.raw.collected_at = "2026-09-09T00:05:00.000Z";
  second.extraction_manifest!.revision = second.raw.collected_at;
  second.extraction_manifest!.completedAt = second.raw.collected_at;
  const candidate = {
    binding: binding("item-inventory", "grant-inventory"),
    canonicalExclusionReason: null,
  };
  assert.equal(
    activeServingMonitorInventorySha256({ canonicalEntries: [first], candidates: [candidate] }),
    activeServingMonitorInventorySha256({ canonicalEntries: [second], candidates: [candidate] }),
  );
  second.extraction_manifest!.reviewedAt = "2026-09-09T00:05:00.000Z";
  assert.notEqual(
    activeServingMonitorInventorySha256({ canonicalEntries: [first], candidates: [candidate] }),
    activeServingMonitorInventorySha256({ canonicalEntries: [second], candidates: [candidate] }),
  );
  second.extraction_manifest!.reviewedAt = first.extraction_manifest.reviewedAt ?? null;
  second.grant.status = "closed";
  assert.notEqual(
    activeServingMonitorInventorySha256({ canonicalEntries: [first], candidates: [candidate] }),
    activeServingMonitorInventorySha256({ canonicalEntries: [second], candidates: [candidate] }),
  );
});

test("local operational preparation gaps are telemetry but referenced artifact corruption fails closed", () => {
  const readinessOnly = classifyLocalOperationalInputState({
    attachments: [
      {
        id: "missing-archive",
        filename: "missing.hwp",
        sourceUri: "https://example.test/missing.hwp",
        contentType: null,
        bytes: null,
        storageKey: null,
        sha256: null,
        conversionStatus: null,
        markdownStorageKey: null,
        markdownSha256: null,
        disposition: "blocked_fetch",
        dispositionReason: "원본 archive 미완료",
        duplicateOf: null,
        textChars: 0,
        textSha256: null,
        chunkIds: [],
      },
      {
        id: "archive-gap-with-markdown-reference",
        filename: "archive-gap.pdf",
        sourceUri: "https://example.test/archive-gap.pdf",
        contentType: "application/pdf",
        bytes: null,
        storageKey: null,
        sha256: null,
        conversionStatus: "converted",
        markdownStorageKey: "markdown/archive-gap",
        markdownSha256: "a".repeat(64),
        disposition: "blocked_fetch",
        dispositionReason: "원본 archive 미완료",
        duplicateOf: null,
        textChars: 0,
        textSha256: null,
        chunkIds: [],
      },
    ],
    blockers: [
      { code: "blocked_fetch", attachmentId: "missing-archive", message: "not prepared" },
      {
        code: "blocked_fetch",
        attachmentId: "archive-gap-with-markdown-reference",
        message: "archive not prepared",
      },
      { code: "blocked_cap", attachmentId: null, message: "over cap" },
    ],
  });
  assert.equal(readinessOnly.readinessBlockers.length, 3);
  assert.deepEqual(readinessOnly.materialIssues, []);

  const corrupted = classifyLocalOperationalInputState({
    attachments: [{
      id: "corrupted-markdown",
      filename: "converted.pdf",
      sourceUri: "https://example.test/converted.pdf",
      contentType: "application/pdf",
      bytes: 10,
      storageKey: "archive/key",
      sha256: "a".repeat(64),
      conversionStatus: "converted",
      markdownStorageKey: "markdown/key",
      markdownSha256: "b".repeat(64),
      disposition: "blocked_conversion",
      dispositionReason: "markdown SHA-256 mismatch (cccccccccccc)",
      duplicateOf: null,
      textChars: 0,
      textSha256: null,
      chunkIds: [],
    }, {
      id: "invalid-waiver",
      filename: "invalid.hwp",
      sourceUri: "https://example.test/invalid.hwp",
      contentType: null,
      bytes: 10,
      storageKey: "archive/invalid",
      sha256: "d".repeat(64),
      conversionStatus: null,
      markdownStorageKey: null,
      markdownSha256: null,
      disposition: "blocked_conversion",
      dispositionReason: "invalid waiver",
      duplicateOf: null,
      textChars: 0,
      textSha256: null,
      chunkIds: [],
    }],
    blockers: [
      { code: "blocked_conversion", attachmentId: "corrupted-markdown", message: "bad hash" },
      { code: "invalid_waiver", attachmentId: "invalid-waiver", message: "bad waiver" },
    ],
  });
  assert.deepEqual(corrupted.readinessBlockers, []);
  assert.deepEqual(corrupted.materialIssues, [
    { code: "artifact_hash_mismatch", attachmentId: "corrupted-markdown" },
    { code: "invalid_waiver", attachmentId: "invalid-waiver" },
  ]);
});

test("final summary bounds coverage issue samples and binds the complete issue set", () => {
  const plan = buildActiveServingMonitorPlan({ canonicalEntries: [], candidates: [] });
  const evaluation = evaluateActiveServingMonitor({ plan, results: [], inventoryStable: true });
  const coverageIssues = Array.from(
    { length: 5_001 },
    (_, index) => `binding_missing:${index}:${"긴 오류".repeat(1_000)}`,
  );
  const summary = summarizeActiveServingMonitorEvaluation({
    ...evaluation,
    verdict: "FAIL",
    coverageIssues,
  });

  assert.equal(summary.coverageIssueCount, 5_001);
  assert.equal(summary.coverageIssues.length, 20);
  assert.ok(summary.coverageIssues.every((issue) => issue.length <= 512));
  assert.equal(summary.coverageIssuesSha256.length, 64);
  assert.equal(summary.resultsSha256.length, 64);
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 200 * 1_024);
});
