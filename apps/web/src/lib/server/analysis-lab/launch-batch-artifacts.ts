import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ANALYSIS_LAB_PROMPT_VERSION } from "@/lib/server/analysis-lab/lab-contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import { writeImmutableBytesAtomic } from "./immutable-artifact-fs";
import { findMonorepoRoot } from "./run-store";

const SHA256 = /^[a-f0-9]{64}$/;
const SERIES = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LAUNCH_TARGETS = 100;

export interface AnalysisLaunchManifestTarget {
  readonly sequence: number;
  readonly grantId: string;
  readonly stratum: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
  readonly inventoryInputSha256: string;
  readonly inventoryAttachmentManifestSha256: string;
  readonly changedSinceInventory: boolean;
}

export interface AnalysisLaunchManifest {
  readonly schema: "analysis-launch-manifest-v1";
  readonly preparedAt: string;
  readonly source: {
    readonly seriesId: string;
    readonly planSha256: string;
    readonly planArtifactSha256: string;
    readonly sequenceFrom: number;
    readonly sequenceTo: number;
  };
  readonly execution: {
    readonly transport: "claude-cli";
    readonly model: string;
    readonly promptVersion: string;
    readonly validatorVersion: string;
    readonly packageRuntimeSha256: string;
    /** 관측용이다. 승인 유지 여부는 material contract로 판정하며 전체 git SHA로 판정하지 않는다. */
    readonly gitShaAtPreparation: string;
    readonly withApplicationRoundtrip: boolean;
    readonly roundtripModel: string | null;
    readonly concurrency: number;
  };
  readonly targets: readonly AnalysisLaunchManifestTarget[];
}

export interface AnalysisLaunchGrant {
  readonly schema: "analysis-launch-grant-v1";
  readonly manifestSha256: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly scope: "launch-batch-live";
  readonly stopAfter: "manifest-terminal";
  readonly targetCount: number;
}

export interface AnalysisLaunchReceiptTarget {
  readonly sequence: number;
  readonly grantId: string;
  readonly status: "publishable" | "held" | "failed" | "skipped";
  readonly runArtifactPath: string | null;
  readonly runArtifactSha256: string | null;
  readonly applicationRoundtripStatus: string | null;
  readonly error: string | null;
}

export interface AnalysisLaunchReceipt {
  readonly schema: "analysis-launch-receipt-v1";
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lifecycle: "finished";
  readonly stopReason: "completed" | "window-exhausted" | "aborted" | "systemic-failure";
  readonly systemicFailure: string | null;
  readonly summary: {
    readonly publishable: number;
    readonly held: number;
    readonly failed: number;
    readonly skipped: number;
  };
  readonly targets: readonly AnalysisLaunchReceiptTarget[];
}

export interface AnalysisLaunchPlanTarget {
  readonly sequence: number;
  readonly grantId: string;
  readonly stratum: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
}

export interface AnalysisLaunchPlanInventory {
  readonly seriesId: string;
  readonly planSha256: string;
  readonly planArtifactSha256: string;
  readonly model: string;
  readonly targets: readonly AnalysisLaunchPlanTarget[];
}

export interface AnalysisLaunchPreparedTarget {
  readonly grantId: string;
  readonly inputSha256: string;
  readonly attachmentManifestSha256: string;
}

