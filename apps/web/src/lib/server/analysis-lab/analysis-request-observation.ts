import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { findMonorepoRoot } from "./run-store";

export type AnalysisRequestStage = "primary" | "repair" | "application" | "review" | "unknown";

export interface AnalysisRequestObservation {
  readonly schema: "analysis-request-observation-v1";
  readonly authority: "unsealed_local_observation";
  readonly processInstanceId: string;
  readonly manifestSha256: string;
  readonly runId: string;
  readonly grantId: string;
  readonly requestId: string;
  readonly stage: AnalysisRequestStage;
  readonly toolName: string;
  readonly enqueuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string;
  readonly monotonicEnqueuedMs: number;
  readonly monotonicStartedMs: number | null;
  readonly monotonicEndedMs: number;
  readonly queueWaitMs: number | null;
  readonly executionMs: number | null;
  readonly modelUsage: null | {
    /** CLI input_tokens + cache_creation_input_tokens. 명목 요청 입력량과 같은 계약이다. */
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadInputTokens: number;
  };
  readonly outcome: "fulfilled" | "rejected" | "aborted_before_start";
  readonly completeness: "complete" | "missing_start";
}

export interface AnalysisReuseObservation {
  readonly schema: "analysis-reuse-observation-v1";
  readonly authority: "unsealed_local_observation";
  readonly processInstanceId: string;
  readonly manifestSha256: string;
  readonly runId: string;
  readonly grantId: string;
  readonly stage: "application";
  readonly mode: "reused";
  readonly sourceRunId: string;
  readonly sourceAnalysisArtifactSha256: string;
  readonly sourceManifestArtifactSha256: string;
  readonly newModelRequestCount: 0;
  readonly observedAt: string;
}

export type AnalysisExecutionSidecarEvent = AnalysisRequestObservation | AnalysisReuseObservation;

