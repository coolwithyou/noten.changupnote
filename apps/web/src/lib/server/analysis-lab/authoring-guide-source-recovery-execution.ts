import { createHash } from "node:crypto";
import type { AuthoringGuideAdoptionManifest } from "./authoring-guide-adoption";
import {
  assertAuthoringGuideSourceRecoveryManifest,
  type AuthoringGuideSourceRecoveryManifest,
  type AuthoringGuideSourceRecoveryTarget,
} from "./authoring-guide-source-recovery";

export const AUTHORING_GUIDE_SOURCE_RECOVERY_GRANT_SCHEMA =
  "authoring-guide-source-recovery-grant-v1" as const;
export const AUTHORING_GUIDE_SOURCE_RECOVERY_RECEIPT_SCHEMA =
  "authoring-guide-source-recovery-receipt-v1" as const;

export interface AuthoringGuideSourceRecoveryGrant {
  readonly schema: typeof AUTHORING_GUIDE_SOURCE_RECOVERY_GRANT_SCHEMA;
  readonly manifestSha256: string;
  readonly approvedBy: string;
  readonly approvedAt: string;
  readonly scope: "source-recovery-write";
  readonly stopAfter: "receipt-and-reclassification";
  readonly targetCount: number;
  readonly maxRounds: 3;
  readonly externalLlmCallsAuthorized: false;
  readonly analysisJobsAuthorized: false;
  readonly promotionAuthorized: false;
}

export interface AuthoringGuideSourceRecoveryRoundTargetResult {
  readonly grantId: string;
  readonly source: "kstartup" | "bizinfo";
  readonly sourceId: string;
  readonly sealed: boolean;
  readonly blockerCodes: readonly string[];
  readonly blockerCount: number;
  readonly sourceRevisionSha256: string | null;
  readonly analysisJobId: string | null;
  readonly analysisJobStatus: string | null;
  readonly error: string | null;
}

export interface AuthoringGuideSourceRecoveryRoundResult {
  readonly targets: readonly AuthoringGuideSourceRecoveryRoundTargetResult[];
  readonly metrics: {
    readonly archivedCandidateCount: number;
    readonly selectedAttachmentCount: number;
    readonly archiveSucceededCount: number;
    readonly archiveFailedCount: number;
    readonly conversionCandidateAttachmentCount: number;
    readonly conversionJobsEnqueued: number;
    readonly conversionCacheHits: number;
    readonly conversionFailedCount: number;
    readonly conversionStillPendingCount: number;
    readonly pdfRecoveryCandidateCount: number;
    readonly pdfRecoverySucceededCount: number;
    readonly pdfRecoveryFailedCount: number;
    readonly deadlineReached: boolean;
    readonly budgetExhausted: boolean;
    readonly elapsedMs: number;
  };
}

export interface AuthoringGuideSourceRecoveryRoundReceipt {
  readonly round: number;
  readonly targetCount: number;
  readonly targetsBySource: Readonly<Record<"kstartup" | "bizinfo", number>>;
  readonly sealedCount: number;
  readonly unresolvedCount: number;
  readonly remainingTargetCount: number;
  readonly metrics: AuthoringGuideSourceRecoveryRoundResult["metrics"];
}

export interface AuthoringGuideSourceRecoveryExecutionResult {
  readonly rounds: readonly AuthoringGuideSourceRecoveryRoundReceipt[];
  readonly targets: readonly {
    readonly sequence: number;
    readonly grantId: string;
    readonly status: "recovered" | "unresolved";
    readonly sourceRevisionSha256: string | null;
    readonly blockerCodes: readonly string[];
    readonly blockerCount: number;
    readonly error: string | null;
  }[];
  readonly recoveredTargetCount: number;
  readonly remainingTargetCount: number;
}

