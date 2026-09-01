import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { CriterionDimension } from "@cunote/contracts";
import type { LabRun } from "./lab-contract";
import {
  AI_REVIEW_PROMPT_VERSION,
  buildAiReviewToolSchema,
  buildSystemPrompt,
  deriveEmptyAxes,
  loadGuideRubric,
  reassembleLabInputForRun,
  renderCriterionForPrompt,
  validateAiReviewPayload,
} from "./ai-review";
import {
  DEEP_ANALYSIS_ACTOR_TRACK_SCOPE_RULE,
  DEEP_ANALYSIS_ALTERNATIVE_PATH_SCOPE_RULE,
  DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE,
  DEEP_ANALYSIS_ELIGIBILITY_RANKING_SEPARATION_RULE,
  DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE,
  DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE,
  DEEP_ANALYSIS_STRUCTURED_TARGET_RULE,
  DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE,
} from "../deep-analysis/extractor";
import { DIMENSION_LABELS } from "./diff";
import { findMonorepoRoot } from "./run-store";

export const INDEPENDENT_REVIEW_PACKET_SCHEMA = "independent-ai-review-packet-v2";
export const INDEPENDENT_REVIEW_MANIFEST_SCHEMA = "independent-ai-review-manifest-v2";
export const LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA = "independent-ai-review-manifest-v1";
export const INDEPENDENT_REVIEW_RESULT_SCHEMA = "independent-ai-review-result-v1";
export const INDEPENDENT_REVIEW_BUNDLE_SCHEMA = "independent-ai-review-bundle-v1";
export const INDEPENDENT_REVIEW_COMBINED_RAW_SCHEMA = "independent-ai-review-combined-raw-v1";
export const INDEPENDENT_REVIEW_AGGREGATE_SCHEMA = "independent-ai-review-aggregate-v2";
export const INDEPENDENT_REVIEW_POLICY_VERSION = "codex-only-v2";
export const LEGACY_INDEPENDENT_REVIEW_POLICY_VERSION = "codex-only-v1";

export interface IndependentReviewConsensusFinding {
  sequence: number;
  kind: "criterion" | "axis";
  key: number | string;
  verdict: string;
  classification: "defect" | "unresolved";
  codexNote: string | null;
  grokNote: string | null;
  codexMatchImpact: string | null;
  grokMatchImpact: string | null;
}

interface LaunchTarget {
  sequence: number;
  grantId: string;
  status: "publishable" | "held" | "failed" | "skipped";
  runArtifactPath: string;
  runArtifactSha256: string;
  error: string | null;
}

interface LaunchReceipt {
  schema: "analysis-launch-receipt-v1";
  manifestSha256: string;
  grantSha256: string;
  targets: LaunchTarget[];
}

export interface IndependentReviewPacket {
  schema: typeof INDEPENDENT_REVIEW_PACKET_SCHEMA;
  launchReceiptSha256: string;
  launchManifestSha256: string;
  sequence: number;
  grantId: string;
  runId: string;
  source: string;
  sourceId: string;
  extractorModel: string;
  runArtifactPath: string;
  runArtifactSha256: string;
  inputSha256: string;
  promptVersion: typeof AI_REVIEW_PROMPT_VERSION;
  reviewPolicyVersion: typeof INDEPENDENT_REVIEW_POLICY_VERSION;
  guideSha256: string;
  systemPrompt: string;
  userMessage: string;
  outputSchema: Record<string, unknown>;
}

export interface IndependentReviewResult {
  schema: typeof INDEPENDENT_REVIEW_RESULT_SCHEMA;
  reviewer: "codex" | "grok";
  reviewerModel: string;
  reviewerTransport: "codex-cli" | "grok-bot";
  packetSha256: string;
  launchReceiptSha256: string;
  sequence: number;
  grantId: string;
  runId: string;
  createdAt: string;
  criterionReviews: unknown[];
  axisReviews: unknown[];
}

interface IndependentReviewManifest {
  schema: typeof INDEPENDENT_REVIEW_MANIFEST_SCHEMA | typeof LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA;
  launchReceiptSha256: string;
  reviewPolicyVersion?:
    | typeof INDEPENDENT_REVIEW_POLICY_VERSION
    | typeof LEGACY_INDEPENDENT_REVIEW_POLICY_VERSION;
  reviewers: Array<{
    reviewer: "codex" | "grok";
    transport: "codex-cli" | "grok-bot";
    auth: string;
    model: string;
  }>;
  policy: {
    reviewerMode?: "codex-only";
    databaseWrites: false;
    promotion: false;
    deployment: false;
  };
  packets: Array<{
    sequence: number;
    grantId: string;
    runId: string;
    path: string;
    sha256: string;
  }>;
  heldTargets: Array<{
    sequence: number;
    grantId: string;
    status: string;
    runArtifactPath: string;
    runArtifactSha256: string;
    error: string | null;
  }>;
  selection: {
    mode: "full_receipt" | "exact_sequences";
    requestedSequences: number[];
    excludedReceiptSequences: number[];
    reason: string | null;
  };
}