export interface AnalysisRequestObservationAggregate {
  readonly requestCount: number;
  readonly queueWaitMs: number;
  readonly executionWorkMs: number;
  readonly executionWallMs: number;
  readonly reusedApplicationCount: number;
  readonly newApplicationModelRequestCount: number;
  readonly modelInputTokens: number;
  readonly modelOutputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly missingModelUsageRequestCount: number;
  readonly incompleteEventCount: number;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/u;
const pendingAppends = new Map<string, Promise<void>>();

export async function appendAnalysisExecutionSidecarEvent(input: {
  readonly event: AnalysisExecutionSidecarEvent;
  readonly repositoryRoot?: string;
}): Promise<void> {
  assertAnalysisExecutionSidecarEvent(input.event);
  const repositoryRoot = input.repositoryRoot ?? findMonorepoRoot();
  const directory = join(repositoryRoot, "spike-out", "analysis-lab", "execution-observations");
  const path = join(directory, `${input.event.runId}.jsonl`);
  await mkdir(directory, { recursive: true });
  const previous = pendingAppends.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(async () => {
    await appendFile(path, `${JSON.stringify(input.event)}\n`, { encoding: "utf8", flag: "a" });
  });
  pendingAppends.set(path, next);
  try {
    await next;
  } finally {
    if (pendingAppends.get(path) === next) pendingAppends.delete(path);
  }
}

export function aggregateAnalysisExecutionSidecarEvents(
  events: readonly AnalysisExecutionSidecarEvent[],
): AnalysisRequestObservationAggregate {
  const requests = events.filter((event): event is AnalysisRequestObservation => (
    event.schema === "analysis-request-observation-v1"
  ));
  const completeIntervals = requests.flatMap((event) => (
    event.monotonicStartedMs === null
      ? []
      : [{
          processInstanceId: event.processInstanceId,
          start: event.monotonicStartedMs,
          end: event.monotonicEndedMs,
        }]
  ));
  return Object.freeze({
    requestCount: requests.length,
    queueWaitMs: sum(requests.map((event) => event.queueWaitMs ?? 0)),
    executionWorkMs: sum(requests.map((event) => event.executionMs ?? 0)),
    executionWallMs: unionDurationByProcess(completeIntervals),
    reusedApplicationCount: events.filter((event) => event.schema === "analysis-reuse-observation-v1").length,
    newApplicationModelRequestCount: requests.filter((event) => event.stage === "application").length,
    modelInputTokens: sum(requests.map((event) => event.modelUsage?.inputTokens ?? 0)),
    modelOutputTokens: sum(requests.map((event) => event.modelUsage?.outputTokens ?? 0)),
    cacheReadInputTokens: sum(requests.map((event) => event.modelUsage?.cacheReadInputTokens ?? 0)),
    missingModelUsageRequestCount: requests.filter((event) => event.modelUsage === null).length,
    incompleteEventCount: requests.filter((event) => event.completeness !== "complete").length,
  });
}

function unionDurationByProcess(intervals: readonly {
  readonly processInstanceId: string;
  readonly start: number;
  readonly end: number;
}[]): number {
  const byProcess = new Map<string, Array<{ start: number; end: number }>>();
  for (const interval of intervals) {
    const values = byProcess.get(interval.processInstanceId) ?? [];
    values.push({ start: interval.start, end: interval.end });
    byProcess.set(interval.processInstanceId, values);
  }
  let total = 0;
  for (const values of byProcess.values()) {
    values.sort((left, right) => left.start - right.start || left.end - right.end);
    let start: number | null = null;
    let end = 0;
    for (const value of values) {
      if (start === null) {
        start = value.start;
        end = value.end;
      } else if (value.start <= end) {
        end = Math.max(end, value.end);
      } else {
        total += end - start;
        start = value.start;
        end = value.end;
      }
    }
    if (start !== null) total += end - start;
  }
  return total;
}

export function assertAnalysisExecutionSidecarEvent(
  event: AnalysisExecutionSidecarEvent,
): asserts event is AnalysisExecutionSidecarEvent {
  if (
    !SHA256.test(event.manifestSha256)
    || !SAFE_SEGMENT.test(event.runId)
    || event.runId.includes("..")
    || event.grantId.trim() === ""
    || event.processInstanceId.trim() === ""
  ) {
    throw new Error("analysis execution sidecar binding이 잘못됐습니다.");
  }
  if (event.schema === "analysis-request-observation-v1") {
    const validStage = new Set<AnalysisRequestStage>([
      "primary", "repair", "application", "review", "unknown",
    ]).has(event.stage);
    const validOutcome = new Set(["fulfilled", "rejected", "aborted_before_start"])
      .has(event.outcome);
    const validCompleteness = new Set(["complete", "missing_start"]).has(event.completeness);
    const numericValues = [
      event.monotonicEnqueuedMs,
      event.monotonicEndedMs,
      ...(event.monotonicStartedMs === null ? [] : [event.monotonicStartedMs]),
      ...(event.queueWaitMs === null ? [] : [event.queueWaitMs]),
      ...(event.executionMs === null ? [] : [event.executionMs]),
    ];
    const validUsage = event.modelUsage === null || [
      event.modelUsage.inputTokens,
      event.modelUsage.outputTokens,
      event.modelUsage.cacheReadInputTokens,
    ].every((value) => Number.isSafeInteger(value) && value >= 0);
    if (
      !validStage
      || !validOutcome
      || !validCompleteness
      || event.requestId.trim() === ""
      || event.toolName.trim() === ""
      || !isIsoDate(event.enqueuedAt)
      || !isIsoDate(event.endedAt)
      || (event.startedAt !== null && !isIsoDate(event.startedAt))
      || numericValues.some((value) => !Number.isFinite(value) || value < 0)
      || !validUsage
    ) {
      throw new Error("analysis request observation 값이 잘못됐습니다.");
    }
    return;
  }
  if (
    event.schema !== "analysis-reuse-observation-v1"
    || event.stage !== "application"
    || event.mode !== "reused"
    || event.newModelRequestCount !== 0
    || event.sourceRunId.trim() === ""
    || !SHA256.test(event.sourceAnalysisArtifactSha256)
    || !SHA256.test(event.sourceManifestArtifactSha256)
    || !isIsoDate(event.observedAt)
  ) {
    throw new Error("analysis reuse observation 값이 잘못됐습니다.");
  }
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
