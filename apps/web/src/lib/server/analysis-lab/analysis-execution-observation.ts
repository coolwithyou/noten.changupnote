import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ApplicationRoundtripRun } from "../application-analysis/contract";
import type { LabRun } from "./lab-contract";
import {
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchManifest,
  normalizeAnalysisLaunchReceipt,
  readAnalysisLaunchArtifact,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
  type AnalysisLaunchReceiptTarget,
} from "./launch-batch-artifacts";
import { findMonorepoRoot } from "./run-store";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_RECEIPTS = 100;

export interface AnalysisExecutionObservation {
  readonly schema: "analysis-launch-execution-observation-v1";
  readonly authority: "derived-from-sealed-launch-and-local-sidecar-observations";
  readonly binding: {
    readonly grantSha256: string;
    readonly manifestSha256: string;
    readonly receiptSha256s: readonly string[];
  };
  readonly integrity: {
    readonly launchGrantManifestReceiptsAndLabRuns: "exact_sha_bound";
    readonly applicationRoundtripSidecars: "unsealed_local_observation";
  };
  readonly scope: {
    readonly uniqueTargetCount: number;
    readonly receiptAttemptCount: number;
    readonly receiptTargetAttemptCount: number;
    readonly artifactBackedTargetAttemptCount: number;
    readonly uniqueArtifactBackedTargetCount: number;
    readonly unobservedFailedTargetCount: number;
    readonly skippedTargetCount: number;
  };
  readonly timing: {
    /** Receipt별 cohort wall의 합이다. 서로 겹친 receipt가 있으면 실제 경과시간으로 해석하지 않는다. */
    readonly observedReceiptWallMs: number;
    /** 각 LabRun wall의 합이다. primary/application 형제 병렬 실행을 이미 포함한다. */
    readonly observedTargetWallMs: number;
    /** primaryPasses가 봉인된 실행에서만 합산한 모델/검증 패스 시간이다. */
    readonly observedPrimaryPassWorkMs: number;
    readonly primaryPassTelemetryAttemptCount: number;
    /** 현재 target에서 실제 실행한 Kordoc sidecar wall. 재결속 materialize도 별도 실행으로 센다. */
    readonly observedApplicationRoundtripWallMs: number;
    /** 재사용하지 않은 Kordoc 문서 planner의 work 합. target wall과 합쳐 실제 wall로 해석하지 않는다. */
    readonly observedApplicationPlannerWorkMs: number;
    readonly observedApplicationModelRequestCount: number;
    readonly applicationRequestTelemetryAttemptCount: number;
    readonly applicationRequestTelemetryMissingAttemptCount: number;
    readonly queueWait: {
      readonly status: "unverified";
      readonly reason: "target_started_at_not_sealed_in_terminal_receipt";
    };
    readonly additiveWarning:
      "primary_and_application_work_can_overlap_and_must_not_be_added_as_wall_time";
  };
  readonly nominalCost: {
    readonly observedSubtotalUsd: number;
    readonly coverageComplete: boolean;
    readonly deepAnalysis: {
      readonly observedSubtotalUsd: number;
      readonly observedAttemptCount: number;
      readonly missingAttemptCount: number;
    };
    readonly applicationRoundtrip: {
      readonly observedSubtotalUsd: number;
      readonly observedAttemptCount: number;
      readonly missingAttemptCount: number;
    };
  };
  readonly receiptAttempts: readonly AnalysisExecutionReceiptAttempt[];
  readonly targetAttempts: readonly AnalysisExecutionTargetAttempt[];
}

export interface AnalysisExecutionReceiptAttempt {
  readonly receiptSha256: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly wallMs: number;
  readonly stopReason: AnalysisLaunchReceipt["stopReason"];
  readonly summary: AnalysisLaunchReceipt["summary"];
}

export interface AnalysisExecutionTargetAttempt {
  readonly receiptSha256: string;
  readonly sequence: number;
  readonly grantId: string;
  readonly status: AnalysisLaunchReceiptTarget["status"];
  readonly run: null | {
    readonly runId: string;
    readonly artifactPath: string;
    readonly artifactSha256: string;
    readonly targetWallMs: number;
    readonly primaryPassWorkMs: number | null;
    readonly deepAnalysisCostUsd: number | null;
  };
  readonly applicationRoundtrip: null | {
    readonly runId: string;
    readonly reusedFromRunId: string | null;
    readonly locallyObservedAnalysisSha256: string;
    readonly locallyObservedManifestSha256: string;
    readonly hashBinding: "unsealed_local_observation";
    readonly wallMs: number;
    readonly plannerWorkMs: number;
    readonly modelRequestCount: number | null;
    readonly nominalCostUsd: number | null;
  };
}

