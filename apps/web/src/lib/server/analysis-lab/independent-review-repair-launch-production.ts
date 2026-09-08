import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import type { LabRun } from "./lab-contract";
import { prepareLabAnalysis } from "./analyze";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";
import {
  analysisLaunchArtifactPath,
  createIndependentReviewRepairAnalysisLaunchManifest,
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  readAnalysisLaunchArtifact,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchApplicationRoundtripReuseBinding,
  type AnalysisLaunchManifest,
} from "./launch-batch-artifacts";
import {
  ApplicationRoundtripReuseError,
  prepareApplicationRoundtripReuse,
} from "./application-roundtrip/reuse";
import { readExactRoundtripRunArtifacts } from "./application-roundtrip/store";
import { APPLICATION_ROUNDTRIP_ADOPTED_MODEL } from "./application-roundtrip/contract";
import {
  buildIndependentReviewRepairInstruction,
  findDriftedIndependentReviewRepairTargetIndexes,
  normalizeIndependentReviewRepairAggregate,
  resolveIndependentReviewManifestPath,
  selectIndependentReviewRepairSequences,
} from "./independent-review-repair-launch";
import {
  INDEPENDENT_REVIEW_MANIFEST_SCHEMA,
  INDEPENDENT_REVIEW_PACKET_SCHEMA,
  LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA,
} from "./independent-review-packet";
import { findMonorepoRoot } from "./run-store";

const SHA256 = /^[a-f0-9]{64}$/u;

interface ReviewManifestPacket {
  readonly sequence: number;
  readonly grantId: string;
  readonly runId: string;
  readonly path: string;
  readonly sha256: string;
}

interface ReviewManifest {
  readonly schema:
    | typeof INDEPENDENT_REVIEW_MANIFEST_SCHEMA
    | typeof LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA;
  readonly launchReceiptPath: string;
  readonly launchReceiptSha256: string;
  readonly launchManifestSha256: string;
  readonly launchGrantSha256: string;
  readonly packets: readonly ReviewManifestPacket[];
}

interface IndependentReviewRepairTargetPreparation {
  readonly originalSequence: number;
  readonly grantId: string;
  readonly source: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
  readonly reviewRepair: NonNullable<AnalysisLaunchManifest["targets"][number]["reviewRepair"]> | null;
  readonly applicationRoundtripReuse: AnalysisLaunchApplicationRoundtripReuseBinding | null;
}

