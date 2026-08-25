import { createHash } from "node:crypto";
import type {
  AuthoringGuideAdoptionDisposition,
  AuthoringGuideAdoptionManifest,
  AuthoringGuideAdoptionManifestItem,
} from "./authoring-guide-adoption";

export const AUTHORING_GUIDE_SOURCE_RECOVERY_SCHEMA =
  "authoring-guide-source-recovery-manifest-v1" as const;
export const AUTHORING_GUIDE_SOURCE_RECOVERY_GENERATOR_VERSION =
  "authoring-guide-source-recovery-prepare-v1" as const;

export type AuthoringGuideSourceRecoveryAction =
  | "archive_refetch"
  | "conversion_retry";

export type AuthoringGuideSourceRecoveryNextAction =
  | "reclassify_adoption"
  | "prepare_rerun_manifest";

export interface AuthoringGuideSourceRecoveryRuntimeReadiness {
  readonly r2Configured: boolean;
  readonly conversionServerConfigured: boolean;
  readonly conversionSharedSecretConfigured: boolean;
}

export interface AuthoringGuideSourceRecoveryTarget {
  readonly sequence: number;
  readonly grantId: string;
  readonly source: "kstartup" | "bizinfo";
  readonly sourceId: string;
  readonly title: string;
  readonly adoptionDisposition: Extract<
    AuthoringGuideAdoptionDisposition,
    "source_recovery_required" | "rerun_required"
  >;
  readonly nextActionAfterRecovery: AuthoringGuideSourceRecoveryNextAction;
  readonly current: {
    readonly sourceRevisionSha256: string;
    readonly operationalInputSha256: string;
    readonly operationalAttachmentManifestSha256: string;
  };
  readonly recoveryActions: readonly AuthoringGuideSourceRecoveryAction[];
  readonly blockers: readonly {
    readonly code: "blocked_fetch" | "blocked_conversion";
    readonly attachmentId: string | null;
    readonly message: string;
  }[];
  readonly blockersSha256: string;
  readonly targetSha256: string;
}

export interface AuthoringGuideSourceRecoveryManifest {
  readonly schema: typeof AUTHORING_GUIDE_SOURCE_RECOVERY_SCHEMA;
  readonly preparedAt: string;
  readonly source: {
    readonly adoptionManifestSha256: string;
    readonly adoptionAsOfKst: string;
    readonly adoptionPreparedAt: string;
  };
  readonly generatorVersion: typeof AUTHORING_GUIDE_SOURCE_RECOVERY_GENERATOR_VERSION;
  readonly execution: {
    readonly mode: "prepare_only";
    readonly maxRounds: 3;
    readonly maxTargetsPerSourcePerRound: 20;
    readonly archiveFetchTimeoutMs: 30_000;
    readonly archiveMaxEntries: 20;
    readonly reprocessMissingMarkdown: true;
    readonly externalLlmCallsAuthorized: false;
    readonly analysisJobsAuthorized: false;
    readonly databaseWritesAuthorized: false;
    readonly objectStorageWritesAuthorized: false;
    readonly liveExecutionAuthorized: false;
    readonly readyForExactWriteGrant: boolean;
  };
  readonly runtimeReadiness: AuthoringGuideSourceRecoveryRuntimeReadiness;
  readonly summary: {
    readonly targetCount: number;
    readonly targetsBySource: Readonly<Record<"kstartup" | "bizinfo", number>>;
    readonly blockerCount: number;
    readonly blockersByCode: Readonly<Record<"blocked_fetch" | "blocked_conversion", number>>;
    readonly reclassifyAfterRecovery: number;
    readonly prepareRerunAfterRecovery: number;
  };
  readonly targets: readonly AuthoringGuideSourceRecoveryTarget[];
}