export async function prepareIndependentReviewPackets(
  launchReceiptPath: string,
  options: { sequences?: readonly number[]; selectionReason?: string } = {},
) {
  const root = findMonorepoRoot();
  const absoluteReceiptPath = resolve(root, launchReceiptPath);
  const receiptBytes = await readFile(absoluteReceiptPath);
  const launchReceiptSha256 = sha256(receiptBytes);
  const receipt = JSON.parse(receiptBytes.toString("utf8")) as LaunchReceipt;
  if (receipt.schema !== "analysis-launch-receipt-v1" || !Array.isArray(receipt.targets)) {
    throw new Error("analysis-launch-receipt-v1 형식이 아닙니다.");
  }
  const receiptSequences = [...receipt.targets]
    .map((target) => target.sequence)
    .sort((a, b) => a - b);
  const requestedSequences = normalizeReviewSequences(options.sequences, receiptSequences);
  const selectedSequenceSet = new Set(requestedSequences);
  const isSubset = requestedSequences.length !== receiptSequences.length;
  const selectionReason = options.selectionReason?.trim() || null;
  if (isSubset && selectionReason === null) {
    throw new Error("부분 독립 검수에는 --selection-reason이 필요합니다.");
  }

  const { rubric, guideSha256 } = await loadGuideRubric();
  const systemPrompt = buildIndependentReviewSystemPrompt(rubric);
  const outputDir = join(root, "spike-out", "analysis-lab", "independent-review", launchReceiptSha256);
  const packetDir = join(outputDir, "packets");
  await mkdir(packetDir, { recursive: true });

  const packetEntries: Array<{
    sequence: number;
    grantId: string;
    runId: string;
    path: string;
    sha256: string;
  }> = [];
  const heldTargets: Array<{
    sequence: number;
    grantId: string;
    status: string;
    runArtifactPath: string;
    runArtifactSha256: string;
    error: string | null;
  }> = [];

  for (const target of [...receipt.targets]
    .filter((candidate) => selectedSequenceSet.has(candidate.sequence))
    .sort((a, b) => a.sequence - b.sequence)) {
    const runPath = resolve(root, target.runArtifactPath);
    const runBytes = await readFile(runPath);
    const actualRunSha256 = sha256(runBytes);
    if (actualRunSha256 !== target.runArtifactSha256) {
      throw new Error(`sequence ${target.sequence} run artifact SHA 불일치`);
    }
    if (target.status !== "publishable") {
      heldTargets.push({
        sequence: target.sequence,
        grantId: target.grantId,
        status: target.status,
        runArtifactPath: target.runArtifactPath,
        runArtifactSha256: target.runArtifactSha256,
        error: target.error,
      });
      continue;
    }

    const run = JSON.parse(runBytes.toString("utf8")) as LabRun;
    if (run.grantId !== target.grantId) {
      throw new Error(`sequence ${target.sequence} grantId/run 결속 불일치`);
    }
    const input = await reassembleLabInputForRun(run);
    if (input.inputSha256 !== run.inputSha256) {
      throw new Error(`sequence ${target.sequence} 원문 input SHA 드리프트`);
    }
    const emptyAxes = deriveIndependentReviewAxes(run);
    const userMessage = buildIndependentReviewUserMessage(input.text, run, emptyAxes);
    const packet: IndependentReviewPacket = {
      schema: INDEPENDENT_REVIEW_PACKET_SCHEMA,
      launchReceiptSha256,
      launchManifestSha256: receipt.manifestSha256,
      sequence: target.sequence,
      grantId: target.grantId,
      runId: run.runId,
      source: run.source,
      sourceId: run.sourceId,
      extractorModel: run.model,
      runArtifactPath: target.runArtifactPath,
      runArtifactSha256: target.runArtifactSha256,
      inputSha256: run.inputSha256,
      promptVersion: AI_REVIEW_PROMPT_VERSION,
      reviewPolicyVersion: INDEPENDENT_REVIEW_POLICY_VERSION,
      guideSha256,
      systemPrompt,
      userMessage,
      outputSchema: buildAiReviewToolSchema(run.criteria.length, emptyAxes).input_schema,
    };
    const packetBytes = canonicalBytes(packet);
    const packetSha256 = sha256(packetBytes);
    const packetPath = join(packetDir, `${String(target.sequence).padStart(2, "0")}-${packetSha256}.json`);
    await writeFile(packetPath, packetBytes, { flag: "wx" }).catch(async (error: unknown) => {
      const current = await readFile(packetPath).catch(() => null);
      if (!current || !current.equals(packetBytes)) throw error;
    });
    packetEntries.push({
      sequence: target.sequence,
      grantId: target.grantId,
      runId: run.runId,
      path: relative(root, packetPath),
      sha256: packetSha256,
    });
  }

  const manifest = {
    schema: INDEPENDENT_REVIEW_MANIFEST_SCHEMA,
    preparedAt: new Date().toISOString(),
    launchReceiptPath: relative(root, absoluteReceiptPath),
    launchReceiptSha256,
    launchManifestSha256: receipt.manifestSha256,
    launchGrantSha256: receipt.grantSha256,
    promptVersion: AI_REVIEW_PROMPT_VERSION,
    reviewPolicyVersion: INDEPENDENT_REVIEW_POLICY_VERSION,
    guideSha256,
    reviewers: [
      { reviewer: "codex", transport: "codex-cli", auth: "chatgpt-subscription", model: "gpt-5.6-sol" },
    ],
    policy: {
      reviewerMode: "codex-only",
      publishableTargets: "full-independent-review",
      nonPublishableTargets: "deterministic-hold-audit-only",
      databaseWrites: false,
      promotion: false,
      deployment: false,
    },
    packets: packetEntries,
    heldTargets,
    selection: {
      mode: isSubset ? "exact_sequences" : "full_receipt",
      requestedSequences,
      excludedReceiptSequences: receiptSequences.filter((sequence) => !selectedSequenceSet.has(sequence)),
      reason: selectionReason,
    },
  };
  const manifestBytes = canonicalBytes(manifest);
  const manifestSha256 = sha256(manifestBytes);
  const manifestPath = join(outputDir, `${manifestSha256}.manifest.json`);
  await writeFile(manifestPath, manifestBytes, { flag: "wx" }).catch(async (error: unknown) => {
    const current = await readFile(manifestPath).catch(() => null);
    if (!current || !current.equals(manifestBytes)) throw error;
  });
  return { manifest, manifestSha256, manifestPath, outputDir };
}