export async function prepareIndependentReviewRepairLaunchManifest(input: {
  readonly aggregatePath: string;
  readonly concurrency: number;
  readonly originalSequences?: readonly number[];
  readonly includeNonPublishable?: boolean;
  readonly preparedAt?: Date;
  readonly repositoryRoot?: string;
}): Promise<{
  readonly manifest: AnalysisLaunchManifest;
  readonly manifestSha256: string;
  readonly path: string;
  readonly aggregateSha256: string;
  readonly originalSequences: readonly number[];
  readonly excludedDriftedOriginalSequences: readonly number[];
}> {
  const repositoryRoot = input.repositoryRoot ?? findMonorepoRoot();
  const concurrency = normalizeConcurrency(input.concurrency);
  const provenance = await readCurrentDeepRepairExecutionProvenance({ repositoryRoot });
  const aggregatePath = resolveInside(
    resolve(repositoryRoot, "spike-out", "analysis-lab", "independent-review"),
    resolve(repositoryRoot, input.aggregatePath),
    "aggregate",
  );
  const aggregateBytes = await readFile(aggregatePath);
  const aggregateSha256 = sha256(aggregateBytes);
  if (basename(aggregatePath) !== `${aggregateSha256}.aggregate.json`) {
    throw new Error("독립 검수 aggregate 파일명이 실제 SHA와 다릅니다.");
  }
  const aggregate = normalizeIndependentReviewRepairAggregate(parseJson(aggregateBytes, "aggregate"));
  const originalSequences = selectIndependentReviewRepairSequences(
    aggregate,
    input.originalSequences,
    input.includeNonPublishable ?? false,
  );
  const reviewManifestPath = resolveInside(
    resolve(repositoryRoot, "spike-out", "analysis-lab", "independent-review"),
    resolveIndependentReviewManifestPath(aggregatePath, aggregate.manifestSha256),
    "review manifest",
  );
  const reviewManifestBytes = await readFile(reviewManifestPath);
  if (sha256(reviewManifestBytes) !== aggregate.manifestSha256) {
    throw new Error("독립 검수 manifest SHA가 aggregate 결속과 다릅니다.");
  }
  const reviewManifest = normalizeReviewManifest(parseJson(reviewManifestBytes, "review manifest"));
  if (
    reviewManifest.launchReceiptSha256 !== aggregate.launchReceiptSha256
    || new Set(reviewManifest.packets.map((packet) => packet.sequence)).size
      !== reviewManifest.packets.length
  ) {
    throw new Error("독립 검수 manifest의 receipt 또는 packet sequence 결속이 다릅니다.");
  }

  const sourceManifest = normalizeAnalysisLaunchManifest(await readAnalysisLaunchArtifact(
    "manifests",
    reviewManifest.launchManifestSha256,
    repositoryRoot,
  ));
  const sourceGrant = normalizeAnalysisLaunchGrant(await readAnalysisLaunchArtifact(
    "grants",
    reviewManifest.launchGrantSha256,
    repositoryRoot,
  ));
  if (
    sourceGrant.manifestSha256 !== reviewManifest.launchManifestSha256
    || sourceGrant.targetCount !== sourceManifest.targets.length
  ) {
    throw new Error("독립 검수 원본 launch grant가 manifest와 다릅니다.");
  }
  const receiptPath = resolveInside(
    repositoryRoot,
    resolve(repositoryRoot, reviewManifest.launchReceiptPath),
    "launch receipt",
  );
  if (
    receiptPath
    !== analysisLaunchArtifactPath("receipts", reviewManifest.launchReceiptSha256, repositoryRoot)
  ) {
    throw new Error("독립 검수 launch receipt 경로가 정본 artifact 경로가 아닙니다.");
  }
  const receiptBytes = await readFile(receiptPath);
  if (sha256(receiptBytes) !== reviewManifest.launchReceiptSha256) {
    throw new Error("독립 검수 launch receipt SHA가 manifest 결속과 다릅니다.");
  }
  const receipt = normalizeAnalysisLaunchReceipt(parseJson(receiptBytes, "launch receipt"));
  if (
    receipt.manifestSha256 !== reviewManifest.launchManifestSha256
    || receipt.grantSha256 !== reviewManifest.launchGrantSha256
  ) {
    throw new Error("독립 검수 launch receipt가 원본 manifest/grant와 다릅니다.");
  }

  const packetBySequence = new Map(reviewManifest.packets.map((packet) => [packet.sequence, packet]));
  const heldBySequence = new Map(aggregate.heldAudit.map((item) => [item.sequence, item]));
  const findingsBySequence = new Map<number, Record<string, unknown>[]>();
  for (const finding of aggregate.consensus.defects) {
    const sequence = Number(finding.sequence);
    const findings = findingsBySequence.get(sequence) ?? [];
    findings.push(finding);
    findingsBySequence.set(sequence, findings);
  }
  const sourceTargetBySequence = new Map(sourceManifest.targets.map((target) => [target.sequence, target]));
  const receiptTargetBySequence = new Map(receipt.targets.map((target) => [target.sequence, target]));
  const repairTargets: IndependentReviewRepairTargetPreparation[] = [];
  for (const originalSequence of originalSequences) {
    const packetEntry = packetBySequence.get(originalSequence);
    const sourceTarget = sourceTargetBySequence.get(originalSequence);
    const receiptTarget = receiptTargetBySequence.get(originalSequence);
    if (
      !sourceTarget
      || !receiptTarget
      || receiptTarget.grantId !== sourceTarget.grantId
      || receiptTarget.runArtifactPath === null
      || receiptTarget.runArtifactSha256 === null
    ) {
      throw new Error(`원본 sequence ${originalSequence}의 launch 결속이 없습니다.`);
    }
    if (receiptTarget.status === "publishable") {
      if (!packetEntry || packetEntry.grantId !== sourceTarget.grantId) {
        throw new Error(`원본 sequence ${originalSequence}의 publishable review packet이 없습니다.`);
      }
      const packetBytes = await readFile(resolveInside(
        repositoryRoot,
        resolve(repositoryRoot, packetEntry.path),
        `sequence ${originalSequence} packet`,
      ));
      if (sha256(packetBytes) !== packetEntry.sha256) {
        throw new Error(`원본 sequence ${originalSequence} packet SHA가 다릅니다.`);
      }
      const packet = object(parseJson(packetBytes, "packet"), "packet");
      if (
        packet.schema !== (
          reviewManifest.schema === INDEPENDENT_REVIEW_MANIFEST_SCHEMA
            ? INDEPENDENT_REVIEW_PACKET_SCHEMA
            : "independent-ai-review-packet-v1"
        )
        || packet.sequence !== originalSequence
        || packet.grantId !== sourceTarget.grantId
        || packet.runId !== packetEntry.runId
        || packet.launchReceiptSha256 !== reviewManifest.launchReceiptSha256
        || packet.launchManifestSha256 !== reviewManifest.launchManifestSha256
        || packet.runArtifactPath !== receiptTarget.runArtifactPath
        || packet.runArtifactSha256 !== receiptTarget.runArtifactSha256
        || packet.inputSha256 !== sourceTarget.inputSha256
      ) {
        throw new Error(`원본 sequence ${originalSequence} packet 결속이 다릅니다.`);
      }
    } else {
      const held = heldBySequence.get(originalSequence);
      if (
        !held
        || held.grantId !== sourceTarget.grantId
        || held.status !== receiptTarget.status
        || held.runArtifactPath !== receiptTarget.runArtifactPath
        || held.runArtifactSha256 !== receiptTarget.runArtifactSha256
      ) {
        throw new Error(`원본 sequence ${originalSequence} non-publishable audit 결속이 다릅니다.`);
      }
    }
    const runBytes = await readFile(resolveInside(
      repositoryRoot,
      resolve(repositoryRoot, receiptTarget.runArtifactPath),
      `sequence ${originalSequence} run`,
    ));
    if (sha256(runBytes) !== receiptTarget.runArtifactSha256) {
      throw new Error(`원본 sequence ${originalSequence} run SHA가 다릅니다.`);
    }
    const run = parseJson(runBytes, "run") as LabRun;
    if (
      run.grantId !== sourceTarget.grantId
      || run.inputSha256 !== sourceTarget.inputSha256
      || run.attachmentManifestSha256 !== sourceTarget.attachmentManifestSha256
    ) {
      throw new Error(`원본 sequence ${originalSequence} run/input 결속이 다릅니다.`);
    }
    if (packetEntry && receiptTarget.status === "publishable" && run.runId !== packetEntry.runId) {
      throw new Error(`원본 sequence ${originalSequence} runId가 review packet과 다릅니다.`);
    }
    const findings = findingsBySequence.get(originalSequence) ?? [];
    const priorRepair = sourceTarget.reviewRepair ?? null;
    const reviewRepair = findings.length > 0
      ? Object.freeze({
          sourceRunId: run.runId,
          reviewModel: aggregate.reviewerModel,
          blockingCount: findings.length + (priorRepair?.blockingCount ?? 0),
          taskInstruction: buildIndependentReviewRepairInstruction({
            aggregateSha256,
            findings,
            ...(priorRepair ? { priorTaskInstruction: priorRepair.taskInstruction } : {}),
          }),
        })
      : null;
    const roundtripRunId = reviewRepair && independentReviewFindingsMatchSourceRun(
      aggregate,
      originalSequence,
      run,
    )
      ? completeApplicationRoundtripRunId(run)
      : null;
    const roundtripArtifacts = roundtripRunId
      ? await readExactRoundtripRunArtifacts({
          grantId: sourceTarget.grantId,
          runId: roundtripRunId,
          repositoryRoot,
        })
      : null;
    const applicationRoundtripReuse = roundtripArtifacts
      ? Object.freeze({
          schema: "analysis-launch-application-roundtrip-reuse-v1" as const,
          sourceSequence: originalSequence,
          sourceLabRunId: run.runId,
          sourceLabRunArtifactPath: receiptTarget.runArtifactPath,
          sourceLabRunArtifactSha256: receiptTarget.runArtifactSha256,
          sourceRoundtripRunId: roundtripRunId!,
          analysisArtifactSha256: roundtripArtifacts.analysisSha256,
          manifestArtifactSha256: roundtripArtifacts.manifestSha256,
          parsedMarkdown: roundtripArtifacts.parsedMarkdown,
          independentReviewAggregatePath: relative(repositoryRoot, aggregatePath).split(sep).join("/"),
          independentReviewAggregateSha256: aggregateSha256,
          independentReviewManifestPath: relative(repositoryRoot, reviewManifestPath).split(sep).join("/"),
          independentReviewManifestSha256: aggregate.manifestSha256,
          sourceLaunchReceiptSha256: reviewManifest.launchReceiptSha256,
        }) satisfies AnalysisLaunchApplicationRoundtripReuseBinding
      : null;
    repairTargets.push(Object.freeze({
      originalSequence,
      grantId: sourceTarget.grantId,
      source: requireString(run.source, "run.source"),
      inputSha256: sourceTarget.inputSha256,
      attachmentManifestSha256: sourceTarget.attachmentManifestSha256,
      reviewRepair,
      applicationRoundtripReuse,
    }));
  }

  const preparedTargets = await mapWithConcurrency(
    repairTargets,
    concurrency,
    async (target) => {
      const prepared = await prepareLabAnalysis(target.grantId);
      return Object.freeze({
        grantId: prepared.grant.id,
        inputSha256: prepared.input.inputSha256,
        attachmentManifestSha256: prepared.input.attachmentManifestSha256,
        currentSources: prepared.currentSources,
      });
    },
  );
  const driftedIndexes = new Set(findDriftedIndependentReviewRepairTargetIndexes(
    repairTargets,
    preparedTargets,
  ));
  const stableRepairTargets = repairTargets.filter((_, index) => !driftedIndexes.has(index));
  const stablePreparedTargets = preparedTargets.filter((_, index) => !driftedIndexes.has(index));
  const excludedDriftedOriginalSequences = repairTargets
    .filter((_, index) => driftedIndexes.has(index))
    .map((target) => target.originalSequence);
  if (stableRepairTargets.length === 0) {
    throw new Error(
      `독립 검수 repair target이 모두 현재 입력/첨부와 달라졌습니다: ${excludedDriftedOriginalSequences.join(",")}`,
    );
  }
  const exactRepairTargets = await Promise.all(stableRepairTargets.map(async (target, index) => {
    const candidate = target.applicationRoundtripReuse;
    if (!candidate) return target;
    try {
      await prepareApplicationRoundtripReuse({
        grantId: target.grantId,
        sourceRunId: candidate.sourceRoundtripRunId,
        transport: "claude-cli",
        model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
        currentSources: [...stablePreparedTargets[index]!.currentSources],
        exactArtifactBinding: {
          analysisSha256: candidate.analysisArtifactSha256,
          manifestSha256: candidate.manifestArtifactSha256,
          parsedMarkdown: candidate.parsedMarkdown,
        },
        repositoryRoot,
      });
      return target;
    } catch (error) {
      if (!(error instanceof ApplicationRoundtripReuseError)) throw error;
      return Object.freeze({ ...target, applicationRoundtripReuse: null });
    }
  }));
  const manifest = createIndependentReviewRepairAnalysisLaunchManifest({
    aggregateSha256,
    targets: exactRepairTargets,
    preparedTargets: stablePreparedTargets,
    provenance,
    concurrency,
    now: input.preparedAt ?? new Date(),
  });
  const stored = await writeAnalysisLaunchArtifact("manifests", manifest, repositoryRoot);
  return Object.freeze({
    manifest,
    manifestSha256: stored.sha256,
    path: stored.path,
    aggregateSha256,
    originalSequences: Object.freeze(stableRepairTargets.map((target) => target.originalSequence)),
    excludedDriftedOriginalSequences: Object.freeze(excludedDriftedOriginalSequences),
  });
}