export function createAnalysisLaunchManifest(input: {
  readonly inventory: AnalysisLaunchPlanInventory;
  readonly sequenceFrom: number;
  readonly sequenceTo: number;
  readonly preparedTargets: readonly AnalysisLaunchPreparedTarget[];
  readonly provenance: {
    readonly gitSha: string;
    readonly packageRuntimeSha256: string;
    readonly validatorVersion: string;
  };
  readonly withApplicationRoundtrip: boolean;
  readonly roundtripModel?: string;
  readonly concurrency: number;
  readonly now: Date;
}): AnalysisLaunchManifest {
  const inventory = normalizeInventory(input.inventory);
  if (
    !Number.isSafeInteger(input.sequenceFrom)
    || !Number.isSafeInteger(input.sequenceTo)
    || input.sequenceFrom < 0
    || input.sequenceTo < input.sequenceFrom
  ) {
    throw new Error("launch sequence 범위가 잘못됐습니다.");
  }
  const selected = inventory.targets.filter(
    (target) => target.sequence >= input.sequenceFrom && target.sequence <= input.sequenceTo,
  );
  if (
    selected.length === 0
    || selected.length > MAX_LAUNCH_TARGETS
    || selected[0]?.sequence !== input.sequenceFrom
    || selected.at(-1)?.sequence !== input.sequenceTo
  ) {
    throw new Error("launch sequence 범위가 plan의 연속 target과 일치하지 않습니다.");
  }
  const preparedByGrant = new Map(input.preparedTargets.map((target) => [target.grantId, target]));
  if (preparedByGrant.size !== selected.length) {
    throw new Error("launch prepared target 수 또는 grantId가 inventory와 다릅니다.");
  }
  const targets = selected.map((target): AnalysisLaunchManifestTarget => {
    const prepared = preparedByGrant.get(target.grantId);
    if (!prepared || prepared.grantId !== target.grantId) {
      throw new Error(`launch target 준비 결과가 없습니다: ${target.grantId}`);
    }
    const inputSha256 = exactSha(prepared.inputSha256, `${target.grantId}.inputSha256`);
    const attachmentManifestSha256 = exactSha(
      prepared.attachmentManifestSha256,
      `${target.grantId}.attachmentManifestSha256`,
    );
    return Object.freeze({
      sequence: target.sequence,
      grantId: target.grantId,
      stratum: target.stratum,
      inputSha256,
      attachmentManifestSha256,
      inventoryInputSha256: target.inputSha256,
      inventoryAttachmentManifestSha256: target.attachmentManifestSha256,
      changedSinceInventory:
        inputSha256 !== target.inputSha256
        || attachmentManifestSha256 !== target.attachmentManifestSha256,
    });
  });
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1 || input.concurrency > 4) {
    throw new Error("launch concurrency는 1~4 정수여야 합니다.");
  }
  const roundtripModel = input.withApplicationRoundtrip
    ? requireNonEmpty(input.roundtripModel ?? inventory.model, "roundtripModel")
    : null;
  const preparedAt = input.now.toISOString();
  if (!Number.isFinite(Date.parse(preparedAt))) throw new Error("launch preparedAt이 잘못됐습니다.");
  return normalizeAnalysisLaunchManifest({
    schema: "analysis-launch-manifest-v1",
    preparedAt,
    source: {
      seriesId: inventory.seriesId,
      planSha256: inventory.planSha256,
      planArtifactSha256: inventory.planArtifactSha256,
      sequenceFrom: input.sequenceFrom,
      sequenceTo: input.sequenceTo,
    },
    execution: {
      transport: "claude-cli",
      model: inventory.model,
      promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
      validatorVersion: exactString(input.provenance.validatorVersion, "validatorVersion"),
      packageRuntimeSha256: exactSha(
        input.provenance.packageRuntimeSha256,
        "packageRuntimeSha256",
      ),
      gitShaAtPreparation: exactGitSha(input.provenance.gitSha),
      withApplicationRoundtrip: input.withApplicationRoundtrip,
      roundtripModel,
      concurrency: input.concurrency,
    },
    targets,
  });
}

export function createAnalysisLaunchGrant(input: {
  readonly manifestSha256: string;
  readonly targetCount: number;
  readonly approvedBy: string;
  readonly now: Date;
}): AnalysisLaunchGrant {
  return normalizeAnalysisLaunchGrant({
    schema: "analysis-launch-grant-v1",
    manifestSha256: exactSha(input.manifestSha256, "manifestSha256"),
    approvedBy: requireNonEmpty(input.approvedBy, "approvedBy"),
    approvedAt: input.now.toISOString(),
    scope: "launch-batch-live",
    stopAfter: "manifest-terminal",
    targetCount: input.targetCount,
  });
}

