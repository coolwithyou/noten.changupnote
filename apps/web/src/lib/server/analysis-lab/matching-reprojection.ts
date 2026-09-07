// deep-v34 원차수 결과의 매칭 변환 재투영 진단.
//
// 이 모듈은 고정된 로컬 manifest/grant/launch receipt/run artifact만 읽는다.
// DB·네트워크·모델 실행 모듈을 import하지 않으며 launch/release/promotion 권한을 만들지 않는다.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type {
  CompanyProfile,
  CriterionKind,
  CriterionOperator,
  GrantCriterion,
} from "@cunote/contracts";
import { matchGrantCriteria, RULESET_VERSION } from "@cunote/core/matching/match";
import type { LabCriterion, LabRun } from "./lab-contract";
import {
  ANALYSIS_LAB_SHADOW_PARSER_VERSION,
  convertSelectedLabCriteria,
  inspectShadowConversionReport,
  type ShadowConversionItemReport,
} from "./shadow-convert";

export const DEEP_V34_REPROJECTION_BINDING = {
  manifestSha256: "c8bfe340222fc67a31222bf8e78f4c886638d5842447730cb62991a0e2f9ff33",
  grantSha256: "50c14ae952e994c89612923e293a56ad3b00641e652f31070db4fa151af9e337",
  launchReceiptSha256s: [
    "53a7b8dbac403a4356077d7f44e5c44d65668e03cd33f06b1192e8aa88b01774",
    "c2b245df91cb441c425d9ba3e3a5e2778802b03579db1b151656403bd46adb5a",
  ],
  manifestTargetCount: 100,
  publishableTargetCount: 80,
} as const;

const EMPTY_DIAGNOSTIC_COMPANY: CompanyProfile = { confidence: {} };
const REPROJECTION_IMPLEMENTATION_SOURCE_PATHS = [
  "apps/web/src/lib/server/analysis-lab/shadow-convert.ts",
  "packages/core/src/bizinfo/llm-criteria.ts",
  "packages/core/src/bizinfo/criteria-contract.ts",
  "packages/core/src/criteria/canonicalize.ts",
  "packages/core/src/criteria/matching-scope.ts",
  "packages/core/src/criteria/semantic-identity.ts",
  "packages/core/src/matching/match.ts",
  "apps/web/src/lib/server/analysis-serving/matchingConversionContract.ts",
] as const;
const REPROJECTION_RUNTIME_PATHS = [
  "packages/contracts/dist/index.js",
  "packages/core/dist/bizinfo/llm-criteria.js",
  "packages/core/dist/bizinfo/criteria-contract.js",
  "packages/core/dist/criteria/canonicalize.js",
  "packages/core/dist/criteria/matching-scope.js",
  "packages/core/dist/criteria/semantic-identity.js",
  "packages/core/dist/matching/match.js",
] as const;

interface LaunchManifestTarget {
  sequence: number;
  grantId: string;
  inputSha256: string;
  attachmentManifestSha256: string;
}

interface LaunchManifest {
  schema: string;
  targets: LaunchManifestTarget[];
}

type TerminalStatus = "publishable" | "held" | "failed" | "skipped";

export interface LaunchReceiptTarget {
  sequence: number;
  grantId: string;
  status: TerminalStatus;
  runArtifactPath: string | null;
  runArtifactSha256: string | null;
}

interface LaunchReceipt {
  schema: string;
  manifestSha256: string;
  grantSha256: string;
  finishedAt: string;
  targets: LaunchReceiptTarget[];
}

interface LaunchGrant {
  schema: string;
  manifestSha256: string;
  targetCount: number;
}

interface StableProjectionRow {
  grantId: string;
  runId: string;
  criterionIndex: number;
  sourceSpanSha256: string | null;
  original: {
    dimension: string;
    operator: string;
    kind: string;
  };
  projected: {
    dimension: string;
    operator: string;
    kind: string;
  } | null;
  projectionError: string | null;
  originalEligibility: string | null;
  projectedEligibility: string | null;
}