/** live launch가 exact reuse를 쓰기 직전 독립 검수 및 원 LabRun bytes를 다시 대조한다. */
export async function verifyIndependentReviewApplicationRoundtripReuseBinding(input: {
  readonly manifest: AnalysisLaunchManifest;
  readonly target: AnalysisLaunchManifest["targets"][number];
  readonly repositoryRoot: string;
}): Promise<void> {
  const binding = input.target.applicationRoundtripReuse;
  if (!binding) return;
  if (
    input.manifest.source.kind !== "independent_review_repair"
    || !input.target.reviewRepair
    || input.target.reviewRepair.sourceRunId !== binding.sourceLabRunId
    || input.manifest.source.planSha256 !== binding.independentReviewAggregateSha256
  ) {
    throw new Error("Kordoc exact 재사용이 독립 검수 primary repair와 결속되지 않았습니다.");
  }
  const aggregateBytes = await readBoundRepositoryFile({
    repositoryRoot: input.repositoryRoot,
    path: binding.independentReviewAggregatePath,
    expectedSha256: binding.independentReviewAggregateSha256,
    label: "독립 검수 aggregate",
  });
  const aggregate = normalizeIndependentReviewRepairAggregate(
    parseJson(aggregateBytes, "독립 검수 aggregate"),
  );
  const reviewManifestBytes = await readBoundRepositoryFile({
    repositoryRoot: input.repositoryRoot,
    path: binding.independentReviewManifestPath,
    expectedSha256: binding.independentReviewManifestSha256,
    label: "독립 검수 manifest",
  });
  const reviewManifest = normalizeReviewManifest(
    parseJson(reviewManifestBytes, "독립 검수 manifest"),
  );
  if (
    aggregate.manifestSha256 !== binding.independentReviewManifestSha256
    || aggregate.launchReceiptSha256 !== binding.sourceLaunchReceiptSha256
    || reviewManifest.launchReceiptSha256 !== binding.sourceLaunchReceiptSha256
  ) {
    throw new Error("Kordoc exact 재사용의 독립 검수 manifest/aggregate 결속이 다릅니다.");
  }
  if (
    resolve(input.repositoryRoot, reviewManifest.launchReceiptPath)
      !== analysisLaunchArtifactPath(
        "receipts",
        binding.sourceLaunchReceiptSha256,
        input.repositoryRoot,
      )
    || new Set(reviewManifest.packets.map((packet) => packet.sequence)).size
      !== reviewManifest.packets.length
  ) {
    throw new Error("Kordoc exact 재사용의 receipt 경로 또는 packet sequence가 잘못됐습니다.");
  }
  if (
    basename(binding.independentReviewAggregatePath)
      !== `${binding.independentReviewAggregateSha256}.aggregate.json`
    || basename(binding.independentReviewManifestPath)
      !== `${binding.independentReviewManifestSha256}.manifest.json`
  ) {
    throw new Error("Kordoc exact 재사용의 독립 검수 artifact 파일명이 SHA와 다릅니다.");
  }
  const sourceSequence = binding.sourceSequence;
  const reviewPacket = reviewManifest.packets.find(
    (packet) => packet.sequence === sourceSequence,
  );
  if (
    !independentReviewFindingsArePrimaryOnly(aggregate, sourceSequence)
    || !reviewPacket
    || reviewPacket.grantId !== input.target.grantId
    || reviewPacket.runId !== binding.sourceLabRunId
  ) {
    throw new Error("Kordoc exact 재사용 대상이 검수된 primary 결함 packet과 다릅니다.");
  }
  const expectedReviewManifestPath = resolveIndependentReviewManifestPath(
    resolve(input.repositoryRoot, binding.independentReviewAggregatePath),
    binding.independentReviewManifestSha256,
  );
  if (
    resolve(input.repositoryRoot, binding.independentReviewManifestPath)
      !== expectedReviewManifestPath
  ) {
    throw new Error("Kordoc exact 재사용의 독립 검수 manifest 경로가 정본과 다릅니다.");
  }
  const packetBytes = await readBoundRepositoryFile({
    repositoryRoot: input.repositoryRoot,
    path: reviewPacket.path,
    expectedSha256: reviewPacket.sha256,
    label: "독립 검수 packet",
  });
  const packet = object(parseJson(packetBytes, "독립 검수 packet"), "독립 검수 packet");
  if (
    packet.schema !== (
      reviewManifest.schema === INDEPENDENT_REVIEW_MANIFEST_SCHEMA
        ? INDEPENDENT_REVIEW_PACKET_SCHEMA
        : "independent-ai-review-packet-v1"
    )
    || packet.sequence !== sourceSequence
    || packet.grantId !== input.target.grantId
    || packet.runId !== binding.sourceLabRunId
    || packet.launchReceiptSha256 !== binding.sourceLaunchReceiptSha256
    || packet.runArtifactPath !== binding.sourceLabRunArtifactPath
    || packet.runArtifactSha256 !== binding.sourceLabRunArtifactSha256
    || packet.inputSha256 !== input.target.inputSha256
  ) {
    throw new Error("Kordoc exact 재사용의 독립 검수 packet 내용 결속이 다릅니다.");
  }
  const receipt = normalizeAnalysisLaunchReceipt(await readAnalysisLaunchArtifact(
    "receipts",
    binding.sourceLaunchReceiptSha256,
    input.repositoryRoot,
  ));
  if (
    receipt.grantSha256 !== reviewManifest.launchGrantSha256
    || receipt.manifestSha256 !== reviewManifest.launchManifestSha256
  ) {
    throw new Error("Kordoc exact 재사용의 원 launch receipt 결속이 다릅니다.");
  }
  const sourceReceiptTarget = receipt.targets.find(
    (target) => target.sequence === sourceSequence,
  );
  if (
    !sourceReceiptTarget
    || sourceReceiptTarget.grantId !== input.target.grantId
    || sourceReceiptTarget.status !== "publishable"
    || sourceReceiptTarget.runArtifactPath !== binding.sourceLabRunArtifactPath
    || sourceReceiptTarget.runArtifactSha256 !== binding.sourceLabRunArtifactSha256
  ) {
    throw new Error("Kordoc exact 재사용의 원 LabRun receipt 결속이 다릅니다.");
  }
  const runBytes = await readBoundRepositoryFile({
    repositoryRoot: input.repositoryRoot,
    path: binding.sourceLabRunArtifactPath,
    expectedSha256: binding.sourceLabRunArtifactSha256,
    label: "원 LabRun",
  });
  const run = parseJson(runBytes, "원 LabRun") as LabRun;
  if (
    run.runId !== binding.sourceLabRunId
    || run.grantId !== input.target.grantId
    || run.inputSha256 !== input.target.inputSha256
    || run.attachmentManifestSha256 !== input.target.attachmentManifestSha256
    || run.applicationRoundtrip?.runId !== binding.sourceRoundtripRunId
  ) {
    throw new Error("Kordoc exact 재사용의 원 LabRun 내용 결속이 다릅니다.");
  }
  if (
    completeApplicationRoundtripRunId(run) !== binding.sourceRoundtripRunId
    || !independentReviewFindingsMatchSourceRun(aggregate, sourceSequence, run)
  ) {
    throw new Error("Kordoc exact 재사용의 primary finding 또는 application 완결성이 다릅니다.");
  }
}