export async function observeAnalysisLaunchExecution(input: {
  readonly grantSha256: string;
  readonly receiptSha256s: readonly string[];
  readonly repositoryRoot?: string;
}): Promise<AnalysisExecutionObservation> {
  const root = await realpath(resolve(input.repositoryRoot ?? findMonorepoRoot()));
  const grantSha256 = exactSha(input.grantSha256, "grantSha256");
  const receiptSha256s = normalizeReceiptIds(input.receiptSha256s);
  const grant = normalizeAnalysisLaunchGrant(
    await readAnalysisLaunchArtifact("grants", grantSha256, root),
  );
  const manifest = normalizeAnalysisLaunchManifest(
    await readAnalysisLaunchArtifact("manifests", grant.manifestSha256, root),
  );
  if (grant.targetCount !== manifest.targets.length) {
    throw new Error("launch grant targetCount가 manifest와 다릅니다.");
  }

  const receipts = await Promise.all(receiptSha256s.map(async (receiptSha256) => {
    const receipt = normalizeAnalysisLaunchReceipt(
      await readAnalysisLaunchArtifact("receipts", receiptSha256, root),
    );
    assertReceiptBinding({
      receipt,
      receiptSha256,
      grantSha256,
      manifestSha256: grant.manifestSha256,
      manifest,
    });
    return { receiptSha256, receipt };
  }));
  receipts.sort((left, right) =>
    left.receipt.startedAt.localeCompare(right.receipt.startedAt)
    || left.receiptSha256.localeCompare(right.receiptSha256));

  const manifestTargets = new Map(manifest.targets.map((target) => [target.sequence, target]));
  const seenRunArtifacts = new Set<string>();
  const targetAttempts: AnalysisExecutionTargetAttempt[] = [];
  for (const { receiptSha256, receipt } of receipts) {
    for (const target of receipt.targets) {
      targetAttempts.push(await observeTargetAttempt({
        root,
        receiptSha256,
        target,
        manifestTarget: manifestTargets.get(target.sequence)!,
        seenRunArtifacts,
      }));
    }
  }

  const artifactBacked = targetAttempts.filter((attempt) => attempt.run !== null);
  const costRelevantAttempts = targetAttempts.filter((attempt) => attempt.status !== "skipped");
  const deepCosts = costRelevantAttempts.map(
    (attempt) => attempt.run?.deepAnalysisCostUsd ?? null,
  );
  const applicationCosts = manifest.execution.withApplicationRoundtrip
    ? costRelevantAttempts.map((attempt) => attempt.applicationRoundtrip?.nominalCostUsd ?? null)
    : [];
  const applicationRequestCounts = manifest.execution.withApplicationRoundtrip
    ? costRelevantAttempts.map((attempt) => attempt.applicationRoundtrip?.modelRequestCount ?? null)
    : [];
  const deepAnalysisObservedSubtotalUsd = sum(presentNumbers(deepCosts));
  const applicationRoundtripObservedSubtotalUsd = sum(presentNumbers(applicationCosts));
  return Object.freeze({
    schema: "analysis-launch-execution-observation-v1",
    authority: "derived-from-sealed-launch-and-local-sidecar-observations",
    binding: Object.freeze({
      grantSha256,
      manifestSha256: grant.manifestSha256,
      receiptSha256s: Object.freeze(receipts.map((item) => item.receiptSha256)),
    }),
    integrity: Object.freeze({
      launchGrantManifestReceiptsAndLabRuns: "exact_sha_bound",
      applicationRoundtripSidecars: "unsealed_local_observation",
    }),
    scope: Object.freeze({
      uniqueTargetCount: manifest.targets.length,
      receiptAttemptCount: receipts.length,
      receiptTargetAttemptCount: targetAttempts.length,
      artifactBackedTargetAttemptCount: artifactBacked.length,
      uniqueArtifactBackedTargetCount: new Set(artifactBacked.map(targetKey)).size,
      unobservedFailedTargetCount: targetAttempts.filter(
        (attempt) => attempt.status === "failed" && attempt.run === null,
      ).length,
      skippedTargetCount: targetAttempts.filter((attempt) => attempt.status === "skipped").length,
    }),
    timing: Object.freeze({
      observedReceiptWallMs: sum(receipts.map(({ receipt }) =>
        Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt))),
      observedTargetWallMs: sum(artifactBacked.map((attempt) => attempt.run!.targetWallMs)),
      observedPrimaryPassWorkMs: sum(artifactBacked.map(
        (attempt) => attempt.run!.primaryPassWorkMs ?? 0,
      )),
      primaryPassTelemetryAttemptCount: artifactBacked.filter(
        (attempt) => attempt.run!.primaryPassWorkMs !== null,
      ).length,
      observedApplicationRoundtripWallMs: sum(artifactBacked.map(
        (attempt) => attempt.applicationRoundtrip?.wallMs ?? 0,
      )),
      observedApplicationPlannerWorkMs: sum(artifactBacked.map(
        (attempt) => attempt.applicationRoundtrip?.plannerWorkMs ?? 0,
      )),
      observedApplicationModelRequestCount: sum(presentNumbers(applicationRequestCounts)),
      applicationRequestTelemetryAttemptCount: presentNumbers(applicationRequestCounts).length,
      applicationRequestTelemetryMissingAttemptCount: applicationRequestCounts.filter(
        (value) => value === null,
      ).length,
      queueWait: Object.freeze({
        status: "unverified",
        reason: "target_started_at_not_sealed_in_terminal_receipt",
      }),
      additiveWarning: "primary_and_application_work_can_overlap_and_must_not_be_added_as_wall_time",
    }),
    nominalCost: Object.freeze({
      observedSubtotalUsd: deepAnalysisObservedSubtotalUsd + applicationRoundtripObservedSubtotalUsd,
      coverageComplete: ![...deepCosts, ...applicationCosts].some((value) => value === null),
      deepAnalysis: Object.freeze({
        observedSubtotalUsd: deepAnalysisObservedSubtotalUsd,
        observedAttemptCount: deepCosts.filter((value) => value !== null).length,
        missingAttemptCount: deepCosts.filter((value) => value === null).length,
      }),
      applicationRoundtrip: Object.freeze({
        observedSubtotalUsd: applicationRoundtripObservedSubtotalUsd,
        observedAttemptCount: applicationCosts.filter((value) => value !== null).length,
        missingAttemptCount: applicationCosts.filter((value) => value === null).length,
      }),
    }),
    receiptAttempts: Object.freeze(receipts.map(({ receiptSha256, receipt }) => Object.freeze({
      receiptSha256,
      startedAt: receipt.startedAt,
      finishedAt: receipt.finishedAt,
      wallMs: Date.parse(receipt.finishedAt) - Date.parse(receipt.startedAt),
      stopReason: receipt.stopReason,
      summary: receipt.summary,
    }))),
    targetAttempts: Object.freeze(targetAttempts),
  });
}