export interface RunProjectionDiagnostic {
  grantId: string;
  runId: string;
  runArtifactPath?: string;
  runArtifactSha256?: string;
  inputCriteria: number;
  singleItemConverted: number;
  singleItemDropped: number;
  singleItemErrors: number;
  aggregateConverted: number;
  aggregateDropped: number;
  aggregateDowngraded: number;
  aggregateError: string | null;
  aggregateAccountingIssues: string[];
  aggregateItems: ShadowConversionItemReport[];
  kindChanges: number;
  matcherEligibilityChanges: number;
  stableProjectionRows: StableProjectionRow[];
}

export interface MatchingReprojectionReport {
  schema: "analysis-matching-reprojection-diagnostic-v2";
  authority: {
    diagnosticOnly: true;
    independentReviewPass: false;
    promotionAuthority: false;
    disclaimer: string;
  };
  sourceBinding: {
    manifest: { path: string; sha256: string };
    grant: { path: string; sha256: string };
    launchReceipts: Array<{ path: string; sha256: string; finishedAt: string }>;
    terminalMergePolicy: "later_non_skipped_replaces_earlier_terminal";
    implementationSources: Array<{ path: string; sha256: string }>;
      packageRuntime: {
        freshnessCommand: "pnpm verify:package-runtime-freshness";
        hashScope: "executed_package_dist_files";
        sha256: string;
        files: Array<{ path: string; sha256: string }>;
      };
  };
  artifactVerification: {
    algorithm: "sha256_raw_bytes";
    launchArtifactsVerified: number;
    terminalRunArtifactsVerified: number;
    publishableRunArtifactsVerified: number;
    implementationSourceFilesVerified: number;
    packageRuntimeFilesVerified: number;
  };
  terminalPopulation: {
    manifestTargets: number;
    publishable: number;
    held: number;
    failed: number;
    skipped: number;
  };
  projectionContract: {
    converter: string;
    matcherRuleset: string;
    stableMapping: "one_original_criterion_per_projection";
    aggregateProjection: "whole_run_projection_separate_from_stable_mapping";
    matcherComparisonScope: "single_criterion_empty_company_profile";
    matcherComparisonLimitation: string;
  };
  productExpectations: {
    kindChanges: 0;
    matcherEligibilityChanges: 0;
    preferredUnknownBlocksEligibility: false;
    requiredAndExclusionUnknownAutoPass: false;
  };
  priorObservedBaseline: {
    source: string;
    inputCriteria: 573;
    aggregateConverted: 555;
    requiredToExclusion: 28;
    preferredToExclusion: 7;
  };
  summary: {
    runs: number;
    inputCriteria: number;
    singleItemConverted: number;
    singleItemDropped: number;
    singleItemErrors: number;
    aggregateConverted: number;
    aggregateDropped: number;
    aggregateDowngraded: number;
    aggregateErrors: number;
    aggregateAccountingErrors: number;
    aggregateOutcomeCounts: Record<string, number>;
    kindChanges: number;
    requiredToExclusion: number;
    preferredToExclusion: number;
    matcherEligibilityChanges: number;
    stableProjectionMapSha256: string;
    singleItemProjectionVerdict: "PASS" | "REPORTED_FAILURES";
    kindPreservationVerdict: "PASS" | "FAIL";
    aggregateProjectionVerdict: "PASS" | "REPORTED_FAILURES";
    overallDiagnosticVerdict: "PASS" | "PARTIAL_REPORTED_FAILURES" | "FAIL";
  };
  anomalies: {
    singleItemDrops: StableProjectionRow[];
    kindChanges: StableProjectionRow[];
    matcherEligibilityChanges: StableProjectionRow[];
    aggregateErrors: Array<{
      grantId: string;
      runId: string;
      inputCriteria: number;
      error: string;
    }>;
    aggregateItemFailures: Array<{
      grantId: string;
      runId: string;
      item: ShadowConversionItemReport;
    }>;
  };
  runs: Array<Omit<RunProjectionDiagnostic, "stableProjectionRows">>;
}

