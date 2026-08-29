import { randomUUID } from "node:crypto";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LabBatchEvent } from "./batch-runner";
import type {
  AnalysisLaunchManifest,
  AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";
import { classifyApplicationFieldAnalysis } from "./application-precompute";
import { findMonorepoRoot } from "./run-store";

export type AnalysisLaunchLiveTargetStatus =
  | "pending"
  | "running"
  | "publishable"
  | "held"
  | "failed"
  | "skipped";

export interface AnalysisLaunchLiveTarget {
  readonly sequence: number;
  readonly grantId: string;
  readonly stratum: string;
  readonly status: AnalysisLaunchLiveTargetStatus;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly title: string | null;
  readonly applicationRoundtripStatus: string | null;
  readonly applicationDocumentCount: number | null;
  readonly fieldReadyDocumentCount: number | null;
  readonly recognizedFieldCount: number | null;
  readonly error: string | null;
}

export interface AnalysisLaunchStatus {
  readonly schema: "analysis-launch-status-v1";
  readonly authority: "derived-monitoring-projection";
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly seriesId: string;
  readonly lifecycle: "running" | "finished";
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  readonly receiptSha256: string | null;
  readonly stopReason: AnalysisLaunchReceipt["stopReason"] | null;
  readonly systemicFailure: string | null;
  readonly execution: AnalysisLaunchManifest["execution"];
  readonly summary: Record<AnalysisLaunchLiveTargetStatus, number>;
  readonly targets: readonly AnalysisLaunchLiveTarget[];
}

export function createAnalysisLaunchStatus(input: {
  readonly grantSha256: string;
  readonly manifestSha256: string;
  readonly manifest: AnalysisLaunchManifest;
  readonly now: Date;
}): AnalysisLaunchStatus {
  const now = input.now.toISOString();
  return withSummary({
    schema: "analysis-launch-status-v1",
    authority: "derived-monitoring-projection",
    grantSha256: input.grantSha256,
    manifestSha256: input.manifestSha256,
    seriesId: input.manifest.source.seriesId,
    lifecycle: "running",
    startedAt: now,
    updatedAt: now,
    finishedAt: null,
    receiptSha256: null,
    stopReason: null,
    systemicFailure: null,
    execution: input.manifest.execution,
    targets: input.manifest.targets.map((target) => ({
      sequence: target.sequence,
      grantId: target.grantId,
      stratum: target.stratum,
      status: "pending" as const,
      startedAt: null,
      finishedAt: null,
      title: null,
      applicationRoundtripStatus: null,
      applicationDocumentCount: null,
      fieldReadyDocumentCount: null,
      recognizedFieldCount: null,
      error: null,
    })),
  });
}

export function applyAnalysisLaunchEvent(
  status: AnalysisLaunchStatus,
  event: LabBatchEvent,
  now: Date,
): AnalysisLaunchStatus {
  const timestamp = now.toISOString();
  if (event.type === "finished" || event.type === "plan") {
    return { ...status, updatedAt: timestamp };
  }
  if (event.type === "guard-stop") {
    return {
      ...status,
      updatedAt: timestamp,
      systemicFailure: event.reason === "systemic-failure"
        ? "공유 실행 경로의 guard가 launch를 중단했습니다."
        : status.systemicFailure,
    };
  }
  const targets = status.targets.map((target): AnalysisLaunchLiveTarget => {
    if (target.grantId !== event.grantId) return target;
    if (event.type === "target-started") {
      return { ...target, status: "running", startedAt: timestamp };
    }
    if (event.type === "target-ok" || event.type === "target-held") {
      const fieldAnalysis = status.execution.withApplicationRoundtrip
        ? classifyApplicationFieldAnalysis(event.applicationRoundtrip)
        : "not_required";
      const heldByFieldAnalysis = event.type === "target-ok" && fieldAnalysis === "held";
      return {
        ...target,
        status: event.type === "target-ok" && !heldByFieldAnalysis ? "publishable" : "held",
        finishedAt: timestamp,
        title: event.title,
        applicationRoundtripStatus: event.applicationRoundtrip?.status ?? null,
        applicationDocumentCount: event.applicationRoundtrip?.applicationDocumentCount ?? null,
        fieldReadyDocumentCount: event.applicationRoundtrip?.fieldReadyDocumentCount ?? null,
        recognizedFieldCount: event.applicationRoundtrip?.recognizedFieldCount ?? null,
        error: heldByFieldAnalysis
          ? "field_analysis_held: 지원 양식에서 안전하게 인식된 입력 필드를 확보하지 못했습니다."
          : null,
      };
    }
    return {
      ...target,
      status: "failed",
      finishedAt: timestamp,
      title: event.title ?? null,
      error: event.message,
    };
  });
  return withSummary({ ...status, updatedAt: timestamp, targets });
}

export function finishAnalysisLaunchStatus(input: {
  readonly status: AnalysisLaunchStatus;
  readonly receipt: AnalysisLaunchReceipt;
  readonly receiptSha256: string;
}): AnalysisLaunchStatus {
  const byGrantId = new Map(input.receipt.targets.map((target) => [target.grantId, target]));
  return withSummary({
    ...input.status,
    lifecycle: "finished",
    updatedAt: input.receipt.finishedAt,
    finishedAt: input.receipt.finishedAt,
    receiptSha256: input.receiptSha256,
    stopReason: input.receipt.stopReason,
    systemicFailure: input.receipt.systemicFailure,
    targets: input.status.targets.map((target): AnalysisLaunchLiveTarget => {
      const terminal = byGrantId.get(target.grantId);
      if (!terminal) return target;
      return {
        ...target,
        status: terminal.status,
        finishedAt: target.finishedAt ?? input.receipt.finishedAt,
        applicationRoundtripStatus: terminal.applicationRoundtripStatus,
        applicationDocumentCount: terminal.applicationDocumentCount,
        fieldReadyDocumentCount: terminal.fieldReadyDocumentCount,
        recognizedFieldCount: terminal.recognizedFieldCount,
        error: terminal.error,
      };
    }),
  });
}

export function analysisLaunchStatusPath(
  grantSha256: string,
  repositoryRoot = findMonorepoRoot(),
): string {
  if (!/^[a-f0-9]{64}$/.test(grantSha256)) throw new Error("launch grant SHA 형식이 잘못됐습니다.");
  return join(
    repositoryRoot,
    "spike-out",
    "analysis-lab",
    "launch",
    "status",
    `${grantSha256}.json`,
  );
}

/**
 * 실행 권한과 무관한 파생 관측 projection이다. 임시 파일을 같은 디렉터리에 쓴 뒤 rename해
 * 독자가 반쪽 JSON을 보지 않게 한다. 최종 authority는 immutable launch receipt다.
 */
export async function writeAnalysisLaunchStatus(
  status: AnalysisLaunchStatus,
  repositoryRoot = findMonorepoRoot(),
): Promise<void> {
  const path = analysisLaunchStatusPath(status.grantSha256, repositoryRoot);
  const directory = dirname(path);
  const temporaryPath = join(directory, `.analysis-launch-status-${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true });
  await writeFile(temporaryPath, `${JSON.stringify(status, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporaryPath, path);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

function withSummary(
  status: Omit<AnalysisLaunchStatus, "summary">,
): AnalysisLaunchStatus {
  const summary: Record<AnalysisLaunchLiveTargetStatus, number> = {
    pending: 0,
    running: 0,
    publishable: 0,
    held: 0,
    failed: 0,
    skipped: 0,
  };
  for (const target of status.targets) summary[target.status] += 1;
  return Object.freeze({ ...status, summary: Object.freeze(summary) });
}