export function createAuthoringGuideSourceRecoveryManifest(input: {
  readonly adoptionManifestSha256: string;
  readonly adoptionManifest: AuthoringGuideAdoptionManifest;
  readonly runtimeReadiness: AuthoringGuideSourceRecoveryRuntimeReadiness;
  readonly preparedAt: Date;
}): AuthoringGuideSourceRecoveryManifest {
  requireSha(input.adoptionManifestSha256, "adoptionManifestSha256");
  assertAdoptionManifestSource(input.adoptionManifest);
  const preparedAt = input.preparedAt.toISOString();
  if (!Number.isFinite(Date.parse(preparedAt))) throw new Error("preparedAt이 잘못됐습니다.");

  const blockedItems = input.adoptionManifest.items
    .filter((item) => item.reasons.includes("current_source_unsealed"))
    .sort((left, right) => left.grantId.localeCompare(right.grantId, "en"));
  if (blockedItems.length === 0) {
    throw new Error("source recovery 대상이 없습니다.");
  }
  const targets = blockedItems.map((item, sequence) => recoveryTarget(item, sequence));
  if (new Set(targets.map((target) => target.grantId)).size !== targets.length) {
    throw new Error("source recovery target grantId가 중복됐습니다.");
  }
  const readyForExactWriteGrant = Object.values(input.runtimeReadiness).every(Boolean);

  return Object.freeze({
    schema: AUTHORING_GUIDE_SOURCE_RECOVERY_SCHEMA,
    preparedAt,
    source: Object.freeze({
      adoptionManifestSha256: input.adoptionManifestSha256,
      adoptionAsOfKst: input.adoptionManifest.asOfKst,
      adoptionPreparedAt: input.adoptionManifest.preparedAt,
    }),
    generatorVersion: AUTHORING_GUIDE_SOURCE_RECOVERY_GENERATOR_VERSION,
    execution: Object.freeze({
      mode: "prepare_only",
      maxRounds: 3,
      maxTargetsPerSourcePerRound: 20,
      archiveFetchTimeoutMs: 30_000,
      archiveMaxEntries: 20,
      reprocessMissingMarkdown: true,
      externalLlmCallsAuthorized: false,
      analysisJobsAuthorized: false,
      databaseWritesAuthorized: false,
      objectStorageWritesAuthorized: false,
      liveExecutionAuthorized: false,
      readyForExactWriteGrant,
    }),
    runtimeReadiness: Object.freeze({ ...input.runtimeReadiness }),
    summary: Object.freeze({
      targetCount: targets.length,
      targetsBySource: Object.freeze({
        kstartup: targets.filter((target) => target.source === "kstartup").length,
        bizinfo: targets.filter((target) => target.source === "bizinfo").length,
      }),
      blockerCount: targets.reduce((total, target) => total + target.blockers.length, 0),
      blockersByCode: Object.freeze({
        blocked_fetch: targets.reduce(
          (total, target) => total + target.blockers.filter((blocker) => blocker.code === "blocked_fetch").length,
          0,
        ),
        blocked_conversion: targets.reduce(
          (total, target) => total + target.blockers.filter(
            (blocker) => blocker.code === "blocked_conversion",
          ).length,
          0,
        ),
      }),
      reclassifyAfterRecovery: targets.filter(
        (target) => target.nextActionAfterRecovery === "reclassify_adoption",
      ).length,
      prepareRerunAfterRecovery: targets.filter(
        (target) => target.nextActionAfterRecovery === "prepare_rerun_manifest",
      ).length,
    }),
    targets: Object.freeze(targets),
  });
}

export function encodeAuthoringGuideSourceRecoveryManifest(
  manifest: AuthoringGuideSourceRecoveryManifest,
): Buffer {
  return Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
}

export function hashAuthoringGuideSourceRecoveryManifest(
  manifest: AuthoringGuideSourceRecoveryManifest,
): string {
  return createHash("sha256").update(encodeAuthoringGuideSourceRecoveryManifest(manifest)).digest("hex");
}

