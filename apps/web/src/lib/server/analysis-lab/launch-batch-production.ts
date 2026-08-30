import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, sep } from "node:path";
import { getCunoteDb } from "@/lib/server/db/client";
import { readDeepAnalysisRuntimeAdmissionSnapshot } from "@/lib/server/deep-analysis/runtimeControl";
import { runLabAnalysis, prepareLabAnalysis } from "./analyze";
import { runLabBatch, type LabBatchEvent, type LabBatchSummary } from "./batch-runner";
import { verifyClaudeMaxSubscriptionAuthForLaunch } from "./claude-cli-transport";
import { createDeepRepairLiveDbLeaseClient } from "./deep-repair-live-db-runtime";
import { createDeepRepairLiveRuntimeAuthority } from "./deep-repair-live-runtime";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";
import {
  classifyApplicationFieldAnalysis,
  type ApplicationFieldAnalysisDisposition,
} from "./application-precompute";
import { APPLICATION_ROUNDTRIP_ADOPTED_MODEL } from "./application-roundtrip/contract";
import {
  analysisLaunchArtifactPath,
  assertAnalysisLaunchExecutionContract,
  createAnalysisLaunchGrant,
  createAnalysisLaunchManifest,
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  readAnalysisLaunchArtifact,
  readCurrentSeriesPlanInventory,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
  type AnalysisLaunchReceiptTarget,
} from "./launch-batch-artifacts";
import { withAnalysisLaunchBatchExecution } from "./launch-batch-context";
import {
  applyAnalysisLaunchEvent,
  createAnalysisLaunchStatus,
  finishAnalysisLaunchStatus,
  writeAnalysisLaunchStatus,
  type AnalysisLaunchStatus,
} from "./launch-status";
import { classifyLabRunOutcome } from "./run-outcome";
import { findMonorepoRoot, labRunFilePath } from "./run-store";

export async function prepareAnalysisLaunchManifest(input: {
  readonly seriesId: string;
  readonly sequenceFrom: number;
  readonly sequenceTo: number;
  readonly concurrency: number;
}): Promise<{
  readonly manifest: AnalysisLaunchManifest;
  readonly manifestSha256: string;
  readonly path: string;
}> {
  const inventory = await readCurrentSeriesPlanInventory(input.seriesId);
  const selected = inventory.targets.filter(
    (target) => target.sequence >= input.sequenceFrom && target.sequence <= input.sequenceTo,
  );
  const preparedTargets = [];
  for (const target of selected) {
    const prepared = await prepareLabAnalysis(target.grantId);
    preparedTargets.push({
      grantId: prepared.grant.id,
      inputSha256: prepared.input.inputSha256,
      attachmentManifestSha256: prepared.input.attachmentManifestSha256,
    });
  }
  const manifest = createAnalysisLaunchManifest({
    inventory,
    sequenceFrom: input.sequenceFrom,
    sequenceTo: input.sequenceTo,
    preparedTargets,
    provenance: await readCurrentDeepRepairExecutionProvenance(),
    withApplicationRoundtrip: true,
    roundtripModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    concurrency: input.concurrency,
    now: new Date(),
  });
  const stored = await writeAnalysisLaunchArtifact("manifests", manifest);
  return Object.freeze({ manifest, manifestSha256: stored.sha256, path: stored.path });
}

export async function approveAnalysisLaunchManifest(input: {
  readonly manifestSha256: string;
  readonly approvedBy: string;
}): Promise<{ readonly grantSha256: string; readonly path: string }> {
  const manifest = normalizeAnalysisLaunchManifest(
    await readAnalysisLaunchArtifact("manifests", input.manifestSha256),
  );
  const grant = createAnalysisLaunchGrant({
    manifestSha256: input.manifestSha256,
    targetCount: manifest.targets.length,
    approvedBy: input.approvedBy,
    now: new Date(),
  });
  const stored = await writeAnalysisLaunchArtifact("grants", grant);
  return Object.freeze({ grantSha256: stored.sha256, path: stored.path });
}

export interface AnalysisLaunchRunResult {
  readonly receipt: AnalysisLaunchReceipt;
  readonly receiptSha256: string;
  readonly receiptPath: string;
  readonly gitChangedSincePreparation: boolean;
  readonly batchSummary: LabBatchSummary | null;
}

