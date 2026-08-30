import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { LabRun } from "@/lib/server/analysis-lab/lab-contract";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "./application-roundtrip/contract";
import {
  INDEPENDENT_REVIEW_AGGREGATE_SCHEMA,
  INDEPENDENT_REVIEW_MANIFEST_SCHEMA,
  INDEPENDENT_REVIEW_PACKET_SCHEMA,
} from "./independent-review-packet";
import {
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  readAnalysisLaunchArtifact,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
  type AnalysisLaunchReceiptTarget,
} from "./launch-batch-artifacts";
import { loadCurrentGrantEvidence, type CurrentGrantEvidence } from "./deep-repair-promotion";
import {
  planGrantPromotion,
  type GrantPromotionPlan,
  type PromotionSource,
} from "./promote";
import {
  VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA,
  VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
  type PromotionSourceArtifact,
} from "./promotion-release";
import type { PromotionCandidate } from "./promotion-candidates";
import { findMonorepoRoot } from "./run-store";
import { isPublishableLabRun } from "./run-outcome";

const SHA256 = /^[a-f0-9]{64}$/u;

export const ANALYSIS_LAUNCH_PROMOTION_READINESS_SCHEMA =
  "analysis-launch-promotion-readiness-v1" as const;

export type AnalysisLaunchPromotionDisposition = "ready" | "conditional" | "held";

export interface AnalysisLaunchPromotionReadiness {
  schema: typeof ANALYSIS_LAUNCH_PROMOTION_READINESS_SCHEMA;
  disposition: AnalysisLaunchPromotionDisposition;
  reasons: string[];
  unresolvedAxes: Array<{
    dimension: string;
    status: "ambiguous" | "input_missing";
  }>;
  sourceRevisionSha256: string;
  inputSha256: string;
  attachmentManifestSha256: string;
  launchReceiptSha256: string;
  independentReviewAggregateSha256: string;
  applicationRoundtripStatus: NonNullable<LabRun["applicationRoundtrip"]>["status"];
  applicationRoundtripRunId: string | null;
  applicationDocumentCount: number;
  fieldReadyDocumentCount: number;
  recognizedFieldCount: number;
}

export interface AnalysisLaunchPromotionCandidate extends PromotionCandidate {
  readiness: AnalysisLaunchPromotionReadiness;
}

export interface AnalysisLaunchPromotionCohort {
  launchReceiptSha256s: string[];
  candidates: AnalysisLaunchPromotionCandidate[];
}

export interface AnalysisLaunchPromotionDependencies {
  repositoryRoot?: string;
  now?: Date;
  loadCurrentGrantEvidence?: (run: LabRun) => Promise<CurrentGrantEvidence>;
}

interface ReviewManifestPacket {
  sequence: number;
  grantId: string;
  runId: string;
  path: string;
  sha256: string;
}

interface ReviewEvidence {
  manifestSha256: string;
  aggregateSha256: string;
  packetBySequence: Map<number, ReviewManifestPacket>;
  comparisonBySequence: Map<number, { criterionTotal: number; axisTotal: number }>;
  blockedSequences: Set<number>;
}

interface LoadedLaunch {
  receiptSha256: string;
  receipt: AnalysisLaunchReceipt;
  manifest: AnalysisLaunchManifest;
  review: ReviewEvidence;
}

interface LoadedTarget {
  launch: LoadedLaunch;
  target: AnalysisLaunchReceiptTarget;
  run: LabRun;
  runArtifactSha256: string;
}

/**
 * 여러 formal/repair launch receipt에서 exact grant별 독립 검수 PASS leaf를 고른다.
 * caller는 receipt SHA와 grantId만 알면 되고, 나머지 파일 그래프와 current-state 검증은
 * 이 모듈 안에 숨긴다. 같은 grant의 clean leaf가 둘 이상이면 임의 선택하지 않는다.
 */
