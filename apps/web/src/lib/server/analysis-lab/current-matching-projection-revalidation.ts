import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { LabPrimaryMatchingProjectionSnapshot, LabRun } from "./lab-contract";
import {
  buildAnalysisLaunchMatchingProjectionBinding,
  capturePrimaryMatchingProjectionSnapshot,
  inspectPrimaryMatchingProjectionSnapshot,
  primaryMatchingProjectionSnapshotSha256,
  primaryProjectionSource,
  type PrimaryMatchingProjectionInspection,
} from "./primary-matching-projection";
import {
  encodeCanonical,
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  readAnalysisLaunchArtifact,
  type AnalysisLaunchMatchingProjectionBinding,
  type AnalysisLaunchManifestTarget,
  type AnalysisLaunchReceiptTarget,
} from "./launch-batch-artifacts";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import { isPublishableLabRun } from "./run-outcome";

const SHA256 = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const CURRENT_MATCHING_PROJECTION_REVALIDATION_SCHEMA =
  "analysis-current-matching-projection-revalidation-v1" as const;
export const CURRENT_MATCHING_PROJECTION_SOURCE_EVIDENCE_SCHEMA =
  "analysis-current-matching-projection-source-evidence-v1" as const;

/**
 * 읽기 전용 외부 조회자가 넘긴 현행 관측 snapshot이다. 이 모듈은 이 값의 DB 최신성을
 * 확인하지 않으며, 원 run 결속과 형식만 검증한다.
 */
export interface CurrentMatchingProjectionSourceEvidence {
  readonly schema: typeof CURRENT_MATCHING_PROJECTION_SOURCE_EVIDENCE_SCHEMA;
  readonly observedAt: string;
  readonly grantId: string;
  readonly runId: string;
  readonly source: string;
  readonly sourceId: string;
  readonly sourceRevisionSha256: string;
  readonly sourceRawSha256: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
  readonly status: string;
  readonly servingState: string;
  readonly applicationOpen: boolean;
  readonly hasDeepAnalysisRun: boolean;
  readonly hasPromotionItem: boolean;
  readonly confirmedDuplicate: boolean;
}

export interface CurrentMatchingProjectionRevalidationRequest {
  readonly repositoryRoot: string;
  readonly launchReceiptSha256: string;
  readonly sequence: number;
  readonly grantId: string;
  readonly runId: string;
  readonly currentEvidence: CurrentMatchingProjectionSourceEvidence;
}

export interface CurrentMatchingProjectionRevalidationArtifact {
  readonly schema: typeof CURRENT_MATCHING_PROJECTION_REVALIDATION_SCHEMA;
  readonly authority: {
    readonly mode: "offline_diagnostic";
    readonly diagnosticOnly: true;
    readonly currentEvidenceOrigin: "caller_supplied_snapshot";
    readonly projectionInputOrigin: "immutable_original_run";
    readonly liveCurrentStateVerified: false;
    readonly serviceDatabaseReadPerformed: false;
    readonly serviceDatabaseWritesMade: 0;
    readonly modelCallsMade: 0;
    readonly originalArtifactsModified: false;
    readonly independentReviewPerformed: false;
    readonly promotionAuthorized: false;
    readonly launchAuthorized: false;
    readonly finalReleaseRequiresLiveCurrentEvidenceRecheck: true;
  };
  readonly original: {
    readonly launchReceiptSha256: string;
    readonly launchManifestSha256: string;
    readonly launchGrantSha256: string;
    readonly sequence: number;
    readonly grantId: string;
    readonly targetStatus: AnalysisLaunchReceiptTarget["status"];
    readonly runId: string;
    readonly runArtifactPath: string;
    readonly runArtifactSha256: string;
    readonly source: string;
    readonly sourceId: string;
    readonly inputSha256: string;
    readonly attachmentManifestSha256: string;
    readonly sourceRevisionSha256: string | null;
  };
  readonly currentEvidence: CurrentMatchingProjectionSourceEvidence;
  readonly currentEvidenceSha256: string;
  readonly currentEvidenceComparison: {
    readonly exactRunBindingVerified: true;
    readonly sourceRevision: "same" | "changed" | "historical_missing";
  };
  readonly historicalProjection: {
    readonly snapshot: LabPrimaryMatchingProjectionSnapshot | null;
    readonly snapshotSha256: string | null;
    readonly inspection: PrimaryMatchingProjectionInspection;
    readonly receiptBinding: AnalysisLaunchMatchingProjectionBinding | null;
    readonly receiptBindingInspection: PrimaryMatchingProjectionInspection;
  };
  readonly currentProjection: {
    readonly snapshot: LabPrimaryMatchingProjectionSnapshot;
    readonly snapshotSha256: string;
    readonly inspection: PrimaryMatchingProjectionInspection;
  };
}

