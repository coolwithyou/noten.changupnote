import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { getCunoteDb } from "@/lib/server/db/client";
import {
  resolveDeepAnalysisInputPreparationPolicy,
  runDeepAnalysisInputPreparation,
  type DeepAnalysisInputPreparationResult,
  type DeepAnalysisInputPreparationTarget,
} from "@/lib/server/deep-analysis/inputPreparation";
import { readDeepAnalysisRuntimeAdmissionSnapshot } from "@/lib/server/deep-analysis/runtimeControl";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  prepareCurrentAuthoringGuideAdoption,
  writeAuthoringGuideAdoptionManifest,
} from "./authoring-guide-adoption-production";
import {
  createAuthoringGuideSourceRecoveryGrant,
  createAuthoringGuideSourceRecoveryReceipt,
  encodeAuthoringGuideSourceRecoveryExecutionArtifact,
  hashAuthoringGuideSourceRecoveryExecutionArtifact,
  normalizeAuthoringGuideSourceRecoveryGrant,
  runAuthoringGuideSourceRecoveryRounds,
  type AuthoringGuideSourceRecoveryGrant,
  type AuthoringGuideSourceRecoveryReceipt,
  type AuthoringGuideSourceRecoveryRoundResult,
} from "./authoring-guide-source-recovery-execution";
import {
  hashAuthoringGuideSourceRecoveryBlockers,
  type AuthoringGuideSourceRecoveryManifest,
} from "./authoring-guide-source-recovery";
import {
  readAuthoringGuideSourceRecoveryManifest,
} from "./authoring-guide-source-recovery-production";
import { createDeepRepairLiveDbLeaseClient } from "./deep-repair-live-db-runtime";
import { createDeepRepairLiveRuntimeAuthority } from "./deep-repair-live-runtime";
import {
  claimImmutableBytesAtomic,
  writeImmutableBytesAtomic,
} from "./immutable-artifact-fs";
import { findMonorepoRoot } from "./run-store";

const SHA256 = /^[a-f0-9]{64}$/u;

export async function approveAuthoringGuideSourceRecovery(input: {
  readonly manifestSha256: string;
  readonly approvedBy: string;
  readonly approvedAt?: Date;
  readonly repositoryRoot?: string;
}): Promise<{ readonly grantSha256: string; readonly path: string }> {
  const repositoryRoot = input.repositoryRoot ?? findMonorepoRoot();
  const manifest = await readAuthoringGuideSourceRecoveryManifest(
    input.manifestSha256,
    repositoryRoot,
  );
  const grant = createAuthoringGuideSourceRecoveryGrant({
    manifestSha256: input.manifestSha256,
    manifest,
    approvedBy: input.approvedBy,
    approvedAt: input.approvedAt ?? new Date(),
  });
  const artifact = await writeAuthoringGuideSourceRecoveryExecutionArtifact(
    "grants",
    grant,
    repositoryRoot,
  );
  return Object.freeze({ grantSha256: artifact.sha256, path: artifact.path });
}

export interface ApprovedAuthoringGuideSourceRecoveryResult {
  readonly receipt: AuthoringGuideSourceRecoveryReceipt;
  readonly receiptSha256: string;
  readonly receiptPath: string;
}

/**
 * exact grant의 29건만 하나의 runtime lease 안에서 source refetch/conversion한다.
 * 모델·딥분석 queue·promotion 경로는 이 모듈에 없고, 준비 함수도 enqueue=false로 고정한다.
 */