export function normalizeReviewSequences(
  requested: readonly number[] | undefined,
  receiptSequences: readonly number[],
): number[] {
  const available = [...receiptSequences].sort((a, b) => a - b);
  if (available.length === 0 || new Set(available).size !== available.length) {
    throw new Error("launch receipt sequence 집합이 비었거나 중복됐습니다.");
  }
  if (available.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)) {
    throw new Error("launch receipt sequence는 0 이상의 정수여야 합니다.");
  }
  if (requested === undefined) return available;
  if (
    requested.length === 0
    || new Set(requested).size !== requested.length
    || requested.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)
  ) {
    throw new Error("독립 검수 sequence는 중복 없는 0 이상의 정수여야 합니다.");
  }
  const availableSet = new Set(available);
  const selected = [...requested].sort((a, b) => a - b);
  if (selected.some((sequence) => !availableSet.has(sequence))) {
    throw new Error("launch receipt에 없는 sequence는 독립 검수할 수 없습니다.");
  }
  return selected;
}

export async function writeIndependentReviewBundle(manifestPath: string) {
  const root = findMonorepoRoot();
  const absoluteManifestPath = resolve(root, manifestPath);
  const manifestBytes = await readFile(absoluteManifestPath);
  const manifestSha256 = sha256(manifestBytes);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    schema: string;
    packets: Array<{ sequence: number; path: string; sha256: string }>;
  };
  if (manifest.schema !== LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA) {
    throw new Error("Grok bundle은 역사 v1 manifest에서만 만들 수 있습니다.");
  }
  const packets = [];
  for (const entry of manifest.packets) {
    const packetBytes = await readFile(resolve(root, entry.path));
    if (sha256(packetBytes) !== entry.sha256) throw new Error(`sequence ${entry.sequence} packet SHA 불일치`);
    packets.push({ sequence: entry.sequence, sha256: entry.sha256, packet: JSON.parse(packetBytes.toString("utf8")) });
  }
  const bundle = {
    schema: INDEPENDENT_REVIEW_BUNDLE_SCHEMA,
    manifestSha256,
    blindReviewRules: {
      onlyUsePacketSystemPromptAndUserMessage: true,
      doNotReadOtherReviewArtifacts: true,
      outputSchema: "independent-ai-review-combined-raw-v1",
    },
    combinedOutput: {
      schema: "independent-ai-review-combined-raw-v1",
      manifestSha256,
      results: "array of { sequence, payload }, where payload exactly satisfies that packet.outputSchema",
    },
    manifest,
    packets,
  };
  const bundleBytes = canonicalBytes(bundle);
  const bundleSha256 = sha256(bundleBytes);
  const bundlePath = join(dirname(absoluteManifestPath), `${bundleSha256}.grok-bundle.json`);
  await writeFile(bundlePath, bundleBytes, { flag: "wx" }).catch(async (error: unknown) => {
    const current = await readFile(bundlePath).catch(() => null);
    if (!current || !current.equals(bundleBytes)) throw error;
  });
  return { bundlePath, bundleSha256, packetCount: packets.length };
}