export interface StoredCurrentMatchingProjectionRevalidation {
  readonly artifact: CurrentMatchingProjectionRevalidationArtifact;
  readonly artifactSha256: string;
  readonly path: string;
}

export async function sealCurrentMatchingProjectionRevalidation(
  request: CurrentMatchingProjectionRevalidationRequest,
): Promise<StoredCurrentMatchingProjectionRevalidation> {
  const normalized = normalizeRequest(request);
  const artifact = await buildExpectedArtifact(normalized);
  const bytes = encodeCanonical(artifact);
  const artifactSha256 = sha256(bytes);
  const path = currentMatchingProjectionRevalidationPath(
    artifactSha256,
    normalized.repositoryRoot,
  );
  await writeImmutableBytesAtomic(path, bytes);

  return verifyCurrentMatchingProjectionRevalidation({
    ...normalized,
    artifactSha256,
  });
}

export async function verifyCurrentMatchingProjectionRevalidation(
  request: CurrentMatchingProjectionRevalidationRequest & { readonly artifactSha256: string },
): Promise<StoredCurrentMatchingProjectionRevalidation> {
  const normalized = normalizeRequest(request);
  const artifactSha256 = exactSha(request.artifactSha256, "artifactSha256");
  const path = currentMatchingProjectionRevalidationPath(
    artifactSha256,
    normalized.repositoryRoot,
  );
  const bytes = await readFile(path);
  if (sha256(bytes) !== artifactSha256) {
    throw new Error("current matching projection sidecar raw SHA가 ID와 다릅니다.");
  }
  const parsed = JSON.parse(bytes.toString("utf8")) as unknown;
  if (Buffer.compare(bytes, encodeCanonical(parsed)) !== 0) {
    throw new Error("current matching projection sidecar가 canonical JSON이 아닙니다.");
  }
  const expected = await buildExpectedArtifact(normalized);
  const expectedBytes = encodeCanonical(expected);
  if (Buffer.compare(bytes, expectedBytes) !== 0) {
    throw new Error(
      "current matching projection sidecar가 original/current evidence 또는 현행 runtime과 다릅니다.",
    );
  }
  return Object.freeze({
    artifact: parsed as CurrentMatchingProjectionRevalidationArtifact,
    artifactSha256,
    path,
  });
}

export function currentMatchingProjectionRevalidationPath(
  artifactSha256: string,
  repositoryRoot: string,
): string {
  return join(
    resolve(repositoryRoot),
    "spike-out",
    "analysis-lab",
    "diagnostics",
    "current-matching-projection-revalidation",
    `${exactSha(artifactSha256, "artifactSha256")}.json`,
  );
}