export async function runApprovedAuthoringGuideSourceRecovery(input: {
  readonly grantSha256: string;
  readonly signal: AbortSignal;
  readonly repositoryRoot?: string;
  readonly onRound?: (round: {
    readonly round: number;
    readonly sealedCount: number;
    readonly remainingTargetCount: number;
  }) => void;
}): Promise<ApprovedAuthoringGuideSourceRecoveryResult> {
  const repositoryRoot = input.repositoryRoot ?? findMonorepoRoot();
  const grant = normalizeAuthoringGuideSourceRecoveryGrant(
    await readAuthoringGuideSourceRecoveryExecutionArtifact(
      "grants",
      input.grantSha256,
      repositoryRoot,
    ),
  );
  const manifest = await readAuthoringGuideSourceRecoveryManifest(
    grant.manifestSha256,
    repositoryRoot,
  );
  if (grant.targetCount !== manifest.targets.length || grant.maxRounds !== manifest.execution.maxRounds) {
    throw new Error("source recovery grant와 manifest target/round 결속이 다릅니다.");
  }
  if (koreaDateKey(new Date()) !== manifest.source.adoptionAsOfKst) {
    throw new Error("source recovery manifest의 지원 가능 기준일이 오늘 KST와 다릅니다.");
  }
  const storage = createR2ObjectStorageFromEnv();
  if (!storage) throw new Error("source recovery 실행에 R2 환경변수가 필요합니다.");
  if (!process.env.CONVERSION_SERVER_URL?.trim()) {
    throw new Error("source recovery 실행에 CONVERSION_SERVER_URL이 필요합니다.");
  }
  if (!process.env.CONVERSION_SHARED_SECRET?.trim()) {
    throw new Error("source recovery 실행에 CONVERSION_SHARED_SECRET이 필요합니다.");
  }

  const db = getCunoteDb();
  const runtime = await readDeepAnalysisRuntimeAdmissionSnapshot(db);
  assertRecoveryRuntimeAdmission(runtime);
  const startedAt = new Date();
  const runtimeAuthority = createDeepRepairLiveRuntimeAuthority(
    createDeepRepairLiveDbLeaseClient({
      changedBy: "lab:authoring-guide:recovery",
      reason: `승인된 작성 가이드 source recovery: ${input.grantSha256}`,
    }),
  );
  const execution = await runtimeAuthority.runExclusive({
    ownerId: randomUUID(),
    expectedGeneration: runtime.generation,
    signal: input.signal,
  }, async (executionSignal) => {
    const current = await prepareCurrentAuthoringGuideAdoption({
      asOf: adoptionAsOfDate(manifest.source.adoptionAsOfKst),
      concurrency: 4,
    });
    assertExactAuthoringGuideSourceRecoveryMaterial(manifest, current);
    const claimed = await claimImmutableBytesAtomic(
      authoringGuideSourceRecoveryExecutionClaimPath(input.grantSha256, repositoryRoot),
      encodeAuthoringGuideSourceRecoveryExecutionArtifact({
        schema: "authoring-guide-source-recovery-execution-claim-v1",
        grantSha256: input.grantSha256,
        manifestSha256: grant.manifestSha256,
        startedAt: startedAt.toISOString(),
        targetCount: manifest.targets.length,
        maxRounds: manifest.execution.maxRounds,
      }),
    );
    if (!claimed) {
      throw new Error("source recovery grant의 실행 claim이 이미 존재합니다.");
    }

    const policy = resolveDeepAnalysisInputPreparationPolicy({
      ...process.env,
      DEEP_ANALYSIS_PREPARE_MAX_GRANTS_PER_SOURCE: String(
        manifest.execution.maxTargetsPerSourcePerRound,
      ),
      DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_GRANT: "10",
      DEEP_ANALYSIS_PREPARE_MAX_ATTACHMENTS_PER_SOURCE: "200",
      DEEP_ANALYSIS_PREPARE_SCAN_LIMIT: "5000",
      DEEP_ANALYSIS_PREPARE_CONVERSION_LIMIT: "100",
      DEEP_ANALYSIS_PREPARE_DEADLINE_SECONDS: "900",
    });
    return runAuthoringGuideSourceRecoveryRounds({
      manifest,
      signal: executionSignal,
      onRound(round) {
        input.onRound?.({
          round: round.round,
          sealedCount: round.sealedCount,
          remainingTargetCount: round.remainingTargetCount,
        });
      },
      async runRound(selected, round): Promise<AuthoringGuideSourceRecoveryRoundResult> {
        if (executionSignal.aborted) throw executionSignal.reason;
        const targets = selected.map((target): DeepAnalysisInputPreparationTarget => ({
          grantId: target.grantId,
          source: target.source,
          sourceId: target.sourceId,
          title: target.title,
          applyEnd: null,
          jobUpdatedAt: new Date(0),
          jobStatus: `authoring_guide_source_recovery_round_${round}`,
          sourceRevisionSha256: target.current.sourceRevisionSha256,
        }));
        const result = await runDeepAnalysisInputPreparation({
          db,
          storage,
          policy,
          enqueuePreparedJobs: false,
          archiveFetchTimeoutMs: manifest.execution.archiveFetchTimeoutMs,
          reprocessMissingMarkdown: manifest.execution.reprocessMissingMarkdown,
          archiveMaxEntries: manifest.execution.archiveMaxEntries,
          listTargets: async () => targets,
        });
        return toRecoveryRoundResult(result);
      },
    });
  });

  const postRecoveryAdoption = await prepareCurrentAuthoringGuideAdoption({
    asOf: adoptionAsOfDate(manifest.source.adoptionAsOfKst),
    concurrency: 4,
  });
  const adoptionArtifact = await writeAuthoringGuideAdoptionManifest(
    postRecoveryAdoption,
    repositoryRoot,
  );
  const receipt = createAuthoringGuideSourceRecoveryReceipt({
    grantSha256: input.grantSha256,
    manifestSha256: grant.manifestSha256,
    manifest,
    execution,
    startedAt,
    finishedAt: new Date(),
    adoptionManifest: postRecoveryAdoption,
    adoptionArtifact: {
      sha256: adoptionArtifact.sha256,
      path: relative(repositoryRoot, adoptionArtifact.path).split(sep).join("/"),
    },
  });
  const receiptArtifact = await writeAuthoringGuideSourceRecoveryExecutionArtifact(
    "receipts",
    receipt,
    repositoryRoot,
  );
  return Object.freeze({
    receipt,
    receiptSha256: receiptArtifact.sha256,
    receiptPath: receiptArtifact.path,
  });
}