export function independentReviewFindingsArePrimaryOnly(
  aggregate: ReturnType<typeof normalizeIndependentReviewRepairAggregate>,
  sequence: number,
): boolean {
  if (aggregate.consensus.unresolvedTargets.includes(sequence)) return false;
  const findings = aggregate.consensus.defects.filter(
    (finding) => finding.sequence === sequence,
  );
  return findings.length > 0 && findings.every((finding) => {
    if (finding.kind === "criterion") {
      return (finding.verdict === "needs_edit" || finding.verdict === "wrong")
        && typeof finding.key === "number"
        && Number.isSafeInteger(finding.key)
        && finding.key >= 0;
    }
    if (finding.kind === "axis") {
      return finding.verdict === "missed_condition"
        && typeof finding.key === "string"
        && (CRITERION_DIMENSIONS as readonly string[]).includes(finding.key);
    }
    return false;
  });
}

export function independentReviewFindingsMatchSourceRun(
  aggregate: ReturnType<typeof normalizeIndependentReviewRepairAggregate>,
  sequence: number,
  run: Pick<LabRun, "criteria" | "axisAssessments">,
): boolean {
  if (!independentReviewFindingsArePrimaryOnly(aggregate, sequence)) return false;
  const axisDimensions = new Set<string>(run.axisAssessments.map((axis) => axis.dimension));
  return aggregate.consensus.defects
    .filter((finding) => finding.sequence === sequence)
    .every((finding) => (
      finding.kind === "criterion"
        ? typeof finding.key === "number" && finding.key < run.criteria.length
        : typeof finding.key === "string" && axisDimensions.has(finding.key)
    ));
}