export async function importGrokCombinedReview(manifestPath: string, combinedRawPath: string) {
  const root = findMonorepoRoot();
  const { manifest, manifestSha256, absoluteManifestPath } = await readVerifiedManifest(manifestPath);
  if (manifest.schema !== LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA) {
    throw new Error("Grok 검수 import는 역사 v1 manifest에서만 허용됩니다.");
  }
  const absoluteCombinedPath = resolve(root, combinedRawPath);
  const combinedBytes = await readFile(absoluteCombinedPath);
  const combinedSha256 = sha256(combinedBytes);
  const combined = JSON.parse(combinedBytes.toString("utf8")) as {
    schema?: string;
    manifestSha256?: string;
    results?: Array<{ sequence?: unknown; payload?: unknown }>;
  };
  if (combined.schema !== INDEPENDENT_REVIEW_COMBINED_RAW_SCHEMA) {
    throw new Error("Grok combined raw 형식이 아닙니다.");
  }
  if (combined.manifestSha256 !== manifestSha256) {
    throw new Error("Grok combined raw의 manifest SHA 결속이 일치하지 않습니다.");
  }
  if (!Array.isArray(combined.results)) throw new Error("Grok combined raw results가 배열이 아닙니다.");

  const bySequence = new Map<number, unknown>();
  for (const item of combined.results) {
    if (!Number.isInteger(item.sequence) || (item.sequence as number) < 0) {
      throw new Error(`Grok combined raw sequence가 유효하지 않습니다: ${String(item.sequence)}`);
    }
    const sequence = item.sequence as number;
    if (bySequence.has(sequence)) throw new Error(`Grok combined raw sequence ${sequence} 중복`);
    bySequence.set(sequence, item.payload);
  }
  const expectedSequences = manifest.packets.map((packet) => packet.sequence).sort((a, b) => a - b);
  const actualSequences = [...bySequence.keys()].sort((a, b) => a - b);
  if (JSON.stringify(actualSequences) !== JSON.stringify(expectedSequences)) {
    throw new Error(`Grok combined raw sequence 집합 불일치: expected=${expectedSequences.join(",")} actual=${actualSequences.join(",")}`);
  }

  const outputDir = dirname(absoluteManifestPath);
  const rawDir = join(outputDir, "grok", "raw");
  const resultDir = join(outputDir, "grok", "results");
  await Promise.all([rawDir, resultDir].map((path) => mkdir(path, { recursive: true })));
  const imported: number[] = [];
  for (const packetEntry of [...manifest.packets].sort((a, b) => a.sequence - b.sequence)) {
    const label = `sequence-${String(packetEntry.sequence).padStart(2, "0")}`;
    const packetPath = resolve(root, packetEntry.path);
    const packetBytes = await readFile(packetPath);
    if (sha256(packetBytes) !== packetEntry.sha256) throw new Error(`${label} packet SHA 불일치`);
    const rawPath = join(rawDir, `${label}.json`);
    const rawBytes = canonicalBytes(bySequence.get(packetEntry.sequence));
    await writeExactFile(rawPath, rawBytes);
    const result = await validateAndWrapIndependentReviewResult({
      packetPath,
      rawResultPath: rawPath,
      reviewer: "grok",
      reviewerModel: "provider-managed-default",
      reviewerTransport: "grok-bot",
    });
    const resultPath = join(resultDir, `${label}.json`);
    if (await fileExists(resultPath)) {
      const current = JSON.parse(await readFile(resultPath, "utf8")) as IndependentReviewResult;
      assertReviewResultBinding(current, result, packetEntry.sha256);
    } else {
      await writeIndependentReviewResult(resultPath, result);
    }
    imported.push(packetEntry.sequence);
  }
  return { manifestSha256, combinedSha256, imported, combinedRawPath: absoluteCombinedPath };
}

export async function aggregateIndependentReviews(manifestPath: string) {
  const root = findMonorepoRoot();
  const { manifest, manifestSha256, absoluteManifestPath } = await readVerifiedManifest(manifestPath);
  const outputDir = reviewResultRoot(absoluteManifestPath, manifestSha256, manifest.schema);
  const reviewMode = resolveIndependentReviewMode(manifest);
  const reviewerSummaries: Record<string, {
    model: string;
    transport: string;
    criterionVerdicts: Record<string, number>;
    axisVerdicts: Record<string, number>;
  }> = {};
  const comparisons: Array<{
    sequence: number;
    criterionTotal: number;
    criterionAgreements: number | null;
    axisTotal: number;
    axisAgreements: number | null;
    disagreements: Array<{
      kind: "criterion" | "axis";
      key: number | string;
      codexVerdict: string;
      grokVerdict: string;
      codexNote: string | null;
      grokNote: string | null;
    }>;
  }> = [];
  const priorityFindings: Array<{
    sequence: number;
    reviewer: "codex" | "grok";
    kind: "criterion" | "axis";
    key: number | string;
    verdict: string;
    matchImpact?: string;
    note: string | null;
  }> = [];
  const consensusFindings: IndependentReviewConsensusFinding[] = [];

  let criterionTotal = 0;
  let criterionAgreements = 0;
  let axisTotal = 0;
  let axisAgreements = 0;
  for (const packet of [...manifest.packets].sort((a, b) => a.sequence - b.sequence)) {
    const codex = await readBoundReview(outputDir, packet, manifest.launchReceiptSha256, "codex");
    addReviewerSummary(reviewerSummaries, codex);
    const codexCriteria = indexReviews(codex.criterionReviews, "criterionIndex");
    const codexAxes = indexReviews(codex.axisReviews, "dimension");
    const disagreements: (typeof comparisons)[number]["disagreements"] = [];
    let sequenceCriterionAgreements = 0;
    let sequenceAxisAgreements = 0;

    if (reviewMode === "codex-only") {
      consensusFindings.push(...deriveSingleIndependentReviewFindings(packet.sequence, codex));
    } else {
      const grok = await readBoundReview(outputDir, packet, manifest.launchReceiptSha256, "grok");
      addReviewerSummary(reviewerSummaries, grok);
      collectPriorityFindings(priorityFindings, packet.sequence, grok);
      const grokCriteria = indexReviews(grok.criterionReviews, "criterionIndex");
      const grokAxes = indexReviews(grok.axisReviews, "dimension");
      consensusFindings.push(...deriveIndependentReviewConsensus(packet.sequence, codex, grok));
      for (const [key, codexReview] of codexCriteria) {
        const grokReview = grokCriteria.get(key);
        if (!grokReview) throw new Error(`sequence ${packet.sequence} Grok criterion ${key} 누락`);
        if (codexReview.verdict === grokReview.verdict) sequenceCriterionAgreements += 1;
        else disagreements.push(toDisagreement("criterion", key, codexReview, grokReview));
      }
      for (const [key, codexReview] of codexAxes) {
        const grokReview = grokAxes.get(key);
        if (!grokReview) throw new Error(`sequence ${packet.sequence} Grok axis ${key} 누락`);
        if (codexReview.verdict === grokReview.verdict) sequenceAxisAgreements += 1;
        else disagreements.push(toDisagreement("axis", key, codexReview, grokReview));
      }
    }
    collectPriorityFindings(priorityFindings, packet.sequence, codex);
    criterionTotal += codexCriteria.size;
    criterionAgreements += sequenceCriterionAgreements;
    axisTotal += codexAxes.size;
    axisAgreements += sequenceAxisAgreements;
    comparisons.push({
      sequence: packet.sequence,
      criterionTotal: codexCriteria.size,
      criterionAgreements: reviewMode === "codex-only" ? null : sequenceCriterionAgreements,
      axisTotal: codexAxes.size,
      axisAgreements: reviewMode === "codex-only" ? null : sequenceAxisAgreements,
      disagreements,
    });
  }

  const heldAudit = [];
  for (const held of [...manifest.heldTargets].sort((a, b) => a.sequence - b.sequence)) {
    const bytes = await readFile(resolve(root, held.runArtifactPath));
    const actualSha256 = sha256(bytes);
    if (actualSha256 !== held.runArtifactSha256) throw new Error(`held sequence ${held.sequence} run artifact SHA 불일치`);
    heldAudit.push({ ...held, verified: true as const });
  }

  const aggregate = {
    schema: INDEPENDENT_REVIEW_AGGREGATE_SCHEMA,
    createdAt: new Date().toISOString(),
    manifestSha256,
    launchReceiptSha256: manifest.launchReceiptSha256,
    reviewedTargets: manifest.packets.length,
    heldTargets: heldAudit.length,
    reviewerSummaries,
    reviewMode,
    agreement: {
      applicability: reviewMode === "codex-only" ? "not-applicable" : "dual-reviewer",
      criterion: {
        agreed: reviewMode === "codex-only" ? null : criterionAgreements,
        total: criterionTotal,
        rate: reviewMode === "codex-only" || criterionTotal === 0
          ? null
          : criterionAgreements / criterionTotal,
      },
      axis: {
        agreed: reviewMode === "codex-only" ? null : axisAgreements,
        total: axisTotal,
        rate: reviewMode === "codex-only" || axisTotal === 0
          ? null
          : axisAgreements / axisTotal,
      },
    },
    comparisons,
    priorityFindings,
    consensus: {
      basis: reviewMode === "codex-only" ? "single-independent-reviewer" : "dual-reviewer-consensus",
      defects: consensusFindings.filter((finding) => finding.classification === "defect"),
      unresolved: consensusFindings.filter((finding) => finding.classification === "unresolved"),
      defectCount: consensusFindings.filter((finding) => finding.classification === "defect").length,
      unresolvedCount: consensusFindings.filter((finding) => finding.classification === "unresolved").length,
      affectedTargets: [...new Set(consensusFindings.map((finding) => finding.sequence))].sort((a, b) => a - b),
    },
    admission: buildIndependentReviewAdmission(consensusFindings, heldAudit.length, reviewMode),
    heldAudit,
    policy: { databaseWrites: false, promotion: false, deployment: false },
  };
  const bytes = canonicalBytes(aggregate);
  const aggregateSha256 = sha256(bytes);
  const aggregatePath = join(outputDir, `${aggregateSha256}.aggregate.json`);
  await writeExactFile(aggregatePath, bytes);
  return { aggregate, aggregateSha256, aggregatePath };
}