function recoveryTarget(
  item: AuthoringGuideAdoptionManifestItem,
  sequence: number,
): AuthoringGuideSourceRecoveryTarget {
  if (item.source !== "kstartup" && item.source !== "bizinfo") {
    throw new Error(`지원하지 않는 source recovery source입니다: ${item.source}`);
  }
  if (
    item.disposition !== "source_recovery_required"
    && item.disposition !== "rerun_required"
  ) {
    throw new Error(`source recovery disposition이 잘못됐습니다: ${item.grantId}`);
  }
  if (item.current.sourceSealed || item.current.sourceBlockers.length === 0) {
    throw new Error(`source recovery blocker 결속이 잘못됐습니다: ${item.grantId}`);
  }
  requireSha(item.current.sourceRevisionSha256, `${item.grantId}.sourceRevisionSha256`);
  requireSha(item.current.operationalInputSha256, `${item.grantId}.operationalInputSha256`);
  requireSha(
    item.current.operationalAttachmentManifestSha256,
    `${item.grantId}.operationalAttachmentManifestSha256`,
  );
  const blockers = item.current.sourceBlockers.map((blocker) => {
    if (blocker.code !== "blocked_fetch" && blocker.code !== "blocked_conversion") {
      throw new Error(`자동 복구를 지원하지 않는 blocker입니다: ${item.grantId}:${blocker.code}`);
    }
    return Object.freeze({
      code: blocker.code,
      attachmentId: blocker.attachmentId,
      message: blocker.message,
    });
  }).sort((left, right) => (
    `${left.code}:${left.attachmentId ?? ""}:${left.message}`.localeCompare(
      `${right.code}:${right.attachmentId ?? ""}:${right.message}`,
      "en",
    )
  ));
  const blockersSha256 = sha256Canonical(blockers);
  const material = {
    sequence,
    grantId: item.grantId,
    source: item.source,
    sourceId: item.sourceId,
    adoptionDisposition: item.disposition,
    sourceRevisionSha256: item.current.sourceRevisionSha256,
    operationalInputSha256: item.current.operationalInputSha256,
    operationalAttachmentManifestSha256: item.current.operationalAttachmentManifestSha256,
    blockersSha256,
  };
  return Object.freeze({
    sequence,
    grantId: item.grantId,
    source: item.source,
    sourceId: item.sourceId,
    title: item.title,
    adoptionDisposition: item.disposition,
    nextActionAfterRecovery: item.disposition === "rerun_required"
      ? "prepare_rerun_manifest"
      : "reclassify_adoption",
    current: Object.freeze({
      sourceRevisionSha256: item.current.sourceRevisionSha256,
      operationalInputSha256: item.current.operationalInputSha256,
      operationalAttachmentManifestSha256: item.current.operationalAttachmentManifestSha256,
    }),
    recoveryActions: Object.freeze([
      ...(blockers.some((blocker) => blocker.code === "blocked_fetch")
        ? ["archive_refetch" as const]
        : []),
      ...(blockers.some((blocker) => blocker.code === "blocked_conversion")
        ? ["conversion_retry" as const]
        : []),
    ]),
    blockers: Object.freeze(blockers),
    blockersSha256,
    targetSha256: sha256Canonical(material),
  });
}

function assertAdoptionManifestSource(manifest: AuthoringGuideAdoptionManifest): void {
  if (manifest.schema !== "authoring-guide-adoption-manifest-v1") {
    throw new Error("adoption manifest schema가 잘못됐습니다.");
  }
  if (
    manifest.execution.mode !== "offline_read_only"
    || manifest.execution.modelCallsMade !== 0
    || manifest.execution.databaseWritesMade !== 0
    || manifest.execution.promotionAuthorized !== false
  ) {
    throw new Error("adoption manifest가 읽기 전용 안전 계약을 충족하지 않습니다.");
  }
}

function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
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

function requireSha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}가 SHA-256이 아닙니다.`);
  return value;
}