function completeApplicationRoundtripRunId(run: LabRun): string | null {
  const reference = run.applicationRoundtrip;
  if (
    reference?.status !== "complete"
    || typeof reference.runId !== "string"
    || reference.runId.trim() === ""
    || reference.transport !== "claude-cli"
    || reference.model !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
    || reference.errorCode !== null
    || reference.error !== null
    || reference.documentCount < 1
    || reference.sourceCount < 1
    || (reference.applicationDocumentCount ?? 0) < 1
    || (reference.fieldReadyDocumentCount ?? 0) < 1
    || (reference.recognizedFieldCount ?? 0) < 1
    || (reference.remainingUnresolvedCandidateCount ?? 0) !== 0
    || reference.adjudicationStatus === "partial"
    || reference.adjudicationStatus === "failed"
  ) {
    return null;
  }
  return reference.runId;
}

async function readBoundRepositoryFile(input: {
  readonly repositoryRoot: string;
  readonly path: string;
  readonly expectedSha256: string;
  readonly label: string;
}): Promise<Buffer> {
  const repositoryRoot = await realpath(input.repositoryRoot);
  const candidate = resolveInside(
    repositoryRoot,
    resolve(repositoryRoot, input.path),
    input.label,
  );
  const exactPath = await realpath(candidate);
  resolveInside(repositoryRoot, exactPath, input.label);
  const bytes = await readFile(exactPath);
  if (sha256(bytes) !== input.expectedSha256) {
    throw new Error(`${input.label} SHA가 봉인값과 다릅니다.`);
  }
  return bytes;
}