async function observeTargetAttempt(input: {
  readonly root: string;
  readonly receiptSha256: string;
  readonly target: AnalysisLaunchReceiptTarget;
  readonly manifestTarget: AnalysisLaunchManifest["targets"][number];
  readonly seenRunArtifacts: Set<string>;
}): Promise<AnalysisExecutionTargetAttempt> {
  const base = {
    receiptSha256: input.receiptSha256,
    sequence: input.target.sequence,
    grantId: input.target.grantId,
    status: input.target.status,
  } as const;
  if (input.target.runArtifactPath === null || input.target.runArtifactSha256 === null) {
    if (input.target.status === "publishable" || input.target.status === "held") {
      throw new Error(`종결 target에 LabRun artifact가 없습니다: ${input.target.grantId}`);
    }
    return Object.freeze({ ...base, run: null, applicationRoundtrip: null });
  }
  if (input.seenRunArtifacts.has(input.target.runArtifactSha256)) {
    throw new Error(`같은 LabRun artifact가 여러 target attempt에 중복 결속됐습니다: ${input.target.grantId}`);
  }
  input.seenRunArtifacts.add(input.target.runArtifactSha256);
  const runPath = await safeExistingPath(input.root, input.target.runArtifactPath);
  const runBytes = await readFile(runPath);
  if (sha256(runBytes) !== input.target.runArtifactSha256) {
    throw new Error(`LabRun artifact SHA가 receipt와 다릅니다: ${input.target.grantId}`);
  }
  const run = parseJsonObject<LabRun>(runBytes, `LabRun ${input.target.grantId}`);
  assertLabRunBinding(run, input.manifestTarget, input.target, runPath);
  if ((run.applicationRoundtrip?.status ?? null) !== input.target.applicationRoundtripStatus) {
    throw new Error(`LabRun Kordoc 상태가 receipt와 다릅니다: ${input.target.grantId}`);
  }
  const targetWallMs = nonNegativeNumber(run.durationMs, "LabRun.durationMs");
  const primaryPassWorkMs = run.primaryPasses === undefined
    ? null
    : sum(run.primaryPasses.map((pass, index) =>
      nonNegativeNumber(pass.durationMs, `LabRun.primaryPasses[${index}].durationMs`)));
  const deepAnalysisCostUsd = nullableNonNegativeNumber(run.costUsd, "LabRun.costUsd");
  const applicationRoundtrip = await observeApplicationRoundtrip({ root: input.root, run });
  return Object.freeze({
    ...base,
    run: Object.freeze({
      runId: run.runId,
      artifactPath: relative(input.root, runPath).split(sep).join("/"),
      artifactSha256: input.target.runArtifactSha256,
      targetWallMs,
      primaryPassWorkMs,
      deepAnalysisCostUsd,
    }),
    applicationRoundtrip,
  });
}