export function deriveSingleIndependentReviewFindings(
  sequence: number,
  review: Pick<IndependentReviewResult, "criterionReviews" | "axisReviews">,
): IndependentReviewConsensusFinding[] {
  const findings: IndependentReviewConsensusFinding[] = [];
  for (const [key, item] of indexReviews(review.criterionReviews, "criterionIndex")) {
    if (item.verdict === "correct") continue;
    findings.push({
      sequence,
      kind: "criterion",
      key,
      verdict: item.verdict,
      classification: item.verdict === "unsure" ? "unresolved" : "defect",
      codexNote: item.note,
      grokNote: null,
      codexMatchImpact: item.matchImpact ?? null,
      grokMatchImpact: null,
    });
  }
  for (const [key, item] of indexReviews(review.axisReviews, "dimension")) {
    if (item.verdict === "confirmed_absent") continue;
    findings.push({
      sequence,
      kind: "axis",
      key,
      verdict: item.verdict,
      classification: "defect",
      codexNote: item.note,
      grokNote: null,
      codexMatchImpact: item.matchImpact ?? null,
      grokMatchImpact: null,
    });
  }
  return findings.sort((left, right) => (
    left.kind.localeCompare(right.kind) || String(left.key).localeCompare(String(right.key), "en", { numeric: true })
  ));
}