function normalizeReviewManifest(value: unknown): ReviewManifest {
  const manifest = object(value, "review manifest");
  if (
    (
      manifest.schema !== INDEPENDENT_REVIEW_MANIFEST_SCHEMA
      && manifest.schema !== LEGACY_INDEPENDENT_REVIEW_MANIFEST_SCHEMA
    )
    || typeof manifest.launchReceiptPath !== "string"
    || !Array.isArray(manifest.packets)
  ) {
    throw new Error("독립 검수 manifest 형식이 아닙니다.");
  }
  return {
    schema: manifest.schema,
    launchReceiptPath: requireString(manifest.launchReceiptPath, "launchReceiptPath"),
    launchReceiptSha256: sha(manifest.launchReceiptSha256, "launchReceiptSha256"),
    launchManifestSha256: sha(manifest.launchManifestSha256, "launchManifestSha256"),
    launchGrantSha256: sha(manifest.launchGrantSha256, "launchGrantSha256"),
    packets: manifest.packets.map((raw, index) => {
      const packet = object(raw, `packets[${index}]`);
      return {
        sequence: nonNegativeInteger(packet.sequence, `packets[${index}].sequence`),
        grantId: requireString(packet.grantId, `packets[${index}].grantId`),
        runId: requireString(packet.runId, `packets[${index}].runId`),
        path: requireString(packet.path, `packets[${index}].path`),
        sha256: sha(packet.sha256, `packets[${index}].sha256`),
      };
    }),
  };
}

function resolveInside(root: string, path: string, label: string): string {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  const relation = relative(normalizedRoot, normalizedPath);
  if (relation === ".." || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new Error(`${label} 경로가 허용된 루트 밖입니다.`);
  }
  return normalizedPath;
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label}가 JSON이 아닙니다.`);
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}가 객체가 아닙니다.`);
  }
  return value as Record<string, unknown>;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}가 0 이상의 정수가 아닙니다.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}가 비어 있습니다.`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  const text = requireString(value, label);
  if (!SHA256.test(text)) throw new Error(`${label}가 SHA-256이 아닙니다.`);
  return text;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function normalizeConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4) {
    throw new Error("독립 검수 합의 결함 재분석 concurrency는 1~4 정수여야 합니다.");
  }
  return value;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await map(values[index]!);
    }
  }));
  return results;
}
