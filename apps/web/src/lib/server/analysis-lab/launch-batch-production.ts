import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { getCunoteDb } from "@/lib/server/db/client";
import { readDeepAnalysisRuntimeAdmissionSnapshot } from "@/lib/server/deep-analysis/runtimeControl";
import { classifyAnalysisFeatureReadiness } from "@/lib/server/analysis-serving/analysisFeatureReadiness";
import { runLabAnalysis, prepareLabAnalysis } from "./analyze";
import { runLabBatch, scanExistingRuns, type LabBatchEvent, type LabBatchSummary } from "./batch-runner";
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
  encodeCanonical,
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  readAnalysisLaunchArtifact,
  readCurrentSeriesPlanInventory,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchAnalysisMode,
  type AnalysisLaunchManifest,
  type AnalysisLaunchCompletedCurrentInventoryBinding,
  type AnalysisLaunchReceipt,
  type AnalysisLaunchReceiptTarget,
} from "./launch-batch-artifacts";
import { buildAnalysisLaunchMatchingProjectionBinding } from "./primary-matching-projection";
import { withAnalysisLaunchBatchExecution } from "./launch-batch-context";
import { verifyIndependentReviewApplicationRoundtripReuseBinding } from "./independent-review-repair-launch-production";
import {
  applyAnalysisLaunchEvent,
  createAnalysisLaunchStatus,
  finishAnalysisLaunchStatus,
  writeAnalysisLaunchStatus,
  type AnalysisLaunchStatus,
} from "./launch-status";
import { classifyLabRunOutcome } from "./run-outcome";
import { findMonorepoRoot, labRunFilePath } from "./run-store";
import type { LabRun } from "./lab-contract";
import {
  buildCurrentInventoryLaunchManifest,
  MISSING_WORKSPACE_FIELDS_POLICY,
  readAndVerifyCompletedCurrentInventoryLaunchDetails,
  verifyCurrentInventoryLaunchBinding,
  type CurrentLaunchInventory,
} from "./current-inventory-launch";
import { verifyCurrentInventoryLaunchTarget } from "./current-inventory-launch-production";

export async function prepareAnalysisLaunchManifest(input: {
  readonly seriesId: string;
  readonly sequenceFrom: number;
  readonly sequenceTo: number;
  readonly concurrency: number;
  readonly analysisMode?: Exclude<AnalysisLaunchAnalysisMode, "application_only">;
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
    analysisMode: input.analysisMode ?? "primary_and_application",
    withApplicationRoundtrip: input.analysisMode !== "matching_only",
    ...(input.analysisMode === "matching_only"
      ? {}
      : { roundtripModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL }),
    concurrency: input.concurrency,
    now: new Date(),
  });
  const stored = await writeAnalysisLaunchArtifact("manifests", manifest);
  return Object.freeze({ manifest, manifestSha256: stored.sha256, path: stored.path });
}

interface CompletedCurrentInventoryLaunchPreparationDependencies {
  readonly repositoryRoot: string;
  readonly now: () => Date;
  readonly readProvenance: typeof readCurrentDeepRepairExecutionProvenance;
  readonly readCompletedLaunch: typeof readAndVerifyCompletedCurrentInventoryLaunchDetails;
  readonly verifyTarget: typeof verifyCurrentInventoryLaunchTarget;
  readonly prepareTarget: (grantId: string) => Promise<{
    readonly grantId: string;
    readonly inputSha256: string;
    readonly attachmentManifestSha256: string;
  }>;
  readonly writeManifest: (
    manifest: AnalysisLaunchManifest,
    repositoryRoot: string,
  ) => Promise<{ readonly sha256: string; readonly path: string }>;
}

/**
 * 완료된 exact current-inventory launch를 현행 material 계약으로 다시 준비한다.
 * primary_and_application/matching_only는 exact target을 다시 실행하고 application_only는
 * 완료 receipt의 publishable primary bytes를 재사용해 application만 실행하도록 봉인한다.
 */