export function deriveIndependentReviewConsensus(
  sequence: number,
  codex: Pick<IndependentReviewResult, "criterionReviews" | "axisReviews">,
  grok: Pick<IndependentReviewResult, "criterionReviews" | "axisReviews">,
): IndependentReviewConsensusFinding[] {
  const findings: IndependentReviewConsensusFinding[] = [];
  const codexCriteria = indexReviews(codex.criterionReviews, "criterionIndex");
  const grokCriteria = indexReviews(grok.criterionReviews, "criterionIndex");
  for (const [key, codexReview] of codexCriteria) {
    const grokReview = grokCriteria.get(key);
    if (!grokReview || codexReview.verdict !== grokReview.verdict || codexReview.verdict === "correct") {
      continue;
    }
    findings.push({
      sequence,
      kind: "criterion",
      key,
      verdict: codexReview.verdict,
      classification: codexReview.verdict === "unsure" ? "unresolved" : "defect",
      codexNote: codexReview.note,
      grokNote: grokReview.note,
      codexMatchImpact: codexReview.matchImpact ?? null,
      grokMatchImpact: grokReview.matchImpact ?? null,
    });
  }
  const codexAxes = indexReviews(codex.axisReviews, "dimension");
  const grokAxes = indexReviews(grok.axisReviews, "dimension");
  for (const [key, codexReview] of codexAxes) {
    const grokReview = grokAxes.get(key);
    if (
      !grokReview
      || codexReview.verdict !== grokReview.verdict
      || codexReview.verdict === "confirmed_absent"
    ) continue;
    findings.push({
      sequence,
      kind: "axis",
      key,
      verdict: codexReview.verdict,
      classification: "defect",
      codexNote: codexReview.note,
      grokNote: grokReview.note,
      codexMatchImpact: codexReview.matchImpact ?? null,
      grokMatchImpact: grokReview.matchImpact ?? null,
    });
  }
  return findings.sort((left, right) => (
    left.kind.localeCompare(right.kind) || String(left.key).localeCompare(String(right.key), "en", { numeric: true })
  ));
}

function buildIndependentReviewAdmission(
  consensusFindings: IndependentReviewConsensusFinding[],
  heldTargets: number,
  reviewMode: "codex-only" | "dual-legacy",
) {
  const defectCount = consensusFindings.filter((finding) => finding.classification === "defect").length;
  const unresolvedCount = consensusFindings.filter((finding) => finding.classification === "unresolved").length;
  const reviewedTargetsStatus = defectCount > 0 || unresolvedCount > 0 ? "HOLD" : "PASS";
  const cohortStatus = reviewedTargetsStatus === "HOLD" || heldTargets > 0 ? "HOLD" : "PASS";
  return {
    reviewedTargetsStatus,
    cohortStatus,
    reasons: [
      ...(defectCount > 0 ? [`consensus_defects:${defectCount}`] : []),
      ...(unresolvedCount > 0 ? [`consensus_unresolved:${unresolvedCount}`] : []),
      ...(heldTargets > 0 ? [`non_publishable_targets:${heldTargets}`] : []),
    ],
    policy: reviewMode === "codex-only"
      ? "Codex 독립 검수의 비정상 criterion·빈 축 또는 미해결 판정은 후속 보정과 재검수 전까지 승격을 보류한다."
      : "두 독립 검수자가 같은 비정상 판정을 내린 criterion·빈 축 또는 미해결 판정은 후속 보정과 재검수 전까지 승격을 보류한다.",
  } as const;
}

export async function validateAndWrapIndependentReviewResult(options: {
  packetPath: string;
  rawResultPath: string;
  reviewer: "codex" | "grok";
  reviewerModel: string;
  reviewerTransport: "codex-cli" | "grok-bot";
}): Promise<IndependentReviewResult> {
  const packetBytes = await readFile(options.packetPath);
  const packet = JSON.parse(packetBytes.toString("utf8")) as IndependentReviewPacket;
  const raw = JSON.parse(await readFile(options.rawResultPath, "utf8")) as Record<string, unknown>;
  const criterionCount = ((packet.outputSchema.properties as Record<string, unknown>).criterion_reviews as {
    minItems: number;
  }).minItems;
  const axisProperty = (packet.outputSchema.properties as Record<string, unknown>).axis_reviews as {
    items: { properties: { dimension: { enum: CriterionDimension[] } } };
  };
  const emptyAxes = axisProperty.items.properties.dimension.enum;
  const checked = validateAiReviewPayload(raw, criterionCount, emptyAxes);
  if (!checked.ok) throw new Error(`${options.reviewer} 검수 응답 검증 실패: ${checked.reason}`);
  return {
    schema: INDEPENDENT_REVIEW_RESULT_SCHEMA,
    reviewer: options.reviewer,
    reviewerModel: options.reviewerModel,
    reviewerTransport: options.reviewerTransport,
    packetSha256: sha256(packetBytes),
    launchReceiptSha256: packet.launchReceiptSha256,
    sequence: packet.sequence,
    grantId: packet.grantId,
    runId: packet.runId,
    createdAt: new Date().toISOString(),
    criterionReviews: checked.criterionReviews,
    axisReviews: checked.axisReviews,
  };
}

function buildIndependentReviewUserMessage(
  inputText: string,
  run: LabRun,
  emptyAxes: CriterionDimension[],
): string {
  return [
    "아래는 ① 공고 원문 입력 ② 다른 모델이 추출한 criteria ③ 추출이 조건 없음으로 남긴 빈 축 목록이다.",
    "기준서대로 criteria 전 인덱스와 빈 축 전부를 판정하라.",
    "",
    "[공고 원문 입력 — 판정의 유일한 근거]",
    inputText,
    "",
    `[검수 대상 A — 추출된 criteria ${run.criteria.length}건 (criterion_index 0~${run.criteria.length - 1} 전수 판정)]`,
    ...run.criteria.map((criterion, index) => renderCriterionForPrompt(index, criterion)),
    "",
    `[검수 대상 B — 빈 축 ${emptyAxes.length}축 (각 축의 자격요건이 원문 전체에 없는지 전수 확인)]`,
    ...emptyAxes.map((dimension) => `- ${dimension} (${DIMENSION_LABELS[dimension]})`),
  ].join("\n");
}