export interface AuthoringGuideSourceRecoveryReceipt {
  readonly schema: typeof AUTHORING_GUIDE_SOURCE_RECOVERY_RECEIPT_SCHEMA;
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly lifecycle: "finished";
  readonly stopReason: "completed" | "partial";
  readonly summary: {
    readonly initialTargetCount: number;
    readonly recoveredTargetCount: number;
    readonly remainingTargetCount: number;
    readonly executedRoundCount: number;
    readonly externalLlmCalls: 0;
    readonly analysisJobsEnqueued: 0;
    readonly databaseWriteMode: true;
    readonly objectStorageWriteMode: true;
    readonly promotionAuthorized: false;
  };
  readonly rounds: readonly AuthoringGuideSourceRecoveryRoundReceipt[];
  readonly targets: readonly {
    readonly sequence: number;
    readonly grantId: string;
    readonly status: "recovered" | "unresolved";
    readonly sourceRevisionSha256: string | null;
    readonly blockerCodes: readonly string[];
    readonly blockerCount: number;
    readonly error: string | null;
    readonly postRecoveryDisposition: string | null;
    readonly postRecoverySourceSealed: boolean | null;
  }[];
  readonly reclassification: {
    readonly adoptionManifestSha256: string;
    readonly adoptionManifestPath: string;
    readonly asOfKst: string;
    readonly summary: AuthoringGuideAdoptionManifest["summary"];
  };
}

export function createAuthoringGuideSourceRecoveryGrant(input: {
  readonly manifestSha256: string;
  readonly manifest: AuthoringGuideSourceRecoveryManifest;
  readonly approvedBy: string;
  readonly approvedAt: Date;
}): AuthoringGuideSourceRecoveryGrant {
  assertAuthoringGuideSourceRecoveryManifest(input.manifest);
  return normalizeAuthoringGuideSourceRecoveryGrant({
    schema: AUTHORING_GUIDE_SOURCE_RECOVERY_GRANT_SCHEMA,
    manifestSha256: input.manifestSha256,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt.toISOString(),
    scope: "source-recovery-write",
    stopAfter: "receipt-and-reclassification",
    targetCount: input.manifest.targets.length,
    maxRounds: 3,
    externalLlmCallsAuthorized: false,
    analysisJobsAuthorized: false,
    promotionAuthorized: false,
  });
}

export function normalizeAuthoringGuideSourceRecoveryGrant(
  value: unknown,
): AuthoringGuideSourceRecoveryGrant {
  const record = object(value, "source recovery grant");
  if (
    record.schema !== AUTHORING_GUIDE_SOURCE_RECOVERY_GRANT_SCHEMA
    || record.scope !== "source-recovery-write"
    || record.stopAfter !== "receipt-and-reclassification"
    || record.maxRounds !== 3
    || record.externalLlmCallsAuthorized !== false
    || record.analysisJobsAuthorized !== false
    || record.promotionAuthorized !== false
  ) {
    throw new Error("source recovery grant 계약이 잘못됐습니다.");
  }
  const targetCount = integer(record.targetCount, "targetCount");
  if (targetCount < 1 || targetCount > 100) {
    throw new Error("source recovery grant targetCount가 잘못됐습니다.");
  }
  return Object.freeze({
    schema: AUTHORING_GUIDE_SOURCE_RECOVERY_GRANT_SCHEMA,
    manifestSha256: exactSha(record.manifestSha256, "manifestSha256"),
    approvedBy: nonEmpty(record.approvedBy, "approvedBy"),
    approvedAt: exactIso(record.approvedAt, "approvedAt"),
    scope: "source-recovery-write",
    stopAfter: "receipt-and-reclassification",
    targetCount,
    maxRounds: 3,
    externalLlmCallsAuthorized: false,
    analysisJobsAuthorized: false,
    promotionAuthorized: false,
  });
}