export async function prepareCompletedCurrentInventoryLaunchManifest(input: {
  readonly inventorySha256: string;
  readonly sourceManifestSha256: string;
  readonly sourceGrantSha256: string;
  readonly terminalReceiptSha256: string;
  readonly selectedOriginalSequences?: readonly number[];
  readonly analysisMode?: AnalysisLaunchAnalysisMode;
  /** @deprecated CLI/호출부 호환용. 새 호출은 analysisMode를 사용한다. */
  readonly applicationOnly?: boolean;
  readonly concurrency: number;
}, dependencyOverrides: Partial<CompletedCurrentInventoryLaunchPreparationDependencies> = {}): Promise<{
  readonly manifest: AnalysisLaunchManifest;
  readonly manifestSha256: string;
  readonly path: string;
}> {
  if (input.analysisMode !== undefined && input.applicationOnly !== undefined) {
    throw new Error("재봉인 analysisMode와 --application-only를 함께 지정할 수 없습니다.");
  }
  const analysisMode = input.analysisMode
    ?? (input.applicationOnly ? "application_only" : "primary_and_application");
  const dependencies: CompletedCurrentInventoryLaunchPreparationDependencies = {
    repositoryRoot: findMonorepoRoot(),
    now: () => new Date(),
    readProvenance: readCurrentDeepRepairExecutionProvenance,
    readCompletedLaunch: readAndVerifyCompletedCurrentInventoryLaunchDetails,
    verifyTarget: verifyCurrentInventoryLaunchTarget,
    prepareTarget: async (grantId) => {
      const prepared = await prepareLabAnalysis(grantId);
      return {
        grantId: prepared.grant.id,
        inputSha256: prepared.input.inputSha256,
        attachmentManifestSha256: prepared.input.attachmentManifestSha256,
      };
    },
    writeManifest: async (manifest, repositoryRoot) => (
      writeAnalysisLaunchArtifact("manifests", manifest, repositoryRoot)
    ),
    ...dependencyOverrides,
  };
  const completedLaunch: AnalysisLaunchCompletedCurrentInventoryBinding = input.selectedOriginalSequences
    ? Object.freeze({
        schema: "analysis-launch-completed-current-inventory-v2",
        inventorySha256: input.inventorySha256,
        sourceManifestSha256: input.sourceManifestSha256,
        sourceGrantSha256: input.sourceGrantSha256,
        terminalReceiptSha256: input.terminalReceiptSha256,
        selectedOriginalSequences: validateSelectedOriginalSequences(
          input.selectedOriginalSequences,
        ),
      })
    : Object.freeze({
        schema: "analysis-launch-completed-current-inventory-v1",
        inventorySha256: input.inventorySha256,
        sourceManifestSha256: input.sourceManifestSha256,
        sourceGrantSha256: input.sourceGrantSha256,
        terminalReceiptSha256: input.terminalReceiptSha256,
      });
  const initialProvenance = await dependencies.readProvenance({
    repositoryRoot: dependencies.repositoryRoot,
  });
  const completed = await dependencies.readCompletedLaunch(
    dependencies.repositoryRoot,
    completedLaunch,
  );
  const inventory = completed.inventory;
  const selectedTargets = selectCompletedCurrentInventoryTargets(inventory, completedLaunch);
  const eligibilityInventory = completedLaunch.schema === "analysis-launch-completed-current-inventory-v2"
    ? completedResealEligibilityInventory(inventory)
    : inventory;
  const preparedTargets = await prepareCurrentInventoryResealTargets(
    eligibilityInventory,
    selectedTargets,
    dependencies,
  );
  const finalPreparedTargets = await prepareCurrentInventoryResealTargets(
    eligibilityInventory,
    selectedTargets,
    dependencies,
  );
  if (!encodeCanonical(preparedTargets).equals(encodeCanonical(finalPreparedTargets))) {
    throw new Error("current inventory 재봉인 준비 중 입력/첨부가 변경됐습니다.");
  }
  for (const target of selectedTargets) {
    await dependencies.verifyTarget(eligibilityInventory, target.grantId);
  }
  await dependencies.readCompletedLaunch(
    dependencies.repositoryRoot,
    completedLaunch,
    inventory,
  );
  const finalProvenance = await dependencies.readProvenance({
    repositoryRoot: dependencies.repositoryRoot,
  });
  if (!encodeCanonical(initialProvenance).equals(encodeCanonical(finalProvenance))) {
    throw new Error("current inventory 재봉인 준비 중 실행 코드가 변경됐습니다.");
  }
  const primaryReuse = analysisMode === "application_only"
    ? await buildCompletedLaunchPrimaryReuseBindings({
        repositoryRoot: dependencies.repositoryRoot,
        completed,
        selectedTargets,
        receiptSha256: input.terminalReceiptSha256,
      })
    : undefined;
  const manifest = buildCurrentInventoryLaunchManifest({
    inventory,
    inventorySha256: input.inventorySha256,
    preparedTargets: finalPreparedTargets,
    provenance: finalProvenance,
    concurrency: input.concurrency,
    completedLaunch,
    analysisMode,
    ...(analysisMode === "application_only" ? { primaryReuse: primaryReuse! } : {}),
    ...(completed.sourceManifest.source.terminalRepair
      ? { terminalRepair: completed.sourceManifest.source.terminalRepair }
      : {}),
    now: dependencies.now(),
  });
  const stored = await dependencies.writeManifest(manifest, dependencies.repositoryRoot);
  return Object.freeze({ manifest, manifestSha256: stored.sha256, path: stored.path });
}