export function mergeLaunchTerminalTargets(
  manifestTargets: LaunchManifestTarget[],
  receiptTargetSets: LaunchReceiptTarget[][],
): Map<string, LaunchReceiptTarget> {
  const terminalByGrantId = new Map<string, LaunchReceiptTarget>();
  for (const targets of receiptTargetSets) {
    if (targets.length !== manifestTargets.length) {
      throw new Error(`launch receipt target count mismatch: ${targets.length} != ${manifestTargets.length}`);
    }
    targets.forEach((target, position) => {
      const manifestTarget = manifestTargets[position];
      if (
        !manifestTarget
        || target.sequence !== manifestTarget.sequence
        || target.grantId !== manifestTarget.grantId
      ) {
        throw new Error(`launch receipt target binding mismatch at position ${position}`);
      }
      if (target.status !== "skipped") terminalByGrantId.set(target.grantId, target);
    });
  }
  return terminalByGrantId;
}

export function projectRunCriteria(run: LabRun): RunProjectionDiagnostic {
  const stableProjectionRows = run.criteria.map((criterion, criterionIndex) => {
    const single = convertSelectedLabCriteria(run, {
      selections: [{ criterionIndex, needsReview: false }],
    });
    const projected = single.criteria.length === 1 ? single.criteria[0]! : null;
    const originalForMatcher = toOriginalGrantCriterion(criterion, run, criterionIndex);
    let originalEligibility: string | null = null;
    let projectedEligibility: string | null = null;
    let projectionError = single.report.error;
    try {
      originalEligibility = matchGrantCriteria(
        [originalForMatcher],
        EMPTY_DIAGNOSTIC_COMPANY,
      ).eligibility;
      projectedEligibility = projected
        ? matchGrantCriteria([projected], EMPTY_DIAGNOSTIC_COMPANY).eligibility
        : null;
    } catch (error) {
      projectionError ??= error instanceof Error ? error.message : String(error);
    }
    return {
      grantId: run.grantId,
      runId: run.runId,
      criterionIndex,
      sourceSpanSha256: criterion.sourceSpan ? sha256(criterion.sourceSpan) : null,
      original: {
        dimension: criterion.dimension,
        operator: criterion.operator,
        kind: criterion.kind,
      },
      projected: projected
        ? {
            dimension: projected.dimension,
            operator: projected.operator,
            kind: projected.kind,
          }
        : null,
      projectionError,
      originalEligibility,
      projectedEligibility,
    } satisfies StableProjectionRow;
  });
  const aggregate = convertSelectedLabCriteria(run, {
    selections: run.criteria.map((_, criterionIndex) => ({
      criterionIndex,
      needsReview: false,
    })),
  });
  const aggregateIntegrity = inspectShadowConversionReport(aggregate.report, aggregate.criteria);
  return {
    grantId: run.grantId,
    runId: run.runId,
    inputCriteria: run.criteria.length,
    singleItemConverted: stableProjectionRows.filter((row) => row.projected !== null).length,
    singleItemDropped: stableProjectionRows.filter((row) => row.projected === null).length,
    singleItemErrors: stableProjectionRows.filter((row) => row.projectionError !== null).length,
    aggregateConverted: aggregate.criteria.length,
    aggregateDropped: aggregate.report.dropped,
    aggregateDowngraded: aggregate.report.downgraded,
    aggregateError: aggregate.report.error,
    aggregateAccountingIssues: aggregateIntegrity.issues,
    aggregateItems: aggregate.report.items ?? [],
    kindChanges: stableProjectionRows.filter((row) =>
      row.projected !== null && row.original.kind !== row.projected.kind).length,
    matcherEligibilityChanges: stableProjectionRows.filter((row) =>
      row.projectedEligibility !== null
      && row.originalEligibility !== row.projectedEligibility).length,
    stableProjectionRows,
  };
}