async function observeApplicationRoundtrip(input: {
  readonly root: string;
  readonly run: LabRun;
}): Promise<AnalysisExecutionTargetAttempt["applicationRoundtrip"]> {
  const reference = input.run.applicationRoundtrip;
  if (!reference?.runId) return null;
  const sourceGroup = `${sanitizeSegment(input.run.source)}__${sanitizeSegment(input.run.sourceId)}`;
  const directory = join(
    "spike-out",
    "analysis-lab",
    "application-roundtrip",
    sourceGroup,
    reference.runId,
  );
  const analysisPath = await safeExistingPath(input.root, join(directory, "analysis.json"));
  const manifestPath = await safeExistingPath(input.root, join(directory, "manifest.json"));
  const [analysisBytes, manifestBytes] = await Promise.all([
    readFile(analysisPath),
    readFile(manifestPath),
  ]);
  const roundtrip = parseJsonObject<ApplicationRoundtripRun>(analysisBytes, "application analysis");
  const manifest = parseJsonObject<Record<string, unknown>>(manifestBytes, "application manifest");
  if (
    roundtrip.runId !== reference.runId
    || roundtrip.grantId !== input.run.grantId
    || roundtrip.source !== input.run.source
    || roundtrip.sourceId !== input.run.sourceId
    || manifest.runId !== roundtrip.runId
    || manifest.grantId !== roundtrip.grantId
    || manifest.source !== roundtrip.source
    || manifest.sourceId !== roundtrip.sourceId
    || (roundtrip.parentLabRunId != null && roundtrip.parentLabRunId !== input.run.runId)
    || (reference.reusedFromRunId ?? null) !== (roundtrip.reusedFromRunId ?? null)
  ) {
    throw new Error(`Kordoc artifact가 LabRun과 다릅니다: ${input.run.grantId}`);
  }
  if (!Array.isArray(roundtrip.documents)) throw new Error("Kordoc documents가 배열이 아닙니다.");
  const reusedFromRunId = nonEmptyOptionalString(roundtrip.reusedFromRunId, "reusedFromRunId");
  const actualPlannerWork = reusedFromRunId === null
    ? sum(roundtrip.documents.map((document, index) =>
      nonNegativeNumber(document.fieldPlanning?.durationMs, `documents[${index}].fieldPlanning.durationMs`)))
    : 0;
  const requestCounts = roundtrip.documents.map((document, index) =>
    optionalNonNegativeInteger(document.fieldPlanning?.requestCount, `documents[${index}].fieldPlanning.requestCount`));
  const actualRequestCount = reusedFromRunId === null
    ? (requestCounts.some((value) => value === null) ? null : sum(requestCounts as number[]))
    : 0;
  const nominalCostUsd = reusedFromRunId === null
    ? nullableNonNegativeNumber(reference.costUsd, "applicationRoundtrip.costUsd")
    : 0;
  return Object.freeze({
    runId: reference.runId,
    reusedFromRunId,
    locallyObservedAnalysisSha256: sha256(analysisBytes),
    locallyObservedManifestSha256: sha256(manifestBytes),
    hashBinding: "unsealed_local_observation",
    wallMs: nonNegativeNumber(roundtrip.durationMs, "applicationRoundtrip.durationMs"),
    plannerWorkMs: actualPlannerWork,
    modelRequestCount: actualRequestCount,
    nominalCostUsd,
  });
}