async function buildCompletedLaunchPrimaryReuseBindings(input: {
  readonly repositoryRoot: string;
  readonly completed: Awaited<ReturnType<typeof readAndVerifyCompletedCurrentInventoryLaunchDetails>>;
  readonly selectedTargets: CurrentLaunchInventory["targets"];
  readonly receiptSha256: string;
}) {
  const bindings = [];
  for (const target of input.selectedTargets) {
    const receiptTarget = input.completed.receipt.targets.find((item) => item.grantId === target.grantId);
    if (!receiptTarget?.runArtifactPath || !receiptTarget.runArtifactSha256) {
      throw new Error(`application-only source run artifact가 없습니다: ${target.grantId}`);
    }
    const absolutePath = resolve(input.repositoryRoot, receiptTarget.runArtifactPath);
    const relativePath = relative(input.repositoryRoot, absolutePath);
    if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`application-only source run 경로가 저장소 밖입니다: ${target.grantId}`);
    }
    const bytes = await readFile(absolutePath);
    const artifactSha256 = createHash("sha256").update(bytes).digest("hex");
    if (artifactSha256 !== receiptTarget.runArtifactSha256) {
      throw new Error(`application-only source run SHA가 receipt와 다릅니다: ${target.grantId}`);
    }
    const run = JSON.parse(bytes.toString("utf8")) as LabRun;
    if (
      run.grantId !== target.grantId
      || run.inputSha256 !== target.inputSha256
      || run.attachmentManifestSha256 !== target.attachmentManifestSha256
      || classifyLabRunOutcome(run) !== "publishable"
      || (run.matchingReadiness !== "ready" && run.matchingReadiness !== "conditional")
      || run.primaryMatchingProjection?.verification !== "verified"
    ) {
      throw new Error(`application-only source primary가 재사용 조건을 충족하지 않습니다: ${target.grantId}`);
    }
    bindings.push(Object.freeze({
      schema: "analysis-launch-primary-reuse-v1" as const,
      sourceSequence: receiptTarget.sequence,
      sourceLabRunId: run.runId,
      sourceLabRunArtifactPath: relativePath.split(sep).join("/"),
      sourceLabRunArtifactSha256: artifactSha256,
      sourceLaunchReceiptSha256: input.receiptSha256,
    }));
  }
  return Object.freeze(bindings);
}

async function prepareCurrentInventoryResealTargets(
  inventory: CurrentLaunchInventory,
  selectedTargets: CurrentLaunchInventory["targets"],
  dependencies: CompletedCurrentInventoryLaunchPreparationDependencies,
) {
  const preparedTargets = [];
  for (const target of selectedTargets) {
    await dependencies.verifyTarget(inventory, target.grantId);
    const prepared = await dependencies.prepareTarget(target.grantId);
    if (
      prepared.grantId !== target.grantId
      || prepared.inputSha256 !== target.inputSha256
      || prepared.attachmentManifestSha256 !== target.attachmentManifestSha256
    ) {
      throw new Error(`current inventory 재봉인 target 입력/첨부가 변경됐습니다: ${target.grantId}`);
    }
    preparedTargets.push(prepared);
  }
  return preparedTargets;
}