export function shouldForceExactManifestReanalysis(input: {
  readonly existingRunPolicy: AnalysisLaunchManifest["execution"]["existingRunPolicy"];
  readonly retryErrors: boolean;
}): boolean {
  return input.existingRunPolicy === "rerun_exact_targets" || input.retryErrors;
}

export function classifyAnalysisLaunchTargetStatus(input: {
  readonly primaryOutcome: "publishable" | "held" | "failed";
  readonly fieldAnalysis: ApplicationFieldAnalysisDisposition | "not_required";
}): AnalysisLaunchReceiptTarget["status"] {
  if (input.primaryOutcome !== "publishable") return input.primaryOutcome;
  return input.fieldAnalysis === "held" ? "held" : "publishable";
}

export function selectAnalysisLaunchRetryGrantIds(input: {
  readonly manifest: AnalysisLaunchManifest;
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly receipts: readonly AnalysisLaunchReceipt[];
}): string[] {
  const matching = input.receipts
    .filter((receipt) => (
      receipt.grantSha256 === input.grantSha256
      && receipt.manifestSha256 === input.manifestSha256
    ))
    .sort((left, right) => left.finishedAt.localeCompare(right.finishedAt));
  if (matching.length === 0) {
    throw new Error("--retry-errors에 사용할 이전 launch receipt가 없습니다.");
  }
  const expected = new Map(input.manifest.targets.map((target) => [target.grantId, target.sequence]));
  const latest = new Map<string, AnalysisLaunchReceiptTarget["status"]>();
  for (const receipt of matching) {
    if (receipt.targets.length !== input.manifest.targets.length) {
      throw new Error("retry launch receipt targetCount가 manifest와 다릅니다.");
    }
    for (const target of receipt.targets) {
      if (expected.get(target.grantId) !== target.sequence) {
        throw new Error("retry launch receipt target 결속이 manifest와 다릅니다.");
      }
      if (target.status !== "skipped") latest.set(target.grantId, target.status);
    }
  }
  return input.manifest.targets
    .filter((target) => latest.get(target.grantId) === "failed")
    .map((target) => target.grantId);
}

/**
 * 승인된 manifest 전체를 하나의 DB lease 아래 실행한다. target 품질/입력 drift/개별 오류는
 * 격리하고, manifest 손상·공통 인증 실패·runtime lease 상실만 cohort 전체 오류로 올린다.
 */