export function authoringGuideSourceRecoveryExecutionArtifactPath(
  kind: "grants" | "receipts",
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): string {
  if (!SHA256.test(sha256)) throw new Error(`허용되지 않는 source recovery ${kind} SHA: ${sha256}`);
  return join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "authoring-guide-source-recovery",
    kind,
    `${sha256}.json`,
  );
}

export function authoringGuideSourceRecoveryExecutionClaimPath(
  grantSha256: string,
  repositoryRoot = findMonorepoRoot(),
): string {
  if (!SHA256.test(grantSha256)) throw new Error(`허용되지 않는 source recovery grant SHA: ${grantSha256}`);
  return join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "authoring-guide-source-recovery",
    "executions",
    `${grantSha256}.json`,
  );
}

export async function writeAuthoringGuideSourceRecoveryExecutionArtifact(
  kind: "grants" | "receipts",
  value: AuthoringGuideSourceRecoveryGrant | AuthoringGuideSourceRecoveryReceipt,
  repositoryRoot = findMonorepoRoot(),
): Promise<{ readonly sha256: string; readonly path: string }> {
  const bytes = encodeAuthoringGuideSourceRecoveryExecutionArtifact(value);
  const sha256 = hashAuthoringGuideSourceRecoveryExecutionArtifact(value);
  const path = authoringGuideSourceRecoveryExecutionArtifactPath(kind, sha256, repositoryRoot);
  await writeImmutableBytesAtomic(path, bytes);
  return Object.freeze({ sha256, path });
}

export async function readAuthoringGuideSourceRecoveryExecutionArtifact(
  kind: "grants" | "receipts",
  sha256: string,
  repositoryRoot = findMonorepoRoot(),
): Promise<unknown> {
  const bytes = await readFile(
    authoringGuideSourceRecoveryExecutionArtifactPath(kind, sha256, repositoryRoot),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new Error(`source recovery ${kind} 파일 SHA가 ID와 다릅니다.`);
  }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  if (Buffer.compare(bytes, encodeAuthoringGuideSourceRecoveryExecutionArtifact(value)) !== 0) {
    throw new Error(`source recovery ${kind} artifact가 canonical JSON이 아닙니다.`);
  }
  return value;
}