async function buildExpectedArtifact(
  request: CurrentMatchingProjectionRevalidationRequest,
): Promise<CurrentMatchingProjectionRevalidationArtifact> {
  const loaded = await loadOriginal(request);
  const source = primaryProjectionSource({
    runId: loaded.run.runId,
    grantId: loaded.run.grantId,
    source: loaded.run.source,
    sourceId: loaded.run.sourceId,
    inputSha256: loaded.run.inputSha256,
    attachmentManifestSha256: loaded.run.attachmentManifestSha256!,
    criteria: loaded.run.criteria,
  });
  const historicalSnapshot = loaded.run.primaryMatchingProjection ?? null;
  const historicalInspection = inspectPrimaryMatchingProjectionSnapshot(
    source,
    historicalSnapshot,
  );
  const currentSnapshot = capturePrimaryMatchingProjectionSnapshot({
    source,
    primaryExtractionAvailable: isPublishableLabRun(loaded.run),
  });
  const currentInspection = inspectPrimaryMatchingProjectionSnapshot(source, currentSnapshot);
  const currentEvidenceSha256 = sha256(encodeCanonical(request.currentEvidence));

  return Object.freeze({
    schema: CURRENT_MATCHING_PROJECTION_REVALIDATION_SCHEMA,
    authority: Object.freeze({
      mode: "offline_diagnostic",
      diagnosticOnly: true,
      currentEvidenceOrigin: "caller_supplied_snapshot",
      projectionInputOrigin: "immutable_original_run",
      liveCurrentStateVerified: false,
      serviceDatabaseReadPerformed: false,
      serviceDatabaseWritesMade: 0,
      modelCallsMade: 0,
      originalArtifactsModified: false,
      independentReviewPerformed: false,
      promotionAuthorized: false,
      launchAuthorized: false,
      finalReleaseRequiresLiveCurrentEvidenceRecheck: true,
    }),
    original: Object.freeze({
      launchReceiptSha256: request.launchReceiptSha256,
      launchManifestSha256: loaded.receiptManifestSha256,
      launchGrantSha256: loaded.receiptGrantSha256,
      sequence: request.sequence,
      grantId: request.grantId,
      targetStatus: loaded.receiptTarget.status,
      runId: request.runId,
      runArtifactPath: loaded.runArtifactPath,
      runArtifactSha256: loaded.runArtifactSha256,
      source: loaded.run.source,
      sourceId: loaded.run.sourceId,
      inputSha256: loaded.run.inputSha256,
      attachmentManifestSha256: loaded.run.attachmentManifestSha256!,
      sourceRevisionSha256: loaded.run.sourceRevisionSha256 ?? null,
    }),
    currentEvidence: request.currentEvidence,
    currentEvidenceSha256,
    currentEvidenceComparison: Object.freeze({
      exactRunBindingVerified: true,
      sourceRevision: loaded.run.sourceRevisionSha256 === undefined
        ? "historical_missing"
        : loaded.run.sourceRevisionSha256 === request.currentEvidence.sourceRevisionSha256
          ? "same"
          : "changed",
    }),
    historicalProjection: Object.freeze({
      snapshot: historicalSnapshot,
      snapshotSha256: historicalSnapshot
        ? primaryMatchingProjectionSnapshotSha256(historicalSnapshot)
        : null,
      inspection: historicalInspection,
      receiptBinding: loaded.receiptTarget.primaryMatchingProjection ?? null,
      receiptBindingInspection: inspectHistoricalReceiptBinding(
        historicalSnapshot,
        loaded.receiptTarget.primaryMatchingProjection,
      ),
    }),
    currentProjection: Object.freeze({
      snapshot: currentSnapshot,
      snapshotSha256: primaryMatchingProjectionSnapshotSha256(currentSnapshot),
      inspection: currentInspection,
    }),
  });
}

async function loadOriginal(request: CurrentMatchingProjectionRevalidationRequest): Promise<{
  readonly receiptManifestSha256: string;
  readonly receiptGrantSha256: string;
  readonly receiptTarget: AnalysisLaunchReceiptTarget;
  readonly runArtifactPath: string;
  readonly runArtifactSha256: string;
  readonly run: LabRun;
}> {
  const receipt = normalizeAnalysisLaunchReceipt(await readAnalysisLaunchArtifact(
    "receipts",
    request.launchReceiptSha256,
    request.repositoryRoot,
  ));
  const manifest = normalizeAnalysisLaunchManifest(await readAnalysisLaunchArtifact(
    "manifests",
    receipt.manifestSha256,
    request.repositoryRoot,
  ));
  const grant = normalizeAnalysisLaunchGrant(await readAnalysisLaunchArtifact(
    "grants",
    receipt.grantSha256,
    request.repositoryRoot,
  ));

  if (
    grant.manifestSha256 !== receipt.manifestSha256
    || grant.targetCount !== manifest.targets.length
    || receipt.targets.length !== manifest.targets.length
  ) {
    throw new Error("launch receipt/manifest/grant target 결속이 다릅니다.");
  }
  assertReceiptManifestTargetsMatch(receipt.targets, manifest.targets);
  const receiptTarget = exactlyOneTarget(receipt.targets, request.sequence, "receipt");
  const manifestTarget = exactlyOneTarget(manifest.targets, request.sequence, "manifest");
  if (
    receiptTarget.grantId !== request.grantId
    || manifestTarget.grantId !== request.grantId
  ) {
    throw new Error("launch target grantId가 요청한 exact binding과 다릅니다.");
  }
  if (!receiptTarget.runArtifactPath || !receiptTarget.runArtifactSha256) {
    throw new Error("launch target에 원 run artifact 결속이 없습니다.");
  }

  const runPath = safeAnalysisLabArtifactPath(
    request.repositoryRoot,
    receiptTarget.runArtifactPath,
  );
  const runBytes = await readFile(runPath);
  if (sha256(runBytes) !== receiptTarget.runArtifactSha256) {
    throw new Error("원 run artifact raw SHA가 launch receipt와 다릅니다.");
  }
  const run = parseBoundRun(runBytes);
  if (
    run.runId !== request.runId
    || run.grantId !== request.grantId
    || run.grantId !== manifestTarget.grantId
    || run.inputSha256 !== manifestTarget.inputSha256
    || run.attachmentManifestSha256 !== manifestTarget.attachmentManifestSha256
    || run.model !== manifest.execution.model
    || run.promptVersion !== manifest.execution.promptVersion
    || run.transport !== manifest.execution.transport
  ) {
    throw new Error("원 run/manifest/request exact binding이 다릅니다.");
  }
  assertCurrentEvidenceBinding(request.currentEvidence, run);

  return Object.freeze({
    receiptManifestSha256: receipt.manifestSha256,
    receiptGrantSha256: receipt.grantSha256,
    receiptTarget,
    runArtifactPath: relative(resolve(request.repositoryRoot), runPath).split(sep).join("/"),
    runArtifactSha256: receiptTarget.runArtifactSha256,
    run,
  });
}