export function buildIndependentReviewSystemPrompt(rubric: string): string {
  return [
    buildSystemPrompt(rubric),
    "",
    "[창업노트 현재 매처 계약 — 독립 검수 필수 규칙]",
    `- ${DEEP_ANALYSIS_PRIOR_AWARD_STATE_RULE}`,
    `- ${DEEP_ANALYSIS_TARGET_TYPE_LIST_SEMANTICS_RULE}`,
    `- ${DEEP_ANALYSIS_STRUCTURED_TARGET_RULE}`,
    `- ${DEEP_ANALYSIS_STRUCTURED_FILTER_METADATA_RULE}`,
    `- ${DEEP_ANALYSIS_ALTERNATIVE_PATH_SCOPE_RULE}`,
    `- ${DEEP_ANALYSIS_ACTOR_TRACK_SCOPE_RULE}`,
    `- ${DEEP_ANALYSIS_APPLICATION_MATCHING_SCOPE_RULE}`,
    `- ${DEEP_ANALYSIS_ELIGIBILITY_RANKING_SEPARATION_RULE}`,
  ].join("\n");
}

/**
 * 런칭 독립 검수는 실제로 `조건 없음`으로 종결한 축만 누락 검수한다.
 * ambiguous/input_missing은 추출기가 의도적으로 보존한 미해결 상태이며 promotion readiness가
 * 별도로 결속한다. 이를 이분법(confirmed_absent/missed_condition) 검수에 다시 넣으면 정직한
 * 보류를 누락 결함으로 오인해 같은 입력을 반복 repair하게 된다.
 *
 * 구 런처럼 assessment가 없는 축은 안전하게 검수 대상에 유지한다. condition_found인데
 * criterion이 없는 비정상 축도 reviewer가 누락을 잡을 수 있도록 유지한다.
 */
export function deriveIndependentReviewAxes(
  run: {
    runId: string;
    criteria: ReadonlyArray<Pick<LabRun["criteria"][number], "dimension">>;
    dimensionDiffs: ReadonlyArray<Pick<LabRun["dimensionDiffs"][number], "dimension" | "proposed">>;
    axisAssessments: ReadonlyArray<LabRun["axisAssessments"][number]>;
  },
): CriterionDimension[] {
  const emptyAxes = deriveEmptyAxes(run);
  const assessments = new Map<CriterionDimension, LabRun["axisAssessments"][number]>();
  for (const assessment of run.axisAssessments) {
    if (assessments.has(assessment.dimension)) {
      throw new Error(`독립 검수 축 평가 중복: ${assessment.dimension} (${run.runId})`);
    }
    assessments.set(assessment.dimension, assessment);
  }
  return emptyAxes.filter((dimension) => {
    const status = assessments.get(dimension)?.status;
    return status !== "ambiguous" && status !== "input_missing";
  });
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function writeIndependentReviewResult(path: string, result: IndependentReviewResult): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, canonicalBytes(result), { flag: "wx" });
}

async function readVerifiedManifest(manifestPath: string): Promise<{
  manifest: IndependentReviewManifest;
  manifestSha256: string;
  absoluteManifestPath: string;
}> {
  const root = findMonorepoRoot();
  const absoluteManifestPath = resolve(root, manifestPath);
  const bytes = await readFile(absoluteManifestPath);
  const manifestSha256 = sha256(bytes);
  const addressedSha256 = basename(absoluteManifestPath).replace(/\.manifest\.json$/, "");
  if (manifestSha256 !== addressedSha256) throw new Error("manifest content address가 일치하지 않습니다.");
  const manifest = JSON.parse(bytes.toString("utf8")) as IndependentReviewManifest;
  if (
    manifest.schema !== INDEPENDENT_REVIEW_MANIFEST_SCHEMA
    && manifest.schema !== LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA
  ) throw new Error("독립 검수 manifest 형식이 아닙니다.");
  return { manifest, manifestSha256, absoluteManifestPath };
}

function resolveIndependentReviewMode(manifest: IndependentReviewManifest): "codex-only" | "dual-legacy" {
  const reviewers = manifest.reviewers.map((reviewer) => reviewer.reviewer).sort();
  if (
    manifest.schema === INDEPENDENT_REVIEW_MANIFEST_SCHEMA
    && (
      manifest.reviewPolicyVersion === INDEPENDENT_REVIEW_POLICY_VERSION
      || manifest.reviewPolicyVersion === LEGACY_INDEPENDENT_REVIEW_POLICY_VERSION
    )
    && manifest.policy.reviewerMode === "codex-only"
    && reviewers.length === 1
    && reviewers[0] === "codex"
  ) return "codex-only";
  if (
    manifest.schema === LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA
    && reviewers.length === 2
    && reviewers[0] === "codex"
    && reviewers[1] === "grok"
  ) return "dual-legacy";
  throw new Error("독립 검수 reviewer 정책이 지원되는 codex-only 또는 역사 dual-review 형식이 아닙니다.");
}

export function reviewResultRoot(
  manifestPath: string,
  manifestSha256: string,
  schema: string,
): string {
  return schema === INDEPENDENT_REVIEW_MANIFEST_SCHEMA
    ? join(dirname(manifestPath), "review-runs", manifestSha256)
    : dirname(manifestPath);
}

async function writeExactFile(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { flag: "wx" }).catch(async (error: unknown) => {
    const current = await readFile(path).catch(() => null);
    if (!current || !current.equals(bytes)) throw error;
  });
}