function assertReceiptBinding(input: {
  readonly receipt: AnalysisLaunchReceipt;
  readonly receiptSha256: string;
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly manifest: AnalysisLaunchManifest;
}): void {
  if (
    input.receipt.grantSha256 !== input.grantSha256
    || input.receipt.manifestSha256 !== input.manifestSha256
  ) {
    throw new Error(`launch receipt ${input.receiptSha256}가 선택한 grant와 다릅니다.`);
  }
  if (input.receipt.targets.length !== input.manifest.targets.length) {
    throw new Error(`launch receipt ${input.receiptSha256} target 수가 manifest와 다릅니다.`);
  }
  for (const target of input.receipt.targets) {
    const expected = input.manifest.targets.find((candidate) => candidate.sequence === target.sequence);
    if (!expected || expected.grantId !== target.grantId || expected.sequence !== target.sequence) {
      throw new Error(`launch receipt ${input.receiptSha256} target 결속이 manifest와 다릅니다.`);
    }
  }
}

function assertLabRunBinding(
  run: LabRun,
  manifestTarget: AnalysisLaunchManifest["targets"][number],
  receiptTarget: AnalysisLaunchReceiptTarget,
  runPath: string,
): void {
  if (
    run.grantId !== receiptTarget.grantId
    || run.inputSha256 !== manifestTarget.inputSha256
    || run.attachmentManifestSha256 !== manifestTarget.attachmentManifestSha256
    || typeof run.runId !== "string"
    || basename(runPath) !== `${run.runId}.json`
  ) {
    throw new Error(`LabRun이 launch target과 다릅니다: ${receiptTarget.grantId}`);
  }
}

function normalizeReceiptIds(values: readonly string[]): string[] {
  if (values.length < 1 || values.length > MAX_RECEIPTS) {
    throw new Error(`receiptSha256s는 1~${MAX_RECEIPTS}개여야 합니다.`);
  }
  const normalized = values.map((value) => exactSha(value, "receiptSha256"));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("receiptSha256s가 중복됐습니다.");
  }
  return normalized;
}

async function safeExistingPath(root: string, repositoryRelativePath: string): Promise<string> {
  if (repositoryRelativePath.trim() === "" || isAbsolute(repositoryRelativePath)) {
    throw new Error("artifact path는 저장소 상대경로여야 합니다.");
  }
  const candidate = resolve(root, repositoryRelativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error("artifact path가 저장소 밖을 가리킵니다.");
  }
  const actual = await realpath(candidate);
  if (actual !== root && !actual.startsWith(`${root}${sep}`)) {
    throw new Error("artifact symlink가 저장소 밖을 가리킵니다.");
  }
  return actual;
}

function parseJsonObject<T>(bytes: Buffer, label: string): T {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} JSON을 읽을 수 없습니다.`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}가 객체가 아닙니다.`);
  }
  return value as T;
}

function exactSha(value: string, label: string): string {
  if (!SHA256.test(value)) throw new Error(`${label} 형식이 잘못됐습니다.`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label}가 0 이상의 유한수가 아닙니다.`);
  }
  return value;
}

function nullableNonNegativeNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return nonNegativeNumber(value, label);
}

function optionalNonNegativeInteger(value: unknown, label: string): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label}가 0 이상의 정수가 아닙니다.`);
  }
  return value as number;
}

function nonEmptyOptionalString(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label}가 잘못됐습니다.`);
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function targetKey(target: AnalysisExecutionTargetAttempt): string {
  return `${target.sequence}:${target.grantId}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._\-]/g, "_");
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function presentNumbers(values: readonly (number | null)[]): number[] {
  return values.filter((value): value is number => value !== null);
}