export async function runApprovedAnalysisLaunchBatch(input: {
  readonly grantSha256: string;
  readonly retryErrors: boolean;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LabBatchEvent) => void;
}): Promise<AnalysisLaunchRunResult> {
  const startedAt = new Date();
  const repositoryRoot = findMonorepoRoot();
  const grant = normalizeAnalysisLaunchGrant(
    await readAnalysisLaunchArtifact("grants", input.grantSha256, repositoryRoot),
  );
  const manifest = normalizeAnalysisLaunchManifest(
    await readAnalysisLaunchArtifact("manifests", grant.manifestSha256, repositoryRoot),
  );
  if (grant.targetCount !== manifest.targets.length) {
    throw new Error("launch grant targetCount가 manifest와 다릅니다.");
  }
  const contract = assertAnalysisLaunchExecutionContract({
    manifest,
    current: await readCurrentDeepRepairExecutionProvenance({ repositoryRoot }),
  });
  const selectedGrantIds = input.retryErrors
    ? await readAnalysisLaunchRetryGrantIds({
      repositoryRoot,
      manifest,
      grantSha256: input.grantSha256,
      manifestSha256: grant.manifestSha256,
    })
    : manifest.targets.map((target) => target.grantId);
  let launchStatus: AnalysisLaunchStatus = createAnalysisLaunchStatus({
    grantSha256: input.grantSha256,
    manifestSha256: grant.manifestSha256,
    manifest,
    now: startedAt,
  });
  let statusWriteQueue = Promise.resolve();
  const persistLaunchStatus = (next: AnalysisLaunchStatus) => {
    launchStatus = next;
    statusWriteQueue = statusWriteQueue
      .then(() => writeAnalysisLaunchStatus(next, repositoryRoot))
      .catch((error: unknown) => {
        console.warn(
          "[launch] 관측 projection 기록 실패:",
          error instanceof Error ? error.message : error,
        );
      });
  };
  persistLaunchStatus(launchStatus);
  const outcomes = new Map<string, AnalysisLaunchReceiptTarget>();
  for (const target of manifest.targets) outcomes.set(target.grantId, skippedTarget(target));
  let batchSummary: LabBatchSummary | null = null;
  let systemicFailure: string | null = null;
  let stopReason: AnalysisLaunchReceipt["stopReason"] = "completed";

  try {
    const runtime = await readDeepAnalysisRuntimeAdmissionSnapshot(getCunoteDb());
    if (
      runtime.mode !== "paused"
      || runtime.localOwnerId !== null
      || runtime.localLeaseExpiresAt !== null
      || runtime.activeDeepLeases !== 0
      || runtime.activeApplicationLeases !== 0
    ) {
      throw new Error("launch runtime admission은 paused/owner 없음/active lease 0이어야 합니다.");
    }
    const ownerId = randomUUID();
    const runtimeAuthority = createDeepRepairLiveRuntimeAuthority(
      createDeepRepairLiveDbLeaseClient({
        changedBy: "lab:launch",
        reason: `승인된 launch cohort lease: ${input.grantSha256}`,
      }),
    );
    batchSummary = await runtimeAuthority.runExclusive({
      ownerId,
      expectedGeneration: runtime.generation,
      signal: input.signal,
    }, async (executionSignal) => withAnalysisLaunchBatchExecution({
      grantSha256: input.grantSha256,
      manifestSha256: grant.manifestSha256,
      model: manifest.execution.model,
      transport: "claude-cli",
      promptVersion: manifest.execution.promptVersion,
      withApplicationRoundtrip: manifest.execution.withApplicationRoundtrip,
      roundtripModel: manifest.execution.roundtripModel,
      targets: new Map(manifest.targets.map((target) => [target.grantId, target])),
    }, async () => {
      await verifyClaudeMaxSubscriptionAuthForLaunch({ externalSignal: executionSignal });
      return runLabBatch({
        limit: manifest.targets.length,
        concurrency: manifest.execution.concurrency,
        retryErrors: input.retryErrors,
        reanalyzeOutdated: false,
        exactManifestReanalysis: shouldForceExactManifestReanalysis({
          existingRunPolicy: manifest.execution.existingRunPolicy,
          retryErrors: input.retryErrors,
        }),
        transport: "claude-cli",
        model: manifest.execution.model,
        withApplicationRoundtrip: manifest.execution.withApplicationRoundtrip,
        ...(manifest.execution.roundtripModel
          ? { roundtripModel: manifest.execution.roundtripModel }
          : {}),
        grantIds: selectedGrantIds,
        signal: executionSignal,
        onEvent(event) {
          persistLaunchStatus(applyAnalysisLaunchEvent(launchStatus, event, new Date()));
          input.onEvent?.(event);
        },
      }, {
        readCohortImpl: async () => ({
          version: 2,
          selectedAt: manifest.preparedAt,
          seed: null,
          experimentLabel: `launch-${manifest.source.seriesId}`,
          entries: manifest.targets.map((target) => ({
            grantId: target.grantId,
            stratum: target.stratum,
          })),
        }),
        runAnalysisImpl: async (grantId, overrides) => {
          const target = manifest.targets.find((item) => item.grantId === grantId)!;
          try {
            const run = await runLabAnalysis(grantId, {
              ...overrides,
              signal: executionSignal,
              ...(target.reviewRepair ? {
                taskInstruction: target.reviewRepair.taskInstruction,
                reviewRepair: {
                  sourceRunId: target.reviewRepair.sourceRunId,
                  reviewModel: target.reviewRepair.reviewModel,
                  auditModel: null,
                  adjudicationModel: null,
                  blockingCount: target.reviewRepair.blockingCount,
                },
              } : {}),
            });
            const absolutePath = labRunFilePath(run.source, run.sourceId, run.runId);
            const artifactBytes = await readFile(absolutePath);
            const primaryOutcome = classifyLabRunOutcome(run);
            const fieldAnalysis = manifest.execution.withApplicationRoundtrip
              ? classifyApplicationFieldAnalysis(run.applicationRoundtrip)
              : "not_required";
            const outcome = classifyAnalysisLaunchTargetStatus({ primaryOutcome, fieldAnalysis });
            const fieldAnalysisError = primaryOutcome === "publishable" && fieldAnalysis === "held"
              ? "field_analysis_held: 지원 양식에서 안전하게 인식된 입력 필드를 확보하지 못했습니다."
              : null;
            outcomes.set(grantId, Object.freeze({
              sequence: target.sequence,
              grantId,
              status: outcome,
              runArtifactPath: relative(repositoryRoot, absolutePath).split(sep).join("/"),
              runArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
              applicationRoundtripStatus: run.applicationRoundtrip?.status ?? null,
              applicationDocumentCount: run.applicationRoundtrip?.applicationDocumentCount ?? null,
              fieldReadyDocumentCount: run.applicationRoundtrip?.fieldReadyDocumentCount ?? null,
              recognizedFieldCount: run.applicationRoundtrip?.recognizedFieldCount ?? null,
              error: run.error ?? fieldAnalysisError,
            }));
            return run;
          } catch (error) {
            outcomes.set(grantId, Object.freeze({
              sequence: target.sequence,
              grantId,
              status: "failed",
              runArtifactPath: null,
              runArtifactSha256: null,
              applicationRoundtripStatus: null,
              applicationDocumentCount: null,
              fieldReadyDocumentCount: null,
              recognizedFieldCount: null,
              error: error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000),
            }));
            throw error;
          }
        },
      });
    }));
    stopReason = batchSummary.stopReason === "window-exhausted"
      ? "window-exhausted"
      : batchSummary.stopReason === "systemic-failure"
        ? "systemic-failure"
        : batchSummary.stopReason === "aborted" ? "aborted" : "completed";
    if (batchSummary.stopReason === "systemic-failure") {
      systemicFailure = "Claude CLI Max 인증 공통 검증이 실행 중 실패했습니다.";
    }
  } catch (error) {
    systemicFailure = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
    stopReason = input.signal.aborted ? "aborted" : "systemic-failure";
  }

  const targets = manifest.targets.map((target) => outcomes.get(target.grantId)!);
  const receipt: AnalysisLaunchReceipt = Object.freeze({
    schema: "analysis-launch-receipt-v1",
    grantSha256: input.grantSha256,
    manifestSha256: grant.manifestSha256,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    lifecycle: "finished",
    stopReason,
    systemicFailure,
    summary: Object.freeze({
      publishable: targets.filter((target) => target.status === "publishable").length,
      held: targets.filter((target) => target.status === "held").length,
      failed: targets.filter((target) => target.status === "failed").length,
      skipped: targets.filter((target) => target.status === "skipped").length,
    }),
    targets: Object.freeze(targets),
  });
  const stored = await writeAnalysisLaunchArtifact("receipts", receipt, repositoryRoot);
  persistLaunchStatus(finishAnalysisLaunchStatus({
    status: launchStatus,
    receipt,
    receiptSha256: stored.sha256,
  }));
  await statusWriteQueue;
  return Object.freeze({
    receipt,
    receiptSha256: stored.sha256,
    receiptPath: stored.path,
    gitChangedSincePreparation: contract.gitChangedSincePreparation,
    batchSummary,
  });
}