export function normalizeAnalysisLaunchManifest(value: unknown): AnalysisLaunchManifest {
  const record = object(value, "manifest");
  if (record.schema !== "analysis-launch-manifest-v1") throw new Error("launch manifest schema가 다릅니다.");
  const source = object(record.source, "manifest.source");
  const execution = object(record.execution, "manifest.execution");
  if (!Array.isArray(record.targets) || record.targets.length < 1 || record.targets.length > MAX_LAUNCH_TARGETS) {
    throw new Error("launch manifest targets 수가 잘못됐습니다.");
  }
  const targets = record.targets.map((raw, index): AnalysisLaunchManifestTarget => {
    const target = object(raw, `manifest.targets[${index}]`);
    const sequence = integer(target.sequence, `targets[${index}].sequence`);
    if (sequence !== integer(source.sequenceFrom, "source.sequenceFrom") + index) {
      throw new Error("launch manifest sequence가 연속적이지 않습니다.");
    }
    const inventoryInputSha256 = exactSha(String(target.inventoryInputSha256), "inventoryInputSha256");
    const inventoryAttachmentManifestSha256 = exactSha(
      String(target.inventoryAttachmentManifestSha256),
      "inventoryAttachmentManifestSha256",
    );
    const inputSha256 = exactSha(String(target.inputSha256), "inputSha256");
    const attachmentManifestSha256 = exactSha(
      String(target.attachmentManifestSha256),
      "attachmentManifestSha256",
    );
    const changedSinceInventory = target.changedSinceInventory === true;
    if (
      changedSinceInventory !== (
        inputSha256 !== inventoryInputSha256
        || attachmentManifestSha256 !== inventoryAttachmentManifestSha256
      )
    ) {
      throw new Error("launch target changedSinceInventory가 SHA 비교와 다릅니다.");
    }
    return Object.freeze({
      sequence,
      grantId: exactUuid(target.grantId, "grantId"),
      stratum: requireNonEmpty(target.stratum, "stratum"),
      inputSha256,
      attachmentManifestSha256,
      inventoryInputSha256,
      inventoryAttachmentManifestSha256,
      changedSinceInventory,
    });
  });
  if (new Set(targets.map((target) => target.grantId)).size !== targets.length) {
    throw new Error("launch manifest grantId가 중복됐습니다.");
  }
  const sequenceFrom = integer(source.sequenceFrom, "source.sequenceFrom");
  const sequenceTo = integer(source.sequenceTo, "source.sequenceTo");
  if (sequenceFrom < 0 || sequenceTo !== sequenceFrom + targets.length - 1) {
    throw new Error("launch manifest source sequence 범위가 targets와 다릅니다.");
  }
  const withApplicationRoundtrip = execution.withApplicationRoundtrip === true;
  const roundtripModel = execution.roundtripModel === null
    ? null
    : requireNonEmpty(execution.roundtripModel, "roundtripModel");
  if (withApplicationRoundtrip !== (roundtripModel !== null)) {
    throw new Error("launch manifest Kordoc/model binding이 다릅니다.");
  }
  if (execution.transport !== "claude-cli") throw new Error("launch transport는 claude-cli여야 합니다.");
  const preparedAt = exactIso(record.preparedAt, "preparedAt");
  const concurrency = integer(execution.concurrency, "concurrency");
  if (concurrency < 1 || concurrency > 4) throw new Error("launch concurrency는 1~4여야 합니다.");
  return Object.freeze({
    schema: "analysis-launch-manifest-v1",
    preparedAt,
    source: Object.freeze({
      seriesId: exactSeries(source.seriesId),
      planSha256: exactSha(String(source.planSha256), "planSha256"),
      planArtifactSha256: exactSha(String(source.planArtifactSha256), "planArtifactSha256"),
      sequenceFrom,
      sequenceTo,
    }),
    execution: Object.freeze({
      transport: "claude-cli",
      model: requireNonEmpty(execution.model, "model"),
      promptVersion: requireNonEmpty(execution.promptVersion, "promptVersion"),
      validatorVersion: requireNonEmpty(execution.validatorVersion, "validatorVersion"),
      packageRuntimeSha256: exactSha(String(execution.packageRuntimeSha256), "packageRuntimeSha256"),
      gitShaAtPreparation: exactGitSha(execution.gitShaAtPreparation),
      withApplicationRoundtrip,
      roundtripModel,
      concurrency,
    }),
    targets: Object.freeze(targets),
  });
}