function validateSelectedOriginalSequences(sequences: readonly number[]): readonly number[] {
  if (sequences.length < 1 || sequences.length > 100
    || sequences.some((sequence) => !Number.isSafeInteger(sequence) || sequence < 0)
    || new Set(sequences).size !== sequences.length) {
    throw new Error("재봉인 선택 sequence는 중복 없는 0 이상 정수 1~100개여야 합니다.");
  }
  return Object.freeze([...sequences]);
}

function selectCompletedCurrentInventoryTargets(
  inventory: CurrentLaunchInventory,
  binding: AnalysisLaunchCompletedCurrentInventoryBinding,
): CurrentLaunchInventory["targets"] {
  if (binding.schema === "analysis-launch-completed-current-inventory-v1") {
    return inventory.targets;
  }
  return Object.freeze(binding.selectedOriginalSequences.map((originalSequence, sequence) => {
    const target = inventory.targets[originalSequence];
    if (!target || target.sequence !== originalSequence) {
      throw new Error("재봉인 선택 sequence가 원 completed inventory 범위를 벗어났습니다.");
    }
    return Object.freeze({ ...target, sequence });
  }));
}

/** completed reseal은 현행 지원 조건을 다시 읽되 과거 field-repair의 필드 0개 조건은 승계하지 않는다. */
function completedResealEligibilityInventory(
  inventory: CurrentLaunchInventory,
): CurrentLaunchInventory {
  return inventory.policy === MISSING_WORKSPACE_FIELDS_POLICY
    ? Object.freeze({
        ...inventory,
        seriesId: `current-reseal-${inventory.seriesId.replace(/^current-field-repair-/u, "")}`,
        policy: "open-visible-current-period-unseen-v1" as const,
      })
    : inventory;
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
  await verifyCurrentInventoryLaunchBinding(findMonorepoRoot(), manifest);
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

export function projectAnalysisLaunchApplicationReceiptFields(input: {
  readonly withApplicationRoundtrip: boolean;
  readonly applicationRoundtrip?: Pick<NonNullable<LabRun["applicationRoundtrip"]>,
    "status" | "applicationDocumentCount" | "fieldReadyDocumentCount" | "recognizedFieldCount">;
}): Pick<AnalysisLaunchReceiptTarget,
  "applicationRoundtripStatus" | "applicationDocumentCount" | "fieldReadyDocumentCount" | "recognizedFieldCount"> {
  const application = input.withApplicationRoundtrip ? input.applicationRoundtrip : undefined;
  return Object.freeze({
    applicationRoundtripStatus: application?.status ?? null,
    applicationDocumentCount: application?.applicationDocumentCount ?? null,
    fieldReadyDocumentCount: application?.fieldReadyDocumentCount ?? null,
    recognizedFieldCount: application?.recognizedFieldCount ?? null,
  });
}

export function selectAnalysisLaunchRetryGrantIds(input: {
  readonly manifest: AnalysisLaunchManifest;
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly receipts: readonly AnalysisLaunchReceipt[];
  readonly retrySequences?: readonly number[] | null;
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
  const eligible = input.manifest.targets
    .filter((target) => {
      const status = latest.get(target.grantId);
      return status === undefined || status === "failed";
    });
  if (input.retrySequences === undefined || input.retrySequences === null) {
    return eligible.map((target) => target.grantId);
  }
  if (input.retrySequences.length === 0) {
    throw new Error("--retry-sequences는 하나 이상의 sequence를 지정해야 합니다.");
  }
  const manifestBySequence = new Map(input.manifest.targets.map((target) => [target.sequence, target]));
  const eligibleGrantIds = new Set(eligible.map((target) => target.grantId));
  const requested = new Set<number>();
  for (const sequence of input.retrySequences) {
    if (!Number.isSafeInteger(sequence) || sequence < 0 || requested.has(sequence)) {
      throw new Error("--retry-sequences에 잘못되거나 중복된 sequence가 있습니다.");
    }
    requested.add(sequence);
    const target = manifestBySequence.get(sequence);
    if (!target) throw new Error("--retry-sequences가 exact manifest 범위를 벗어났습니다.");
    if (!eligibleGrantIds.has(target.grantId)) {
      throw new Error("--retry-sequences에는 기존 retry 대상만 지정할 수 있습니다.");
    }
  }
  return eligible
    .filter((target) => requested.has(target.sequence))
    .map((target) => target.grantId);
}

/**
 * 승인된 manifest 전체를 하나의 DB lease 아래 실행한다. target 품질/입력 drift/개별 오류는
 * 격리하고, manifest 손상·공통 인증 실패·runtime lease 상실만 cohort 전체 오류로 올린다.
 */
export async function runApprovedAnalysisLaunchBatch(input: {
  readonly grantSha256: string;
  readonly retryErrors: boolean;
  readonly retrySequences?: readonly number[] | null;
  readonly signal: AbortSignal;
  readonly onEvent?: (event: LabBatchEvent) => void;
}): Promise<AnalysisLaunchRunResult> {
  if (input.retrySequences != null && !input.retryErrors) {
    throw new Error("--retry-sequences는 --retry-errors와 함께 사용해야 합니다.");
  }
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
  const currentInventory = await verifyCurrentInventoryLaunchBinding(repositoryRoot, manifest);
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
      ...(input.retrySequences !== undefined ? { retrySequences: input.retrySequences } : {}),
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
      sourceKind: manifest.source.kind,
      model: manifest.execution.model,
      transport: "claude-cli",
      promptVersion: manifest.execution.promptVersion,
      analysisMode: manifest.execution.analysisMode ?? "primary_and_application",
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
        // Keep skip_existing within this approved material revision. Historical
        // successes with a missing notice/PDF must not skip a repaired input.
        scanRunsImpl: () => scanExistingRuns(new Map(manifest.targets.map(target => [target.grantId, {
          inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256,
        }]))),
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
            if (currentInventory) {
              const { verifyCurrentInventoryLaunchTarget } = await import("./current-inventory-launch-production");
              await verifyCurrentInventoryLaunchTarget(
                manifest.source.completedLaunch?.schema
                  === "analysis-launch-completed-current-inventory-v2"
                  ? completedResealEligibilityInventory(currentInventory)
                  : currentInventory,
                grantId,
                undefined,
                manifest.execution.analysisMode,
              );
            }
            if (target.applicationRoundtripReuse) {
              await verifyIndependentReviewApplicationRoundtripReuseBinding({
                manifest,
                target,
                repositoryRoot,
              });
            }
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
              ...(target.applicationRoundtripReuse ? {
                exactApplicationRoundtripReuse: target.applicationRoundtripReuse,
              } : {}),
              ...(target.primaryReuse ? { exactPrimaryReuse: target.primaryReuse } : {}),
            });
            const absolutePath = labRunFilePath(run.source, run.sourceId, run.runId);
            const artifactBytes = await readFile(absolutePath);
            const primaryOutcome = classifyLabRunOutcome(run);
            const fieldAnalysis = manifest.execution.withApplicationRoundtrip
              ? classifyApplicationFieldAnalysis(run.applicationRoundtrip)
              : "not_required";
            const outcome = classifyAnalysisLaunchTargetStatus({ primaryOutcome, fieldAnalysis });
            const featureReadiness = classifyAnalysisFeatureReadiness({
              primaryOutcome,
              matchingReadiness: run.matchingReadiness,
              applicationFieldAnalysis: fieldAnalysis,
            });
            const fieldAnalysisError = primaryOutcome === "publishable" && fieldAnalysis === "held"
              ? "field_analysis_held: 지원 양식에서 안전하게 인식된 입력 필드를 확보하지 못했습니다."
              : null;
            const applicationReceiptFields = projectAnalysisLaunchApplicationReceiptFields({
              withApplicationRoundtrip: manifest.execution.withApplicationRoundtrip,
              ...(run.applicationRoundtrip ? { applicationRoundtrip: run.applicationRoundtrip } : {}),
            });
            outcomes.set(grantId, Object.freeze({
              sequence: target.sequence,
              grantId,
              status: outcome,
              runArtifactPath: relative(repositoryRoot, absolutePath).split(sep).join("/"),
              runArtifactSha256: createHash("sha256").update(artifactBytes).digest("hex"),
              ...applicationReceiptFields,
              featureReadiness,
              ...(run.primaryMatchingProjection ? {
                primaryMatchingProjection: buildAnalysisLaunchMatchingProjectionBinding(
                  run.primaryMatchingProjection,
                ),
              } : {}),
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
  readonly retrySequences?: readonly number[] | null;
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
    ...(input.retrySequences !== undefined ? { retrySequences: input.retrySequences } : {}),
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