export function analysisLaunchReceiptPath(sha256: string): string {
  return analysisLaunchArtifactPath("receipts", sha256);
}

async function readAnalysisLaunchRetryGrantIds(input: {
  readonly repositoryRoot: string;
  readonly manifest: AnalysisLaunchManifest;
  readonly grantSha256: string;
  readonly manifestSha256: string;
}): Promise<string[]> {
  const directory = dirname(analysisLaunchArtifactPath("receipts", "0".repeat(64), input.repositoryRoot));
  const names = await readdir(directory);
  const receipts: AnalysisLaunchReceipt[] = [];
  for (const name of names.sort()) {
    const match = /^([a-f0-9]{64})\.json$/.exec(name);
    if (!match?.[1]) continue;
    const receipt = normalizeAnalysisLaunchReceipt(
      await readAnalysisLaunchArtifact("receipts", match[1], input.repositoryRoot),
    );
    if (receipt.grantSha256 === input.grantSha256 && receipt.manifestSha256 === input.manifestSha256) {
      receipts.push(receipt);
    }
  }
  return selectAnalysisLaunchRetryGrantIds({
    manifest: input.manifest,
    grantSha256: input.grantSha256,
    manifestSha256: input.manifestSha256,
    receipts,
  });
}

function skippedTarget(target: AnalysisLaunchManifest["targets"][number]): AnalysisLaunchReceiptTarget {
  return Object.freeze({
    sequence: target.sequence,
    grantId: target.grantId,
    status: "skipped",
    runArtifactPath: null,
    runArtifactSha256: null,
    applicationRoundtripStatus: null,
    applicationDocumentCount: null,
    fieldReadyDocumentCount: null,
    recognizedFieldCount: null,
    error: null,
  });
}