export function evaluateProjectionVerdicts(input: {
  singleItemDropped: number;
  singleItemErrors: number;
  aggregateDropped: number;
  aggregateErrors: number;
  kindChanges: number;
  matcherEligibilityChanges: number;
}): Pick<MatchingReprojectionReport["summary"],
  | "singleItemProjectionVerdict"
  | "kindPreservationVerdict"
  | "aggregateProjectionVerdict"
  | "overallDiagnosticVerdict"
> {
  const singleItemProjectionVerdict = input.singleItemDropped === 0 && input.singleItemErrors === 0
    ? "PASS"
    : "REPORTED_FAILURES";
  const kindPreservationVerdict = singleItemProjectionVerdict === "PASS" && input.kindChanges === 0
    ? "PASS"
    : "FAIL";
  const aggregateProjectionVerdict = input.aggregateErrors === 0 && input.aggregateDropped === 0
    ? "PASS"
    : "REPORTED_FAILURES";
  const matcherComparisonPass = singleItemProjectionVerdict === "PASS"
    && input.matcherEligibilityChanges === 0;
  const overallDiagnosticVerdict = kindPreservationVerdict === "FAIL" || !matcherComparisonPass
    ? "FAIL"
    : aggregateProjectionVerdict === "REPORTED_FAILURES"
      ? "PARTIAL_REPORTED_FAILURES"
      : "PASS";
  return {
    singleItemProjectionVerdict,
    kindPreservationVerdict,
    aggregateProjectionVerdict,
    overallDiagnosticVerdict,
  };
}