export function normalizeAnalysisLaunchGrant(value: unknown): AnalysisLaunchGrant {
  const record = object(value, "grant");
  if (
    record.schema !== "analysis-launch-grant-v1"
    || record.scope !== "launch-batch-live"
    || record.stopAfter !== "manifest-terminal"
  ) {
    throw new Error("launch grant 계약이 다릅니다.");
  }
  const targetCount = integer(record.targetCount, "targetCount");
  if (targetCount < 1 || targetCount > MAX_LAUNCH_TARGETS) throw new Error("launch grant targetCount가 잘못됐습니다.");
  return Object.freeze({
    schema: "analysis-launch-grant-v1",
    manifestSha256: exactSha(String(record.manifestSha256), "manifestSha256"),
    approvedBy: requireNonEmpty(record.approvedBy, "approvedBy"),
    approvedAt: exactIso(record.approvedAt, "approvedAt"),
    scope: "launch-batch-live",
    stopAfter: "manifest-terminal",
    targetCount,
  });
}

export function assertAnalysisLaunchExecutionContract(input: {
  readonly manifest: AnalysisLaunchManifest;
  readonly current: {
    readonly packageRuntimeSha256: string;
    readonly validatorVersion: string;
    readonly gitSha: string;
  };
}): { readonly gitChangedSincePreparation: boolean } {
  if (
    input.current.packageRuntimeSha256 !== input.manifest.execution.packageRuntimeSha256
    || input.current.validatorVersion !== input.manifest.execution.validatorVersion
    || input.manifest.execution.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION
    || input.manifest.execution.validatorVersion !== DEEP_ANALYSIS_VALIDATOR_VERSION
  ) {
    throw new Error("launch material execution contract가 준비 시점과 달라졌습니다.");
  }
  return Object.freeze({
    gitChangedSincePreparation:
      input.current.gitSha !== input.manifest.execution.gitShaAtPreparation,
  });
}

export async function readCurrentSeriesPlanInventory(
  seriesId: string,
  repositoryRoot = findMonorepoRoot(),
): Promise<AnalysisLaunchPlanInventory> {
  const normalizedSeries = exactSeries(seriesId);
  const markerPath = join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "experiments",
    "series",
    `${normalizedSeries}.json`,
  );
  const markerBytes = await readFile(markerPath);
  const marker = object(JSON.parse(markerBytes.toString("utf8")), "series marker");
  if (marker.seriesId !== normalizedSeries || marker.schema !== "deep-repair-series-proposal-v1") {
    throw new Error("series marker binding이 다릅니다.");
  }
  const planSha256 = exactSha(String(marker.planSha256), "planSha256");
  const planArtifactSha256 = exactSha(String(marker.planArtifactSha256), "planArtifactSha256");
  const planPath = join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "experiments",
    "plans",
    `${planSha256}.json`,
  );
  const planBytes = await readFile(planPath);
  if (sha256Bytes(planBytes) !== planArtifactSha256) throw new Error("series plan raw SHA가 marker와 다릅니다.");
  const plan = object(JSON.parse(planBytes.toString("utf8")), "plan");
  const manifest = object(plan.manifest, "plan.manifest");
  const policy = object(manifest.policy, "plan.manifest.policy");
  if (
    plan.schema !== "deep-repair-experiment-plan-v1"
    || plan.planSha256 !== planSha256
    || manifest.seriesId !== normalizedSeries
    || policy.transport !== "claude-cli"
    || policy.promptVersion !== ANALYSIS_LAB_PROMPT_VERSION
    || !Array.isArray(plan.sequence)
  ) {
    throw new Error("series plan 계약이 launch inventory와 호환되지 않습니다.");
  }
  return normalizeInventory({
    seriesId: normalizedSeries,
    planSha256,
    planArtifactSha256,
    model: requireNonEmpty(policy.model, "plan model"),
    targets: plan.sequence.map((raw, index) => {
      const target = object(raw, `plan.sequence[${index}]`);
      return {
        sequence: target.sequence,
        grantId: target.grantId,
        stratum: target.stratum,
        inputSha256: target.inputSha256,
        attachmentManifestSha256: target.attachmentManifestSha256,
      } as AnalysisLaunchPlanTarget;
    }),
  });
}

