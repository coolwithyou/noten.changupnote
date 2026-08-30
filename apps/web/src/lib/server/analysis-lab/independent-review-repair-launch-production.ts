import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
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
  type AnalysisLaunchManifest,
} from "./launch-batch-artifacts";
import {
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
import { stableJson } from "@/lib/server/deep-analysis/sourceRevision";

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
  const repairTargets = [];
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
    const reviewRepair = findings.length > 0
      ? Object.freeze({
          sourceRunId: run.runId,
          reviewModel: aggregate.reviewerModel,
          blockingCount: findings.length,
          taskInstruction: buildIndependentReviewRepairInstruction({
            aggregateSha256,
            findings,
          }),
        })
      : null;
    repairTargets.push(Object.freeze({
      originalSequence,
      grantId: sourceTarget.grantId,
      source: requireString(run.source, "run.source"),
      inputSha256: sourceTarget.inputSha256,
      attachmentManifestSha256: sourceTarget.attachmentManifestSha256,
      reviewRepair,
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
      });
    },
  );
  const manifest = createIndependentReviewRepairAnalysisLaunchManifest({
    aggregateSha256,
    targets: repairTargets,
    preparedTargets,
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
    originalSequences,
  });
}

function buildIndependentReviewRepairInstruction(input: {
  aggregateSha256: string;
  findings: readonly Record<string, unknown>[];
}): string {
  return [
    "아래 공고 입력을 22축 전체에 대해 처음부터 다시 분석하라.",
    "Codex 독립 검수가 원문과 직전 결과를 대조해 아래 결함을 확정했다.",
    "각 finding의 원문 인용과 수정 이유를 직접 다시 확인하고, note뿐 아니라 실제 criterion value·operator·축 상태에 반영하라.",
    "삭제 지시는 해당 criterion을 만들지 말고, OR 관계·예외·경계값은 원문 의미를 손실 없이 보존하라.",
    "지적된 결함 외의 22축과 프로그램 의도를 생략하거나 원문 밖 사실을 추가하지 마라.",
    `independent_review_aggregate_sha256=${input.aggregateSha256}`,
    "<<<VERIFIED_CODEX_REVIEW_FINDINGS>>>",
    stableJson(input.findings),
    "<<<END_VERIFIED_CODEX_REVIEW_FINDINGS>>>",
  ].join("\n");
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