export async function buildDeepV34MatchingReprojectionReport(
  root: string,
): Promise<MatchingReprojectionReport> {
  const manifestPath = join(
    root,
    "spike-out/analysis-lab/launch/manifests",
    `${DEEP_V34_REPROJECTION_BINDING.manifestSha256}.json`,
  );
  const grantPath = join(
    root,
    "spike-out/analysis-lab/launch/grants",
    `${DEEP_V34_REPROJECTION_BINDING.grantSha256}.json`,
  );
  const receiptPaths = DEEP_V34_REPROJECTION_BINDING.launchReceiptSha256s.map((sha256) =>
    join(root, "spike-out/analysis-lab/launch/receipts", `${sha256}.json`));
  const manifest = await readVerifiedJsonArtifact<LaunchManifest>(
    manifestPath,
    DEEP_V34_REPROJECTION_BINDING.manifestSha256,
  );
  const grant = await readVerifiedJsonArtifact<LaunchGrant>(
    grantPath,
    DEEP_V34_REPROJECTION_BINDING.grantSha256,
  );
  const receipts = await Promise.all(receiptPaths.map((path, index) =>
    readVerifiedJsonArtifact<LaunchReceipt>(
      path,
      DEEP_V34_REPROJECTION_BINDING.launchReceiptSha256s[index]!,
    )));
  assertLaunchBindings(manifest, grant, receipts);
  const implementationSources = await Promise.all(
    REPROJECTION_IMPLEMENTATION_SOURCE_PATHS.map(async (path) => ({
      path,
      sha256: sha256(await readFile(join(root, path))),
    })),
  );
  const packageRuntimeFiles = await Promise.all(
    REPROJECTION_RUNTIME_PATHS.map(async (path) => ({
      path,
      sha256: sha256(await readFile(join(root, path))),
    })),
  );

  const terminalByGrantId = mergeLaunchTerminalTargets(
    manifest.targets,
    receipts.map((receipt) => receipt.targets),
  );
  const terminalTargets = manifest.targets.map((target) => terminalByGrantId.get(target.grantId));
  if (terminalTargets.some((target) => !target)) {
    throw new Error("launch receipts do not contain a non-skipped terminal for every manifest target");
  }
  const completeTerminalTargets = terminalTargets as LaunchReceiptTarget[];
  const publishableTargets = completeTerminalTargets.filter((target) => target.status === "publishable");
  if (publishableTargets.length !== DEEP_V34_REPROJECTION_BINDING.publishableTargetCount) {
    throw new Error(
      `publishable target count mismatch: ${publishableTargets.length} != ${DEEP_V34_REPROJECTION_BINDING.publishableTargetCount}`,
    );
  }

  let verifiedRunArtifacts = 0;
  const runByGrantId = new Map<string, LabRun>();
  for (const target of completeTerminalTargets) {
    if (!target.runArtifactPath && !target.runArtifactSha256) continue;
    if (!target.runArtifactPath || !target.runArtifactSha256) {
      throw new Error(`partial run artifact binding: ${target.grantId}`);
    }
    const runPath = safeArtifactPath(root, target.runArtifactPath);
    const run = await readVerifiedJsonArtifact<LabRun>(runPath, target.runArtifactSha256);
    const manifestTarget = manifest.targets[target.sequence];
    if (
      !manifestTarget
      || run.grantId !== target.grantId
      || run.inputSha256 !== manifestTarget.inputSha256
      || run.attachmentManifestSha256 !== manifestTarget.attachmentManifestSha256
    ) {
      throw new Error(`run artifact binding mismatch: ${target.runArtifactPath}`);
    }
    runByGrantId.set(target.grantId, run);
    verifiedRunArtifacts += 1;
  }

  const runDiagnostics = publishableTargets.map((target) => {
    const run = runByGrantId.get(target.grantId);
    if (!run || !target.runArtifactPath || !target.runArtifactSha256) {
      throw new Error(`publishable target run artifact missing: ${target.grantId}`);
    }
    const diagnostic = projectRunCriteria(run);
    return {
      ...diagnostic,
      runArtifactPath: target.runArtifactPath,
      runArtifactSha256: target.runArtifactSha256,
    };
  });
  const stableRows = runDiagnostics.flatMap((run) => run.stableProjectionRows);
  const singleItemDrops = stableRows.filter((row) => row.projected === null);
  const kindChanges = stableRows.filter((row) =>
    row.projected !== null && row.original.kind !== row.projected.kind);
  const matcherEligibilityChanges = stableRows.filter((row) =>
    row.projectedEligibility !== null && row.originalEligibility !== row.projectedEligibility);
  const aggregateErrors = runDiagnostics.flatMap((run) => run.aggregateError
    ? [{
        grantId: run.grantId,
        runId: run.runId,
        inputCriteria: run.inputCriteria,
        error: run.aggregateError,
      }]
    : []);
  const aggregateAccountingErrors = runDiagnostics.filter((run) => (
    run.aggregateAccountingIssues.length > 0
  )).length;
  const aggregateItems = runDiagnostics.flatMap((run) => run.aggregateItems.map((item) => ({
    grantId: run.grantId,
    runId: run.runId,
    item,
  })));
  const aggregateItemFailures = aggregateItems.filter(({ item }) => (
    item.status === "dropped"
    || item.status === "failed"
    || item.status === "held_duplicate"
  ));
  const aggregateOutcomeCounts = aggregateItems.reduce<Record<string, number>>((counts, { item }) => {
    counts[item.status] = (counts[item.status] ?? 0) + 1;
    return counts;
  }, {});
  const inputCriteria = sum(runDiagnostics, "inputCriteria");
  const singleItemConverted = sum(runDiagnostics, "singleItemConverted");
  const singleItemDropped = sum(runDiagnostics, "singleItemDropped");
  const singleItemErrors = sum(runDiagnostics, "singleItemErrors");
  const aggregateConverted = sum(runDiagnostics, "aggregateConverted");
  const aggregateDropped = sum(runDiagnostics, "aggregateDropped");
  const aggregateDowngraded = sum(runDiagnostics, "aggregateDowngraded");
  const requiredToExclusion = kindChanges.filter((row) =>
    row.original.kind === "required" && row.projected?.kind === "exclusion").length;
  const preferredToExclusion = kindChanges.filter((row) =>
    row.original.kind === "preferred" && row.projected?.kind === "exclusion").length;
  const verdicts = evaluateProjectionVerdicts({
    singleItemDropped,
    singleItemErrors,
    aggregateDropped,
    aggregateErrors: aggregateErrors.length + aggregateAccountingErrors,
    kindChanges: kindChanges.length,
    matcherEligibilityChanges: matcherEligibilityChanges.length,
  });

  return {
    schema: "analysis-matching-reprojection-diagnostic-v2",
    authority: {
      diagnosticOnly: true,
      independentReviewPass: false,
      promotionAuthority: false,
      disclaimer: "고정 원차수 80건의 무모델 변환 진단일 뿐 독립 검수 PASS나 승격 허가가 아니다.",
    },
    sourceBinding: {
      manifest: {
        path: relative(root, manifestPath),
        sha256: DEEP_V34_REPROJECTION_BINDING.manifestSha256,
      },
      grant: {
        path: relative(root, grantPath),
        sha256: DEEP_V34_REPROJECTION_BINDING.grantSha256,
      },
      launchReceipts: receipts.map((receipt, index) => ({
        path: relative(root, receiptPaths[index]!),
        sha256: DEEP_V34_REPROJECTION_BINDING.launchReceiptSha256s[index]!,
        finishedAt: receipt.finishedAt,
      })),
      terminalMergePolicy: "later_non_skipped_replaces_earlier_terminal",
      implementationSources,
      packageRuntime: {
        freshnessCommand: "pnpm verify:package-runtime-freshness",
        hashScope: "executed_package_dist_files",
        sha256: sha256(canonicalJson(packageRuntimeFiles)),
        files: packageRuntimeFiles,
      },
    },
    artifactVerification: {
      algorithm: "sha256_raw_bytes",
      launchArtifactsVerified: 4,
      terminalRunArtifactsVerified: verifiedRunArtifacts,
      publishableRunArtifactsVerified: publishableTargets.length,
      implementationSourceFilesVerified: implementationSources.length,
      packageRuntimeFilesVerified: packageRuntimeFiles.length,
    },
    terminalPopulation: {
      manifestTargets: manifest.targets.length,
      publishable: publishableTargets.length,
      held: completeTerminalTargets.filter((target) => target.status === "held").length,
      failed: completeTerminalTargets.filter((target) => target.status === "failed").length,
      skipped: completeTerminalTargets.filter((target) => target.status === "skipped").length,
    },
    projectionContract: {
      converter: ANALYSIS_LAB_SHADOW_PARSER_VERSION,
      matcherRuleset: RULESET_VERSION,
      stableMapping: "one_original_criterion_per_projection",
      aggregateProjection: "whole_run_projection_separate_from_stable_mapping",
      matcherComparisonScope: "single_criterion_empty_company_profile",
      matcherComparisonLimitation: "빈 합성 회사와 단일 조건에서 kind 변환의 eligibility 영향만 비교하며 일반적인 매칭 의미 동등성을 증명하지 않는다.",
    },
    productExpectations: {
      kindChanges: 0,
      matcherEligibilityChanges: 0,
      preferredUnknownBlocksEligibility: false,
      requiredAndExclusionUnknownAutoPass: false,
    },
    priorObservedBaseline: {
      source: "docs/research/2026-09-07-대량분석-효율과-매칭정합성-리뷰.md",
      inputCriteria: 573,
      aggregateConverted: 555,
      requiredToExclusion: 28,
      preferredToExclusion: 7,
    },
    summary: {
      runs: runDiagnostics.length,
      inputCriteria,
      singleItemConverted,
      singleItemDropped,
      singleItemErrors,
      aggregateConverted,
      aggregateDropped,
      aggregateDowngraded,
      aggregateErrors: aggregateErrors.length,
      aggregateAccountingErrors,
      aggregateOutcomeCounts,
      kindChanges: kindChanges.length,
      requiredToExclusion,
      preferredToExclusion,
      matcherEligibilityChanges: matcherEligibilityChanges.length,
      stableProjectionMapSha256: sha256(canonicalJson(stableRows)),
      ...verdicts,
    },
    anomalies: {
      singleItemDrops,
      kindChanges,
      matcherEligibilityChanges,
      aggregateErrors,
      aggregateItemFailures,
    },
    runs: runDiagnostics.map(({ stableProjectionRows: _rows, ...run }) => run),
  };
}