export async function loadAnalysisLaunchPromotionCohort(input: {
  launchReceiptSha256s: readonly string[];
  grantIds: readonly string[];
  dependencies?: AnalysisLaunchPromotionDependencies;
}): Promise<AnalysisLaunchPromotionCohort> {
  const receiptSha256s = normalizeExactShaList(input.launchReceiptSha256s, "launch receipt");
  const requestedGrantIds = normalizeExactGrantIds(input.grantIds);
  const root = input.dependencies?.repositoryRoot ?? findMonorepoRoot();
  const launches = await Promise.all(receiptSha256s.map((sha256) => loadLaunch(root, sha256)));
  const loadedByGrant = new Map<string, LoadedTarget[]>();

  for (const launch of launches) {
    for (const target of launch.receipt.targets) {
      if (!requestedGrantIds.includes(target.grantId)) continue;
      if (target.status !== "publishable" || launch.review.blockedSequences.has(target.sequence)) {
        continue;
      }
      const loaded = await loadAndVerifyTarget(root, launch, target);
      const previous = loadedByGrant.get(target.grantId) ?? [];
      previous.push(loaded);
      loadedByGrant.set(target.grantId, previous);
    }
  }

  const selected = requestedGrantIds.map((grantId) => {
    const targets = loadedByGrant.get(grantId) ?? [];
    if (targets.length === 0) {
      throw new Error(`독립 검수 PASS launch target이 없습니다: ${grantId}`);
    }
    if (targets.length > 1) {
      throw new Error(
        `독립 검수 PASS launch target이 둘 이상이라 임의 선택할 수 없습니다: ${grantId}`,
      );
    }
    return targets[0]!;
  });
  const usedReceipts = new Set(selected.map((item) => item.launch.receiptSha256));
  const unusedReceipts = receiptSha256s.filter((sha256) => !usedReceipts.has(sha256));
  if (unusedReceipts.length > 0) {
    throw new Error(`exact cohort에 기여하지 않는 launch receipt가 있습니다: ${unusedReceipts.join(", ")}`);
  }

  const loadCurrent = input.dependencies?.loadCurrentGrantEvidence
    ?? ((run: LabRun) => loadCurrentGrantEvidence(run, input.dependencies?.now ?? new Date()));
  const candidates: AnalysisLaunchPromotionCandidate[] = [];
  for (const loaded of selected) {
    const current = await loadCurrent(loaded.run);
    let readiness = classifyAnalysisLaunchPromotionReadiness({ loaded, current });
    let promotionPlan: GrantPromotionPlan | null = null;
    if (readiness.disposition === "ready" || readiness.disposition === "conditional") {
      promotionPlan = planGrantPromotion({
        run: {
          ...loaded.run,
          sourceRevisionSha256: current.sourceRevisionSha256,
        },
        origin: "analysis_launch",
        analysisLaunchReceiptSha256: loaded.launch.receiptSha256,
        sidecar: null,
      });
      readiness = guardAnalysisLaunchPromotionPlan(readiness, promotionPlan);
    }
    if (readiness.disposition === "held" || !promotionPlan) {
      throw new Error(
        `analysis-launch release readiness가 안전하지 않습니다: ${loaded.run.grantId}`
          + ` (${readiness.reasons.join("+")})`,
      );
    }

    const source: PromotionSource = { run: loaded.run, origin: "analysis_launch" };
    const execution = loaded.launch.manifest.execution;
    const sourceArtifact: PromotionSourceArtifact = {
      grantId: loaded.run.grantId,
      runId: loaded.run.runId,
      runSha256: loaded.runArtifactSha256,
      overlaySha256: null,
      confirmationsSha256: null,
      sourceRevisionSha256: current.sourceRevisionSha256,
      localLabEvidence: {
        schema: VERIFIED_LOCAL_LAB_SOURCE_SCHEMA,
        transport: "claude-cli",
        model: loaded.run.model,
        promptVersion: loaded.run.promptVersion,
        inputSha256: loaded.run.inputSha256,
        reviewMethod: "analysis_launch_independent_review",
        analysisLaunch: {
          schema: VERIFIED_ANALYSIS_LAUNCH_SOURCE_SCHEMA,
          launchReceiptSha256: loaded.launch.receiptSha256,
          launchManifestSha256: loaded.launch.receipt.manifestSha256,
          launchGrantSha256: loaded.launch.receipt.grantSha256,
          launchSequence: loaded.target.sequence,
          independentReviewManifestSha256: loaded.launch.review.manifestSha256,
          independentReviewAggregateSha256: loaded.launch.review.aggregateSha256,
          attachmentManifestSha256: loaded.run.attachmentManifestSha256!,
          sourceRevisionSha256: current.sourceRevisionSha256,
          executionGitSha: execution.gitShaAtPreparation,
          packageRuntimeSha256: execution.packageRuntimeSha256,
          validatorVersion: execution.validatorVersion,
          applicationFieldAnalysisVersion: execution.applicationFieldAnalysisVersion!,
        },
      },
    };
    candidates.push({ source, plan: promotionPlan, sourceArtifact, readiness });
  }

  return {
    launchReceiptSha256s: receiptSha256s,
    candidates: candidates.sort((left, right) => left.plan.grantId.localeCompare(right.plan.grantId)),
  };
}