export async function runAuthoringGuideSourceRecoveryRounds(input: {
  readonly manifest: AuthoringGuideSourceRecoveryManifest;
  readonly signal: AbortSignal;
  readonly runRound: (
    targets: readonly AuthoringGuideSourceRecoveryTarget[],
    round: number,
  ) => Promise<AuthoringGuideSourceRecoveryRoundResult>;
  readonly onRound?: (round: AuthoringGuideSourceRecoveryRoundReceipt) => void;
}): Promise<AuthoringGuideSourceRecoveryExecutionResult> {
  const manifest = assertAuthoringGuideSourceRecoveryManifest(input.manifest);
  let remaining = [...manifest.targets];
  const finalByGrant = new Map<string, AuthoringGuideSourceRecoveryRoundTargetResult>();
  const rounds: AuthoringGuideSourceRecoveryRoundReceipt[] = [];

  for (let round = 1; round <= manifest.execution.maxRounds && remaining.length > 0; round += 1) {
    throwIfAborted(input.signal);
    const selected = selectAuthoringGuideSourceRecoveryRound(
      remaining,
      manifest.execution.maxTargetsPerSourcePerRound,
    );
    const selectedIds = new Set(selected.map((target) => target.grantId));
    const unprocessed = remaining.filter((target) => !selectedIds.has(target.grantId));
    const result = await input.runRound(selected, round);
    throwIfAborted(input.signal);
    assertRoundResult(selected, result);
    const resultByGrant = new Map(result.targets.map((target) => [target.grantId, target]));
    for (const target of result.targets) finalByGrant.set(target.grantId, target);
    const unresolved = selected.filter((target) => !resultByGrant.get(target.grantId)?.sealed);
    remaining = [...unprocessed, ...unresolved];
    const receipt = Object.freeze({
      round,
      targetCount: selected.length,
      targetsBySource: Object.freeze({
        kstartup: selected.filter((target) => target.source === "kstartup").length,
        bizinfo: selected.filter((target) => target.source === "bizinfo").length,
      }),
      sealedCount: result.targets.filter((target) => target.sealed).length,
      unresolvedCount: result.targets.filter((target) => !target.sealed).length,
      remainingTargetCount: remaining.length,
      metrics: Object.freeze({ ...result.metrics }),
    });
    rounds.push(receipt);
    input.onRound?.(receipt);
  }

  const remainingIds = new Set(remaining.map((target) => target.grantId));
  const targets = manifest.targets.map((target) => {
    const latest = finalByGrant.get(target.grantId);
    return Object.freeze({
      sequence: target.sequence,
      grantId: target.grantId,
      status: remainingIds.has(target.grantId) ? "unresolved" as const : "recovered" as const,
      sourceRevisionSha256: latest?.sourceRevisionSha256 ?? null,
      blockerCodes: Object.freeze([...(latest?.blockerCodes ?? target.blockers.map((blocker) => blocker.code))]),
      blockerCount: latest?.blockerCount ?? target.blockers.length,
      error: latest?.error ?? null,
    });
  });
  return Object.freeze({
    rounds: Object.freeze(rounds),
    targets: Object.freeze(targets),
    recoveredTargetCount: targets.filter((target) => target.status === "recovered").length,
    remainingTargetCount: targets.filter((target) => target.status === "unresolved").length,
  });
}

export function selectAuthoringGuideSourceRecoveryRound(
  targets: readonly AuthoringGuideSourceRecoveryTarget[],
  maxPerSource: number,
): AuthoringGuideSourceRecoveryTarget[] {
  if (!Number.isSafeInteger(maxPerSource) || maxPerSource < 1 || maxPerSource > 20) {
    throw new Error("source recovery round source별 상한이 잘못됐습니다.");
  }
  return (["kstartup", "bizinfo"] as const).flatMap((source) => (
    targets.filter((target) => target.source === source).slice(0, maxPerSource)
  )).sort((left, right) => left.sequence - right.sequence);
}