export async function writeMatchingReprojectionReport(
  report: MatchingReprojectionReport,
  options: { root: string; outputPath?: string },
): Promise<{ path: string; sha256: string }> {
  const bytes = `${JSON.stringify(report, null, 2)}\n`;
  const reportSha256 = sha256(bytes);
  const outputPath = options.outputPath
    ? (isAbsolute(options.outputPath) ? options.outputPath : resolve(options.root, options.outputPath))
    : join(
        options.root,
        "spike-out/analysis-lab/diagnostics/matching-reprojection",
        `${reportSha256}.json`,
      );
  await mkdir(dirname(outputPath), { recursive: true });
  try {
    await writeFile(outputPath, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readFile(outputPath, "utf8");
    if (existing !== bytes) throw new Error(`diagnostic output already exists with different bytes: ${outputPath}`);
  }
  return { path: outputPath, sha256: reportSha256 };
}

function toOriginalGrantCriterion(
  criterion: LabCriterion,
  run: LabRun,
  criterionIndex: number,
): GrantCriterion {
  return {
    id: `diagnostic:${run.runId}:${criterionIndex}`,
    grant_id: run.sourceId,
    dimension: criterion.dimension,
    operator: criterion.operator as CriterionOperator,
    kind: criterion.kind as CriterionKind,
    value: criterion.value as GrantCriterion["value"],
    confidence: criterion.confidence,
    needs_review: false,
    ...(criterion.sourceSpan
      ? { source_span: criterion.sourceSpan, raw_text: criterion.sourceSpan }
      : {}),
  };
}

function assertLaunchBindings(
  manifest: LaunchManifest,
  grant: LaunchGrant,
  receipts: LaunchReceipt[],
): void {
  if (manifest.schema !== "analysis-launch-manifest-v1") throw new Error("unexpected launch manifest schema");
  if (grant.schema !== "analysis-launch-grant-v1") throw new Error("unexpected launch grant schema");
  if (manifest.targets.length !== DEEP_V34_REPROJECTION_BINDING.manifestTargetCount) {
    throw new Error(`manifest target count mismatch: ${manifest.targets.length}`);
  }
  manifest.targets.forEach((target, position) => {
    if (target.sequence !== position) throw new Error(`manifest sequence mismatch at position ${position}`);
  });
  if (
    grant.manifestSha256 !== DEEP_V34_REPROJECTION_BINDING.manifestSha256
    || grant.targetCount !== manifest.targets.length
  ) throw new Error("launch grant binding mismatch");
  for (const receipt of receipts) {
    if (
      receipt.schema !== "analysis-launch-receipt-v1"
      || receipt.manifestSha256 !== DEEP_V34_REPROJECTION_BINDING.manifestSha256
      || receipt.grantSha256 !== DEEP_V34_REPROJECTION_BINDING.grantSha256
    ) throw new Error("launch receipt binding mismatch");
  }
}

export async function readVerifiedJsonArtifact<T>(path: string, expectedSha256: string): Promise<T> {
  const bytes = await readFile(path);
  const actualSha256 = sha256(bytes);
  if (actualSha256 !== expectedSha256) {
    throw new Error(`artifact SHA-256 mismatch: ${path} (${actualSha256} != ${expectedSha256})`);
  }
  return JSON.parse(bytes.toString("utf8")) as T;
}

function safeArtifactPath(root: string, artifactPath: string): string {
  const absolute = resolve(root, artifactPath);
  const allowedRoot = resolve(root, "spike-out/analysis-lab");
  const relativePath = relative(allowedRoot, absolute);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`run artifact escapes analysis-lab root: ${artifactPath}`);
  }
  return absolute;
}

function sum<T extends Record<string, unknown>>(rows: T[], key: keyof T): number {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