export function assertExactAuthoringGuideSourceRecoveryMaterial(
  manifest: AuthoringGuideSourceRecoveryManifest,
  current: Awaited<ReturnType<typeof prepareCurrentAuthoringGuideAdoption>>,
): void {
  if (current.asOfKst !== manifest.source.adoptionAsOfKst) {
    throw new Error("source recovery current adoption 기준일이 manifest와 다릅니다.");
  }
  const currentByGrant = new Map(current.items.map((item) => [item.grantId, item]));
  for (const target of manifest.targets) {
    const item = currentByGrant.get(target.grantId);
    if (!item) throw new Error(`source recovery target이 현재 지원 가능 모집단에 없습니다: ${target.grantId}`);
    const blockers = item.current.sourceBlockers.map((blocker) => {
      if (blocker.code !== "blocked_fetch" && blocker.code !== "blocked_conversion") {
        throw new Error(`source recovery blocker 종류가 변경됐습니다: ${target.grantId}:${blocker.code}`);
      }
      const code: "blocked_fetch" | "blocked_conversion" = blocker.code;
      return {
        code,
        attachmentId: blocker.attachmentId,
        message: blocker.message,
      };
    });
    if (
      item.source !== target.source
      || item.sourceId !== target.sourceId
      || item.disposition !== target.adoptionDisposition
      || item.current.sourceSealed !== false
      || item.current.sourceRevisionSha256 !== target.current.sourceRevisionSha256
      || item.current.operationalInputSha256 !== target.current.operationalInputSha256
      || item.current.operationalAttachmentManifestSha256
        !== target.current.operationalAttachmentManifestSha256
      || hashAuthoringGuideSourceRecoveryBlockers(blockers) !== target.blockersSha256
    ) {
      throw new Error(`source recovery target material이 준비 시점과 달라졌습니다: ${target.grantId}`);
    }
  }
}

function toRecoveryRoundResult(
  result: DeepAnalysisInputPreparationResult,
): AuthoringGuideSourceRecoveryRoundResult {
  return Object.freeze({
    targets: Object.freeze(result.after.map((target) => Object.freeze({
      grantId: target.grantId,
      source: target.source,
      sourceId: target.sourceId,
      sealed: target.sealed,
      blockerCodes: Object.freeze([...target.blockerCodes]),
      blockerCount: target.blockerCount,
      sourceRevisionSha256: target.sourceRevisionSha256,
      analysisJobId: target.jobId,
      analysisJobStatus: target.jobStatus,
      error: target.error,
    }))),
    metrics: Object.freeze({
      archivedCandidateCount:
        (result.archive.kstartup?.batchCandidateCount ?? 0)
        + (result.archive.bizinfo?.batchCandidateCount ?? 0),
      selectedAttachmentCount:
        (result.archive.kstartup?.selectedAttachmentCount ?? 0)
        + (result.archive.bizinfo?.selectedAttachmentCount ?? 0),
      archiveSucceededCount:
        (result.archive.kstartup?.succeededCount ?? 0)
        + (result.archive.bizinfo?.succeededCount ?? 0),
      archiveFailedCount:
        (result.archive.kstartup?.failedCount ?? 0)
        + (result.archive.bizinfo?.failedCount ?? 0),
      conversionCandidateAttachmentCount: result.conversionRegistration.candidateAttachmentCount,
      conversionJobsEnqueued: result.conversionRegistration.jobsEnqueued,
      conversionCacheHits: result.conversionRegistration.cacheHits,
      conversionFailedCount: result.conversion.failed,
      conversionStillPendingCount: result.conversion.stillPending,
      pdfRecoveryCandidateCount: result.pdfRecovery.candidateCount,
      pdfRecoverySucceededCount: result.pdfRecovery.succeededCount,
      pdfRecoveryFailedCount: result.pdfRecovery.failedCount,
      deadlineReached:
        Boolean(result.archive.kstartup?.deadlineReached)
        || Boolean(result.archive.bizinfo?.deadlineReached),
      budgetExhausted: result.conversion.budgetExhausted,
      elapsedMs: result.elapsedMs,
    }),
  });
}

function assertRecoveryRuntimeAdmission(runtime: {
  readonly mode: string;
  readonly localOwnerId: string | null;
  readonly localLeaseExpiresAt: string | null;
  readonly activeDeepLeases: number;
  readonly activeApplicationLeases: number;
}): void {
  if (
    runtime.mode !== "paused"
    || runtime.localOwnerId !== null
    || runtime.localLeaseExpiresAt !== null
    || runtime.activeDeepLeases !== 0
    || runtime.activeApplicationLeases !== 0
  ) {
    throw new Error("source recovery runtime admission은 paused/owner 없음/active lease 0이어야 합니다.");
  }
}

function adoptionAsOfDate(asOfKst: string): Date {
  return new Date(`${asOfKst}T03:00:00.000Z`);
}

function koreaDateKey(value: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(value);
}