async function fileExists(path: string): Promise<boolean> {
  return readFile(path).then(() => true, () => false);
}

function assertReviewResultBinding(
  current: IndependentReviewResult,
  expected: IndependentReviewResult,
  packetSha256: string,
): void {
  if (
    current.schema !== INDEPENDENT_REVIEW_RESULT_SCHEMA ||
    current.reviewer !== expected.reviewer ||
    current.reviewerModel !== expected.reviewerModel ||
    current.reviewerTransport !== expected.reviewerTransport ||
    current.packetSha256 !== packetSha256 ||
    current.launchReceiptSha256 !== expected.launchReceiptSha256 ||
    current.sequence !== expected.sequence ||
    current.grantId !== expected.grantId ||
    current.runId !== expected.runId ||
    canonicalJson(current.criterionReviews) !== canonicalJson(expected.criterionReviews) ||
    canonicalJson(current.axisReviews) !== canonicalJson(expected.axisReviews)
  ) {
    throw new Error(`sequence ${expected.sequence} 기존 ${expected.reviewer} result 결속/내용 불일치`);
  }
}

type NormalizedReview = { verdict: string; note: string | null; matchImpact?: string };

function indexReviews(items: unknown[], key: "criterionIndex" | "dimension"): Map<number | string, NormalizedReview> {
  const indexed = new Map<number | string, NormalizedReview>();
  for (const item of items) {
    if (!item || typeof item !== "object") throw new Error("검수 result 항목이 객체가 아닙니다.");
    const record = item as Record<string, unknown>;
    const index = record[key];
    if ((typeof index !== "number" && typeof index !== "string") || typeof record.verdict !== "string") {
      throw new Error(`검수 result ${key}/verdict 형식이 유효하지 않습니다.`);
    }
    if (indexed.has(index)) throw new Error(`검수 result ${key}=${String(index)} 중복`);
    indexed.set(index, {
      verdict: record.verdict,
      note: typeof record.note === "string" && record.note.length > 0 ? record.note : null,
      ...(typeof record.matchImpact === "string" ? { matchImpact: record.matchImpact } : {}),
    });
  }
  return indexed;
}

function addReviewerSummary(
  summaries: Record<string, { model: string; transport: string; criterionVerdicts: Record<string, number>; axisVerdicts: Record<string, number> }>,
  result: IndependentReviewResult,
): void {
  const summary = summaries[result.reviewer] ??= {
    model: result.reviewerModel,
    transport: result.reviewerTransport,
    criterionVerdicts: {},
    axisVerdicts: {},
  };
  if (summary.model !== result.reviewerModel || summary.transport !== result.reviewerTransport) {
    throw new Error(`${result.reviewer} reviewer model/transport가 sequence 사이에서 바뀌었습니다.`);
  }
  for (const review of indexReviews(result.criterionReviews, "criterionIndex").values()) {
    summary.criterionVerdicts[review.verdict] = (summary.criterionVerdicts[review.verdict] ?? 0) + 1;
  }
  for (const review of indexReviews(result.axisReviews, "dimension").values()) {
    summary.axisVerdicts[review.verdict] = (summary.axisVerdicts[review.verdict] ?? 0) + 1;
  }
}

async function readBoundReview(
  outputDir: string,
  packet: IndependentReviewManifest["packets"][number],
  launchReceiptSha256: string,
  reviewer: "codex" | "grok",
): Promise<IndependentReviewResult> {
  const label = `sequence-${String(packet.sequence).padStart(2, "0")}`;
  const path = join(outputDir, reviewer, "results", `${label}.json`);
  const result = JSON.parse(await readFile(path, "utf8")) as IndependentReviewResult;
  if (
    result.schema !== INDEPENDENT_REVIEW_RESULT_SCHEMA ||
    result.reviewer !== reviewer ||
    result.packetSha256 !== packet.sha256 ||
    result.launchReceiptSha256 !== launchReceiptSha256 ||
    result.sequence !== packet.sequence ||
    result.grantId !== packet.grantId ||
    result.runId !== packet.runId
  ) {
    throw new Error(`${label} ${reviewer} result 결속 불일치`);
  }
  return result;
}

function toDisagreement(
  kind: "criterion" | "axis",
  key: number | string,
  codex: NormalizedReview,
  grok: NormalizedReview,
) {
  return {
    kind,
    key,
    codexVerdict: codex.verdict,
    grokVerdict: grok.verdict,
    codexNote: codex.note,
    grokNote: grok.note,
  };
}

function collectPriorityFindings(
  findings: Array<{
    sequence: number;
    reviewer: "codex" | "grok";
    kind: "criterion" | "axis";
    key: number | string;
    verdict: string;
    matchImpact?: string;
    note: string | null;
  }>,
  sequence: number,
  result: IndependentReviewResult,
): void {
  for (const [key, review] of indexReviews(result.criterionReviews, "criterionIndex")) {
    if (review.verdict === "correct") continue;
    findings.push({ sequence, reviewer: result.reviewer, kind: "criterion", key, verdict: review.verdict, note: review.note });
  }
  for (const [key, review] of indexReviews(result.axisReviews, "dimension")) {
    if (review.verdict === "confirmed_absent") continue;
    findings.push({
      sequence,
      reviewer: result.reviewer,
      kind: "axis",
      key,
      verdict: review.verdict,
      ...(review.matchImpact ? { matchImpact: review.matchImpact } : {}),
      note: review.note,
    });
  }
}