export function createAuthoringGuideSourceRecoveryReceipt(input: {
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly manifest: AuthoringGuideSourceRecoveryManifest;
  readonly execution: AuthoringGuideSourceRecoveryExecutionResult;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly adoptionManifest: AuthoringGuideAdoptionManifest;
  readonly adoptionArtifact: { readonly sha256: string; readonly path: string };
}): AuthoringGuideSourceRecoveryReceipt {
  exactSha(input.grantSha256, "grantSha256");
  exactSha(input.manifestSha256, "manifestSha256");
  exactSha(input.adoptionArtifact.sha256, "adoptionManifestSha256");
  assertAuthoringGuideSourceRecoveryManifest(input.manifest);
  const postByGrant = new Map(input.adoptionManifest.items.map((item) => [item.grantId, item]));
  const targets = input.execution.targets.map((target) => {
    const post = postByGrant.get(target.grantId);
    return Object.freeze({
      ...target,
      postRecoveryDisposition: post?.disposition ?? null,
      postRecoverySourceSealed: post?.current.sourceSealed ?? null,
    });
  });
  return Object.freeze({
    schema: AUTHORING_GUIDE_SOURCE_RECOVERY_RECEIPT_SCHEMA,
    grantSha256: input.grantSha256,
    manifestSha256: input.manifestSha256,
    startedAt: exactIso(input.startedAt.toISOString(), "startedAt"),
    finishedAt: exactIso(input.finishedAt.toISOString(), "finishedAt"),
    lifecycle: "finished",
    stopReason: input.execution.remainingTargetCount === 0 ? "completed" : "partial",
    summary: Object.freeze({
      initialTargetCount: input.manifest.targets.length,
      recoveredTargetCount: input.execution.recoveredTargetCount,
      remainingTargetCount: input.execution.remainingTargetCount,
      executedRoundCount: input.execution.rounds.length,
      externalLlmCalls: 0,
      analysisJobsEnqueued: 0,
      databaseWriteMode: true,
      objectStorageWriteMode: true,
      promotionAuthorized: false,
    }),
    rounds: Object.freeze([...input.execution.rounds]),
    targets: Object.freeze(targets),
    reclassification: Object.freeze({
      adoptionManifestSha256: input.adoptionArtifact.sha256,
      adoptionManifestPath: input.adoptionArtifact.path,
      asOfKst: input.adoptionManifest.asOfKst,
      summary: Object.freeze({ ...input.adoptionManifest.summary }),
    }),
  });
}

export function encodeAuthoringGuideSourceRecoveryExecutionArtifact(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

export function hashAuthoringGuideSourceRecoveryExecutionArtifact(value: unknown): string {
  return createHash("sha256")
    .update(encodeAuthoringGuideSourceRecoveryExecutionArtifact(value))
    .digest("hex");
}

function assertRoundResult(
  selected: readonly AuthoringGuideSourceRecoveryTarget[],
  result: AuthoringGuideSourceRecoveryRoundResult,
): void {
  if (result.targets.length !== selected.length) {
    throw new Error("source recovery round 결과 target 수가 다릅니다.");
  }
  const selectedByGrant = new Map(selected.map((target) => [target.grantId, target]));
  if (new Set(result.targets.map((target) => target.grantId)).size !== result.targets.length) {
    throw new Error("source recovery round 결과 grantId가 중복됐습니다.");
  }
  for (const target of result.targets) {
    const expected = selectedByGrant.get(target.grantId);
    if (!expected || expected.source !== target.source || expected.sourceId !== target.sourceId) {
      throw new Error(`source recovery round 결과 exact target이 다릅니다: ${target.grantId}`);
    }
    if (target.analysisJobId !== null || target.analysisJobStatus !== null) {
      throw new Error(`source recovery가 분석 job을 생성했습니다: ${target.grantId}`);
    }
  }
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}는 object여야 합니다.`);
  }
  return value as Record<string, unknown>;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label}는 정수여야 합니다.`);
  return value as number;
}

function exactSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label}가 SHA-256이 아닙니다.`);
  }
  return value;
}

function nonEmpty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label}가 비어 있습니다.`);
  }
  return value.trim();
}

function exactIso(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label}가 ISO 시각이 아닙니다.`);
  }
  if (new Date(value).toISOString() !== value) throw new Error(`${label}가 canonical ISO 시각이 아닙니다.`);
  return value;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
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
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON에 지원하지 않는 값이 있습니다: ${typeof value}`);
}