function normalizeRequest(
  request: CurrentMatchingProjectionRevalidationRequest,
): CurrentMatchingProjectionRevalidationRequest {
  const repositoryRoot = requireNonEmpty(request.repositoryRoot, "repositoryRoot");
  const sequence = exactSequence(request.sequence);
  const launchReceiptSha256 = exactSha(request.launchReceiptSha256, "launchReceiptSha256");
  const grantId = exactUuid(request.grantId, "grantId");
  const runId = requireNonEmpty(request.runId, "runId");
  const currentEvidence = normalizeCurrentEvidence(request.currentEvidence);
  return Object.freeze({
    repositoryRoot: resolve(repositoryRoot),
    launchReceiptSha256,
    sequence,
    grantId,
    runId,
    currentEvidence,
  });
}

function normalizeCurrentEvidence(
  value: CurrentMatchingProjectionSourceEvidence,
): CurrentMatchingProjectionSourceEvidence {
  const record = object(value, "currentEvidence");
  if (record.schema !== CURRENT_MATCHING_PROJECTION_SOURCE_EVIDENCE_SCHEMA) {
    throw new Error("currentEvidence schema가 다릅니다.");
  }
  return Object.freeze({
    schema: CURRENT_MATCHING_PROJECTION_SOURCE_EVIDENCE_SCHEMA,
    observedAt: exactIso(record.observedAt, "currentEvidence.observedAt"),
    grantId: exactUuid(record.grantId, "currentEvidence.grantId"),
    runId: requireNonEmpty(record.runId, "currentEvidence.runId"),
    source: requireNonEmpty(record.source, "currentEvidence.source"),
    sourceId: requireNonEmpty(record.sourceId, "currentEvidence.sourceId"),
    sourceRevisionSha256: exactSha(
      record.sourceRevisionSha256,
      "currentEvidence.sourceRevisionSha256",
    ),
    sourceRawSha256: exactSha(record.sourceRawSha256, "currentEvidence.sourceRawSha256"),
    inputSha256: exactSha(record.inputSha256, "currentEvidence.inputSha256"),
    attachmentManifestSha256: exactSha(
      record.attachmentManifestSha256,
      "currentEvidence.attachmentManifestSha256",
    ),
    status: requireNonEmpty(record.status, "currentEvidence.status"),
    servingState: requireNonEmpty(record.servingState, "currentEvidence.servingState"),
    applicationOpen: exactBoolean(record.applicationOpen, "currentEvidence.applicationOpen"),
    hasDeepAnalysisRun: exactBoolean(
      record.hasDeepAnalysisRun,
      "currentEvidence.hasDeepAnalysisRun",
    ),
    hasPromotionItem: exactBoolean(record.hasPromotionItem, "currentEvidence.hasPromotionItem"),
    confirmedDuplicate: exactBoolean(
      record.confirmedDuplicate,
      "currentEvidence.confirmedDuplicate",
    ),
  });
}

function parseBoundRun(bytes: Buffer): LabRun {
  const parsed = object(JSON.parse(bytes.toString("utf8")), "run");
  requireNonEmpty(parsed.runId, "run.runId");
  exactUuid(parsed.grantId, "run.grantId");
  requireNonEmpty(parsed.source, "run.source");
  requireNonEmpty(parsed.sourceId, "run.sourceId");
  requireNonEmpty(parsed.model, "run.model");
  requireNonEmpty(parsed.promptVersion, "run.promptVersion");
  exactSha(parsed.inputSha256, "run.inputSha256");
  exactSha(parsed.attachmentManifestSha256, "run.attachmentManifestSha256");
  if (parsed.sourceRevisionSha256 !== undefined) {
    exactSha(parsed.sourceRevisionSha256, "run.sourceRevisionSha256");
  }
  if (!Array.isArray(parsed.criteria)) throw new Error("run.criteria가 배열이 아닙니다.");
  return parsed as unknown as LabRun;
}