export function analysisLaunchArtifactPath(
  kind: "manifests" | "grants" | "receipts",
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): string {
  return join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "launch",
    kind,
    `${exactSha(sha256, `${kind} sha256`)}.json`,
  );
}

export async function writeAnalysisLaunchArtifact(
  kind: "manifests" | "grants" | "receipts",
  value: AnalysisLaunchManifest | AnalysisLaunchGrant | AnalysisLaunchReceipt,
  repositoryRoot = findMonorepoRoot(),
): Promise<{ readonly sha256: string; readonly path: string }> {
  const bytes = encodeCanonical(value);
  const sha256 = sha256Bytes(bytes);
  const path = analysisLaunchArtifactPath(kind, sha256, repositoryRoot);
  await writeImmutableBytesAtomic(path, bytes);
  return Object.freeze({ sha256, path });
}

export async function readAnalysisLaunchArtifact(
  kind: "manifests" | "grants" | "receipts",
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): Promise<unknown> {
  const bytes = await readFile(analysisLaunchArtifactPath(kind, sha256, repositoryRoot));
  if (sha256Bytes(bytes) !== sha256) throw new Error(`launch ${kind} artifact SHA가 ID와 다릅니다.`);
  const value = JSON.parse(bytes.toString("utf8"));
  if (Buffer.compare(bytes, encodeCanonical(value)) !== 0) {
    throw new Error(`launch ${kind} artifact가 canonical JSON이 아닙니다.`);
  }
  return value;
}

export function encodeCanonical(value: unknown): Buffer {
  return Buffer.from(canonicalJson(value), "utf8");
}

function normalizeInventory(value: AnalysisLaunchPlanInventory): AnalysisLaunchPlanInventory {
  if (!Array.isArray(value.targets) || value.targets.length < 1 || value.targets.length > MAX_LAUNCH_TARGETS) {
    throw new Error("launch inventory target 수가 잘못됐습니다.");
  }
  const targets = value.targets.map((target, index): AnalysisLaunchPlanTarget => {
    const sequence = integer(target.sequence, `inventory.targets[${index}].sequence`);
    if (sequence !== index) throw new Error("launch inventory sequence가 0부터 연속적이지 않습니다.");
    return Object.freeze({
      sequence,
      grantId: exactUuid(target.grantId, "grantId"),
      stratum: requireNonEmpty(target.stratum, "stratum"),
      inputSha256: exactSha(target.inputSha256, "inputSha256"),
      attachmentManifestSha256: exactSha(
        target.attachmentManifestSha256,
        "attachmentManifestSha256",
      ),
    });
  });
  if (new Set(targets.map((target) => target.grantId)).size !== targets.length) {
    throw new Error("launch inventory grantId가 중복됐습니다.");
  }
  return Object.freeze({
    seriesId: exactSeries(value.seriesId),
    planSha256: exactSha(value.planSha256, "planSha256"),
    planArtifactSha256: exactSha(value.planArtifactSha256, "planArtifactSha256"),
    model: requireNonEmpty(value.model, "model"),
    targets: Object.freeze(targets),
  });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON에 유한하지 않은 숫자가 있습니다.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new Error(`canonical JSON으로 직렬화할 수 없습니다: ${typeof value}`);
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field}는 object여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function exactSha(value: string, field: string): string {
  if (!SHA256.test(value)) throw new Error(`${field}는 SHA-256이어야 합니다.`);
  return value;
}

function exactUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new Error(`${field}는 UUID여야 합니다.`);
  return value;
}

function exactSeries(value: unknown): string {
  if (typeof value !== "string" || !SERIES.test(value)) throw new Error("seriesId 형식이 잘못됐습니다.");
  return value;
}

function exactGitSha(value: unknown): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error("gitShaAtPreparation 형식이 잘못됐습니다.");
  }
  return value;
}

function exactIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${field}는 ISO timestamp여야 합니다.`);
  }
  return new Date(value).toISOString();
}

function integer(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new Error(`${field}는 정수여야 합니다.`);
  return value;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field}는 비어 있을 수 없습니다.`);
  return value;
}

function exactString(value: string, field: string): string {
  return requireNonEmpty(value, field);
}