export async function verifyAnalysisLaunchPromotionSourceArtifactDetailed(
  artifact: PromotionSourceArtifact,
  dependencies?: AnalysisLaunchPromotionDependencies,
): Promise<{ ok: boolean; changed: string[] }> {
  const evidence = artifact.localLabEvidence?.analysisLaunch;
  if (
    artifact.localLabEvidence?.reviewMethod !== "analysis_launch_independent_review"
    || !evidence
  ) {
    return { ok: false, changed: ["analysis_launch_evidence"] };
  }
  try {
    const loadCurrent = dependencies?.loadCurrentGrantEvidence
      ?? ((run: LabRun) => loadCurrentGrantEvidence(run, dependencies?.now ?? new Date()));
    const cohort = await loadAnalysisLaunchPromotionCohort({
      launchReceiptSha256s: [evidence.launchReceiptSha256],
      grantIds: [artifact.grantId],
      dependencies: {
        ...dependencies,
        // release prepare가 만든 approved item 자체는 source drift가 아니다. 별도 deep run,
        // dedup, 원문/첨부 변화는 그대로 current-state 차단 조건으로 유지한다.
        loadCurrentGrantEvidence: async (run) => ({
          ...await loadCurrent(run),
          hasPromotionItem: false,
        }),
      },
    });
    const candidate = cohort.candidates[0];
    if (!candidate) return { ok: false, changed: ["analysis_launch_candidate"] };
    const expected = candidate.sourceArtifact;
    const checks: Array<[string, unknown, unknown]> = [
      ["run_id", artifact.runId, expected.runId],
      ["run", artifact.runSha256, expected.runSha256],
      ["source_revision", artifact.sourceRevisionSha256, expected.sourceRevisionSha256],
      ["input", artifact.localLabEvidence?.inputSha256, expected.localLabEvidence?.inputSha256],
      ["launch_receipt", evidence.launchReceiptSha256, expected.localLabEvidence?.analysisLaunch?.launchReceiptSha256],
      ["launch_manifest", evidence.launchManifestSha256, expected.localLabEvidence?.analysisLaunch?.launchManifestSha256],
      ["launch_grant", evidence.launchGrantSha256, expected.localLabEvidence?.analysisLaunch?.launchGrantSha256],
      ["launch_sequence", evidence.launchSequence, expected.localLabEvidence?.analysisLaunch?.launchSequence],
      ["review_manifest", evidence.independentReviewManifestSha256, expected.localLabEvidence?.analysisLaunch?.independentReviewManifestSha256],
      ["review_aggregate", evidence.independentReviewAggregateSha256, expected.localLabEvidence?.analysisLaunch?.independentReviewAggregateSha256],
      ["attachment", evidence.attachmentManifestSha256, expected.localLabEvidence?.analysisLaunch?.attachmentManifestSha256],
      ["execution_git", evidence.executionGitSha, expected.localLabEvidence?.analysisLaunch?.executionGitSha],
      ["package_runtime", evidence.packageRuntimeSha256, expected.localLabEvidence?.analysisLaunch?.packageRuntimeSha256],
      ["validator", evidence.validatorVersion, expected.localLabEvidence?.analysisLaunch?.validatorVersion],
      ["field_analysis", evidence.applicationFieldAnalysisVersion, expected.localLabEvidence?.analysisLaunch?.applicationFieldAnalysisVersion],
    ];
    const changed = checks.filter(([, left, right]) => left !== right).map(([name]) => name);
    if (!artifact.applicationPrecompute) {
      if (
        candidate.readiness.applicationRoundtripStatus !== "not_applicable"
        || candidate.readiness.applicationRoundtripRunId !== null
        || candidate.readiness.applicationDocumentCount !== 0
        || candidate.readiness.fieldReadyDocumentCount !== 0
        || candidate.readiness.recognizedFieldCount !== 0
      ) {
        changed.push("application_precompute_missing");
      }
    } else {
      const { readBundledPromotionApplicationPrecompute } = await import(
        "./application-precompute-release"
      );
      const bundled = await readBundledPromotionApplicationPrecompute(artifact.applicationPrecompute);
      if (
        bundled.run.parentLabRunId !== artifact.runId
        || bundled.run.runId !== artifact.applicationPrecompute.roundtripRunId
        || artifact.applicationPrecompute.launchAdmission?.launchReceiptSha256
          !== evidence.launchReceiptSha256
        || artifact.applicationPrecompute.launchAdmission?.runArtifactSha256
          !== artifact.runSha256
      ) {
        changed.push("application_precompute_provenance");
      }
    }
    return { ok: changed.length === 0, changed };
  } catch (error) {
    throw new Error(
      `analysis_launch_unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function classifyAnalysisLaunchPromotionReadiness(input: {
  loaded: LoadedTarget;
  current: CurrentGrantEvidence;
}): AnalysisLaunchPromotionReadiness {
  const { run, target, launch } = input.loaded;
  const current = input.current;
  const reasons: string[] = [];
  let disposition: AnalysisLaunchPromotionDisposition;
  if (!isPublishableLabRun(run) || run.matchingReadiness === "deferred") {
    disposition = "held";
    reasons.push("run_not_publishable");
  } else if (run.matchingReadiness === "ready") {
    disposition = "ready";
  } else if (run.matchingReadiness === "conditional") {
    disposition = "conditional";
  } else {
    disposition = "held";
    reasons.push("matching_readiness_missing");
  }
  if ((run.primaryRepairProvenance?.blockingNewIssueAfterRepairCount ?? 0) > 0) {
    reasons.push("blocking_new_issue_after_repair");
  }
  if (run.criteria.length === 0) reasons.push("empty_criteria");
  if (run.inputSha256 !== current.inputSha256) reasons.push("input_drift");
  if (run.attachmentManifestSha256 !== current.attachmentManifestSha256) {
    reasons.push("attachment_drift");
  }
  if (current.status !== "open") reasons.push("grant_not_open");
  if (current.servingState !== "visible") reasons.push("grant_not_visible");
  if (!current.applicationOpen) reasons.push("application_not_open");
  if (current.hasPromotionItem) reasons.push("promotion_duplicate");
  if (current.hasDeepAnalysisRun) reasons.push("deep_analysis_duplicate");
  if (current.confirmedDuplicate) reasons.push("confirmed_dedup_member");
  const roundtrip = run.applicationRoundtrip;
  const execution = launch.manifest.execution;
  if (
    !execution.withApplicationRoundtrip
    || execution.applicationFieldAnalysisVersion !== APPLICATION_ROUNDTRIP_VERSION
    || execution.roundtripModel !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
    || !roundtrip
    || roundtrip.transport !== "claude-cli"
    || roundtrip.model !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
    || roundtrip.status !== target.applicationRoundtripStatus
    || (roundtrip.applicationDocumentCount ?? 0) !== (target.applicationDocumentCount ?? 0)
    || (roundtrip.fieldReadyDocumentCount ?? 0) !== (target.fieldReadyDocumentCount ?? 0)
    || (roundtrip.recognizedFieldCount ?? 0) !== (target.recognizedFieldCount ?? 0)
  ) {
    reasons.push("application_field_analysis_binding");
  } else if ((roundtrip.applicationDocumentCount ?? 0) > 0) {
    if (
      (roundtrip.status !== "complete" && roundtrip.status !== "partial")
      || !roundtrip.runId
      || (roundtrip.fieldReadyDocumentCount ?? 0) === 0
      || (roundtrip.recognizedFieldCount ?? 0) === 0
    ) {
      reasons.push("application_field_analysis_not_ready");
    }
  } else if (roundtrip.status !== "not_applicable") {
    reasons.push("application_field_analysis_not_applicable_mismatch");
  }
  if (reasons.length > 0) disposition = "held";
  return {
    schema: ANALYSIS_LAUNCH_PROMOTION_READINESS_SCHEMA,
    disposition,
    reasons: [...new Set(reasons)].sort(),
    unresolvedAxes: run.axisAssessments.flatMap((axis) => (
      axis.status === "ambiguous" || axis.status === "input_missing"
        ? [{ dimension: axis.dimension, status: axis.status }]
        : []
    )),
    sourceRevisionSha256: current.sourceRevisionSha256,
    inputSha256: current.inputSha256,
    attachmentManifestSha256: current.attachmentManifestSha256,
    launchReceiptSha256: launch.receiptSha256,
    independentReviewAggregateSha256: launch.review.aggregateSha256,
    applicationRoundtripStatus: roundtrip?.status ?? "failed",
    applicationRoundtripRunId: roundtrip?.runId ?? null,
    applicationDocumentCount: roundtrip?.applicationDocumentCount ?? 0,
    fieldReadyDocumentCount: roundtrip?.fieldReadyDocumentCount ?? 0,
    recognizedFieldCount: roundtrip?.recognizedFieldCount ?? 0,
  };
}

function guardAnalysisLaunchPromotionPlan(
  readiness: AnalysisLaunchPromotionReadiness,
  plan: Pick<GrantPromotionPlan, "criteria" | "conversion" | "scopeRejectedCriterionIndexes">,
): AnalysisLaunchPromotionReadiness {
  if (readiness.disposition !== "ready" && readiness.disposition !== "conditional") {
    return readiness;
  }
  const reasons = [...readiness.reasons];
  if (plan.conversion.error) reasons.push("promotion_conversion_error");
  if (plan.conversion.dropped > (plan.scopeRejectedCriterionIndexes?.length ?? 0)) {
    reasons.push("promotion_conversion_drop");
  }
  if (plan.criteria.length === 0) reasons.push("empty_promotion_plan");
  if (reasons.length === readiness.reasons.length) return readiness;
  return {
    ...readiness,
    disposition: "held",
    reasons: [...new Set(reasons)].sort(),
  };
}

async function loadLaunch(root: string, receiptSha256: string): Promise<LoadedLaunch> {
  const receipt = normalizeAnalysisLaunchReceipt(
    await readAnalysisLaunchArtifact("receipts", receiptSha256, root),
  );
  const manifest = normalizeAnalysisLaunchManifest(
    await readAnalysisLaunchArtifact("manifests", receipt.manifestSha256, root),
  );
  const grant = normalizeAnalysisLaunchGrant(
    await readAnalysisLaunchArtifact("grants", receipt.grantSha256, root),
  );
  if (
    grant.manifestSha256 !== receipt.manifestSha256
    || grant.targetCount !== manifest.targets.length
    || receipt.targets.length !== manifest.targets.length
  ) {
    throw new Error(`launch receipt manifest/grant cardinality가 다릅니다: ${receiptSha256}`);
  }
  for (const target of receipt.targets) {
    const manifestTarget = manifest.targets.find((item) => item.sequence === target.sequence);
    if (!manifestTarget || manifestTarget.grantId !== target.grantId) {
      throw new Error(`launch receipt target이 manifest와 다릅니다: ${target.grantId}`);
    }
  }
  return {
    receiptSha256,
    receipt,
    manifest,
    review: await loadReviewEvidence(root, receiptSha256, receipt),
  };
}

async function loadAndVerifyTarget(
  root: string,
  launch: LoadedLaunch,
  target: AnalysisLaunchReceiptTarget,
): Promise<LoadedTarget> {
  if (!target.runArtifactPath || !target.runArtifactSha256) {
    throw new Error(`publishable launch target의 run artifact가 없습니다: ${target.grantId}`);
  }
  const runPath = safePathInside(root, resolve(root, target.runArtifactPath));
  const runBytes = await readFile(runPath);
  if (sha256(runBytes) !== target.runArtifactSha256) {
    throw new Error(`launch run artifact SHA가 다릅니다: ${target.grantId}`);
  }
  const run = JSON.parse(runBytes.toString("utf8")) as LabRun;
  const manifestTarget = launch.manifest.targets.find((item) => item.sequence === target.sequence)!;
  const packet = launch.review.packetBySequence.get(target.sequence);
  const comparison = launch.review.comparisonBySequence.get(target.sequence);
  if (
    !packet
    || !comparison
    || run.grantId !== target.grantId
    || run.runId !== packet?.runId
    || packet.grantId !== target.grantId
    || run.inputSha256 !== manifestTarget.inputSha256
    || run.attachmentManifestSha256 !== manifestTarget.attachmentManifestSha256
    || run.model !== launch.manifest.execution.model
    || run.promptVersion !== launch.manifest.execution.promptVersion
    || run.transport !== launch.manifest.execution.transport
    || comparison?.criterionTotal !== run.criteria.length
    || (comparison.criterionTotal + comparison.axisTotal) < 22
  ) {
    throw new Error(`launch run/manifest/review exact binding이 다릅니다: ${target.grantId}`);
  }
  const packetPath = safePathInside(root, resolve(root, packet.path));
  const packetBytes = await readFile(packetPath);
  if (sha256(packetBytes) !== packet.sha256) {
    throw new Error(`independent review packet SHA가 다릅니다: ${target.grantId}`);
  }
  const packetBody = record(JSON.parse(packetBytes.toString("utf8")), "review packet");
  if (
    packetBody.schema !== INDEPENDENT_REVIEW_PACKET_SCHEMA
    || packetBody.launchReceiptSha256 !== launch.receiptSha256
    || packetBody.sequence !== target.sequence
    || packetBody.grantId !== target.grantId
    || packetBody.runId !== run.runId
    || packetBody.runArtifactPath !== relative(root, runPath).split(sep).join("/")
    || packetBody.runArtifactSha256 !== target.runArtifactSha256
  ) {
    throw new Error(`independent review packet 결속이 다릅니다: ${target.grantId}`);
  }
  return { launch, target, run, runArtifactSha256: target.runArtifactSha256 };
}

async function loadReviewEvidence(
  root: string,
  receiptSha256: string,
  receipt: AnalysisLaunchReceipt,
): Promise<ReviewEvidence> {
  const reviewRoot = join(root, "spike-out", "analysis-lab", "independent-review", receiptSha256);
  const manifestFiles = (await readdir(reviewRoot))
    .filter((name) => /^[a-f0-9]{64}\.manifest\.json$/u.test(name))
    .sort();
  if (manifestFiles.length !== 1) {
    throw new Error(`independent review manifest가 하나로 확정되지 않습니다: ${receiptSha256}`);
  }
  const manifestFile = manifestFiles[0]!;
  const manifestSha256 = manifestFile.slice(0, 64);
  const manifestBytes = await readFile(join(reviewRoot, manifestFile));
  if (sha256(manifestBytes) !== manifestSha256) {
    throw new Error(`independent review manifest SHA가 다릅니다: ${receiptSha256}`);
  }
  const manifest = record(JSON.parse(manifestBytes.toString("utf8")), "review manifest");
  if (
    manifest.schema !== INDEPENDENT_REVIEW_MANIFEST_SCHEMA
    || manifest.launchReceiptSha256 !== receiptSha256
    || manifest.launchManifestSha256 !== receipt.manifestSha256
    || manifest.launchGrantSha256 !== receipt.grantSha256
    || !Array.isArray(manifest.packets)
    || !Array.isArray(manifest.reviewers)
    || manifest.reviewers.length !== 1
  ) {
    throw new Error(`independent review manifest 결속이 다릅니다: ${receiptSha256}`);
  }
  const reviewer = record(manifest.reviewers[0], "reviewer");
  if (
    reviewer.reviewer !== "codex"
    || reviewer.transport !== "codex-cli"
    || reviewer.auth !== "chatgpt-subscription"
    || typeof reviewer.model !== "string"
    || !reviewer.model.trim()
  ) {
    throw new Error(`독립 검수가 Codex 구독 경로가 아닙니다: ${receiptSha256}`);
  }
  const packetBySequence = new Map<number, ReviewManifestPacket>();
  for (const value of manifest.packets) {
    const packet = record(value, "review manifest packet");
    const normalized: ReviewManifestPacket = {
      sequence: integer(packet.sequence, "packet.sequence"),
      grantId: text(packet.grantId, "packet.grantId"),
      runId: text(packet.runId, "packet.runId"),
      path: text(packet.path, "packet.path"),
      sha256: exactSha(packet.sha256, "packet.sha256"),
    };
    if (packetBySequence.has(normalized.sequence)) {
      throw new Error(`independent review packet sequence 중복: ${normalized.sequence}`);
    }
    packetBySequence.set(normalized.sequence, normalized);
  }

  const aggregateDir = join(reviewRoot, "review-runs", manifestSha256);
  const aggregateFiles = (await readdir(aggregateDir))
    .filter((name) => /^[a-f0-9]{64}\.aggregate\.json$/u.test(name))
    .sort();
  if (aggregateFiles.length !== 1) {
    throw new Error(`independent review aggregate가 하나로 확정되지 않습니다: ${receiptSha256}`);
  }
  const aggregateFile = aggregateFiles[0]!;
  const aggregateSha256 = aggregateFile.slice(0, 64);
  const aggregateBytes = await readFile(join(aggregateDir, aggregateFile));
  if (sha256(aggregateBytes) !== aggregateSha256) {
    throw new Error(`independent review aggregate SHA가 다릅니다: ${receiptSha256}`);
  }
  const aggregate = record(JSON.parse(aggregateBytes.toString("utf8")), "review aggregate");
  if (
    aggregate.schema !== INDEPENDENT_REVIEW_AGGREGATE_SCHEMA
    || aggregate.manifestSha256 !== manifestSha256
    || aggregate.launchReceiptSha256 !== receiptSha256
    || aggregate.reviewMode !== "codex-only"
    || aggregate.reviewedTargets !== packetBySequence.size
    || !Array.isArray(aggregate.comparisons)
  ) {
    throw new Error(`independent review aggregate 결속이 다릅니다: ${receiptSha256}`);
  }
  const summaries = record(aggregate.reviewerSummaries, "reviewer summaries");
  const codex = record(summaries.codex, "codex summary");
  if (codex.model !== reviewer.model || codex.transport !== "codex-cli") {
    throw new Error(`independent review aggregate reviewer가 다릅니다: ${receiptSha256}`);
  }
  const comparisonBySequence = new Map<number, { criterionTotal: number; axisTotal: number }>();
  for (const value of aggregate.comparisons) {
    const comparison = record(value, "review comparison");
    const sequence = integer(comparison.sequence, "comparison.sequence");
    comparisonBySequence.set(sequence, {
      criterionTotal: integer(comparison.criterionTotal, "comparison.criterionTotal"),
      axisTotal: integer(comparison.axisTotal, "comparison.axisTotal"),
    });
  }
  if (
    comparisonBySequence.size !== packetBySequence.size
    || [...packetBySequence.keys()].some((sequence) => !comparisonBySequence.has(sequence))
  ) {
    throw new Error(`independent review comparison coverage가 불완전합니다: ${receiptSha256}`);
  }
  const consensus = record(aggregate.consensus, "review consensus");
  if (!Array.isArray(consensus.defects) || !Array.isArray(consensus.unresolved)) {
    throw new Error(`independent review consensus가 불완전합니다: ${receiptSha256}`);
  }
  const blockedSequences = new Set<number>();
  for (const value of [...consensus.defects, ...consensus.unresolved]) {
    blockedSequences.add(integer(record(value, "review finding").sequence, "finding.sequence"));
  }
  if (Array.isArray(aggregate.heldAudit)) {
    for (const value of aggregate.heldAudit) {
      blockedSequences.add(integer(record(value, "held audit").sequence, "held.sequence"));
    }
  }
  return {
    manifestSha256,
    aggregateSha256,
    packetBySequence,
    comparisonBySequence,
    blockedSequences,
  };
}

function normalizeExactShaList(values: readonly string[], label: string): string[] {
  const normalized = [...new Set(values.map((value) => exactSha(value, label)))].sort();
  if (normalized.length === 0 || normalized.length !== values.length) {
    throw new Error(`${label} SHA 목록에 빈 값 또는 중복이 있습니다.`);
  }
  return normalized;
}

function normalizeExactGrantIds(values: readonly string[]): string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
  if (normalized.length === 0 || normalized.length !== values.length) {
    throw new Error("exact grantIds에 빈 값 또는 중복이 있습니다.");
  }
  return normalized;
}

function safePathInside(root: string, path: string): string {
  const normalizedRoot = resolve(root);
  const normalized = resolve(path);
  if (normalized !== normalizedRoot && !normalized.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error(`repository 밖 경로는 허용되지 않습니다: ${path}`);
  }
  return normalized;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}가 객체가 아닙니다.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label}가 비었습니다.`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label}가 정수가 아닙니다.`);
  return Number(value);
}

function exactSha(value: unknown, label: string): string {
  const normalized = text(value, label).toLowerCase();
  if (!SHA256.test(normalized)) throw new Error(`${label}가 SHA-256이 아닙니다.`);
  return normalized;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