function assertCurrentEvidenceBinding(
  evidence: CurrentMatchingProjectionSourceEvidence,
  run: LabRun,
): void {
  if (
    evidence.grantId !== run.grantId
    || evidence.runId !== run.runId
    || evidence.source !== run.source
    || evidence.sourceId !== run.sourceId
    || evidence.inputSha256 !== run.inputSha256
    || evidence.attachmentManifestSha256 !== run.attachmentManifestSha256
  ) {
    throw new Error("caller-supplied current evidence가 원 run exact binding과 다릅니다.");
  }
}

function assertReceiptManifestTargetsMatch(
  receiptTargets: readonly AnalysisLaunchReceiptTarget[],
  manifestTargets: readonly AnalysisLaunchManifestTarget[],
): void {
  const receiptSequences = new Set<number>();
  for (const receiptTarget of receiptTargets) {
    if (receiptSequences.has(receiptTarget.sequence)) {
      throw new Error("launch receipt sequence가 중복됐습니다.");
    }
    receiptSequences.add(receiptTarget.sequence);
    const manifestTarget = manifestTargets.find((target) => target.sequence === receiptTarget.sequence);
    if (!manifestTarget || manifestTarget.grantId !== receiptTarget.grantId) {
      throw new Error("launch receipt target이 manifest exact target과 다릅니다.");
    }
  }
}

function exactlyOneTarget<T extends { readonly sequence: number }>(
  targets: readonly T[],
  sequence: number,
  label: string,
): T {
  const matched = targets.filter((target) => target.sequence === sequence);
  if (matched.length !== 1) throw new Error(`${label} exact sequence target이 하나가 아닙니다.`);
  return matched[0]!;
}

function inspectHistoricalReceiptBinding(
  snapshot: LabPrimaryMatchingProjectionSnapshot | null,
  binding: AnalysisLaunchMatchingProjectionBinding | undefined,
): PrimaryMatchingProjectionInspection {
  if (!snapshot && !binding) {
    return { status: "unverified", issues: ["matching_projection_receipt_binding_missing"] };
  }
  if (!snapshot) {
    return { status: "mismatch", issues: ["matching_projection_run_snapshot_missing"] };
  }
  if (!binding) {
    return { status: "mismatch", issues: ["matching_projection_receipt_binding_missing"] };
  }
  const expected = buildAnalysisLaunchMatchingProjectionBinding(snapshot);
  if (!matchingProjectionBindingsEqual(binding, expected)) {
    return { status: "mismatch", issues: ["matching_projection_receipt_binding_mismatch"] };
  }
  return binding.verification === "verified"
    ? { status: "verified", issues: [] }
    : { status: "failed", issues: ["matching_projection_receipt_binding_failed"] };
}

function matchingProjectionBindingsEqual(
  left: AnalysisLaunchMatchingProjectionBinding,
  right: AnalysisLaunchMatchingProjectionBinding,
): boolean {
  return left.schema === right.schema
    && left.verification === right.verification
    && left.snapshotSha256 === right.snapshotSha256
    && left.sourceCriteriaSha256 === right.sourceCriteriaSha256
    && left.projectedCriteriaSha256 === right.projectedCriteriaSha256
    && left.reportSha256 === right.reportSha256
    && left.conversionContractVersion === right.conversionContractVersion
    && left.converterVersion === right.converterVersion
    && left.normalizerContractVersion === right.normalizerContractVersion
    && left.matcherRulesetVersion === right.matcherRulesetVersion;
}

function safeAnalysisLabArtifactPath(repositoryRoot: string, artifactPath: string): string {
  const allowedRoot = resolve(repositoryRoot, "spike-out", "analysis-lab");
  const absolute = resolve(repositoryRoot, artifactPath);
  const relativePath = relative(allowedRoot, absolute);
  if (
    relativePath === ""
    || relativePath.startsWith(`..${sep}`)
    || relativePath === ".."
    || isAbsolute(relativePath)
  ) {
    throw new Error(`run artifact가 analysis-lab root 밖을 가리킵니다: ${artifactPath}`);
  }
  return absolute;
}

function exactSequence(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("sequence는 0 이상 정수여야 합니다.");
  }
  return value;
}

function exactSha(value: unknown, field: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${field}는 SHA-256이어야 합니다.`);
  }
  return value;
}

function exactUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new Error(`${field}는 UUID여야 합니다.`);
  }
  return value;
}

function exactIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field}는 ISO timestamp여야 합니다.`);
  }
  return new Date(value).toISOString();
}

function exactBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${field}는 boolean이어야 합니다.`);
  return value;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field}는 비어 있을 수 없습니다.`);
  }
  return value;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field}는 object여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
