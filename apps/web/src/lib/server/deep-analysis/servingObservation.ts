import {
  DEEP_ANALYSIS_SERVING_VERIFIER_VERSION,
  type DeepAnalysisStageStatus,
} from "@cunote/contracts";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { sha256Hex, stableJson } from "./sourceRevision";

export const DEEP_ANALYSIS_SERVING_OBSERVATION_STAGES = [
  "publication_complete",
  "serving_complete",
  "analysis_fresh",
] as const;

export type DeepAnalysisServingObservationStage =
  (typeof DEEP_ANALYSIS_SERVING_OBSERVATION_STAGES)[number];

export interface DeepAnalysisServingObservationItem {
  promotionItemId: string;
  publicRunId: string;
}

export interface DeepAnalysisServingObservationReceipt {
  id: string;
  executionId: string;
  promotionItemId: string;
  publicRunId: string;
  stage: DeepAnalysisServingObservationStage;
  status: DeepAnalysisStageStatus;
  verifierVersion: string;
  evidence: Record<string, unknown>;
  evidenceSha256: string;
  artifactKey: string | null;
  createdAt: Date;
}

export interface DeepAnalysisServingObservationFailure {
  code:
    | "window_incomplete"
    | "window_too_short"
    | "window_not_cadence_aligned"
    | "expected_items_empty"
    | "scheduled_execution_missing"
    | "scheduled_execution_duplicate"
    | "scheduled_execution_slow"
    | "unexpected_promotion_item"
    | "receipt_missing"
    | "receipt_duplicate"
    | "receipt_run_mismatch"
    | "receipt_not_passed"
    | "receipt_verifier_mismatch"
    | "receipt_evidence_hash_mismatch"
    | "receipt_artifact_missing"
    | "artifact_read_failed"
    | "artifact_content_mismatch";
  detail: string;
  slot?: string;
  executionId?: string;
  promotionItemId?: string;
  stage?: DeepAnalysisServingObservationStage;
  receiptId?: string;
}

export interface DeepAnalysisServingObservationEvaluation {
  schema: "deep-analysis-serving-observation-v1";
  verdict: "PASS" | "FAIL";
  start: string;
  end: string;
  generatedAt: string;
  cadenceSeconds: number;
  maximumStartDelaySeconds: number;
  maximumCompletionDelaySeconds: number;
  expectedSlots: number;
  evaluatedSlots: number;
  observedScheduledExecutions: number;
  expectedItems: number;
  expectedReceipts: number;
  observedReceipts: number;
  scheduledExecutionIds: string[];
  extraExecutionIds: string[];
  failures: DeepAnalysisServingObservationFailure[];
}

export function evaluateDeepAnalysisServingObservation(input: {
  start: Date;
  end: Date;
  now?: Date;
  cadenceMs?: number;
  maximumStartDelayMs?: number;
  maximumCompletionDelayMs?: number;
  minimumWindowMs?: number;
  expectedItems: DeepAnalysisServingObservationItem[];
  receipts: DeepAnalysisServingObservationReceipt[];
}): DeepAnalysisServingObservationEvaluation {
  const now = input.now ?? new Date();
  const cadenceMs = input.cadenceMs ?? 30 * 60 * 1_000;
  const maximumStartDelayMs = input.maximumStartDelayMs ?? 5 * 60 * 1_000;
  const maximumCompletionDelayMs = input.maximumCompletionDelayMs ?? 10 * 60 * 1_000;
  const minimumWindowMs = input.minimumWindowMs ?? 24 * 60 * 60 * 1_000;
  const failures: DeepAnalysisServingObservationFailure[] = [];
  const durationMs = input.end.getTime() - input.start.getTime();

  if (now.getTime() < input.end.getTime()) {
    failures.push({
      code: "window_incomplete",
      detail: `observation window ends at ${input.end.toISOString()}`,
    });
  }
  if (durationMs < minimumWindowMs) {
    failures.push({
      code: "window_too_short",
      detail: `window=${durationMs}ms minimum=${minimumWindowMs}ms`,
    });
  }
  if (durationMs <= 0 || durationMs % cadenceMs !== 0) {
    failures.push({
      code: "window_not_cadence_aligned",
      detail: `window=${durationMs}ms cadence=${cadenceMs}ms`,
    });
  }
  if (input.expectedItems.length === 0) {
    failures.push({
      code: "expected_items_empty",
      detail: "no active applied deep-analysis promotion items",
    });
  }

  const expectedItems = new Map(
    input.expectedItems.map((item) => [item.promotionItemId, item]),
  );
  const executions = groupReceiptsByExecution(input.receipts);
  const slots = durationMs > 0 && durationMs % cadenceMs === 0
    ? Array.from(
      { length: durationMs / cadenceMs },
      (_, index) => new Date(input.start.getTime() + (index * cadenceMs)),
    )
    : [];
  const scheduledExecutionIds = new Set<string>();
  let evaluatedSlots = 0;

  for (const slot of slots) {
    if (slot.getTime() > now.getTime()) continue;
    evaluatedSlots += 1;
    const candidates = [...executions.entries()].filter(([, receipts]) => {
      const firstReceiptAt = Math.min(...receipts.map((receipt) => receipt.createdAt.getTime()));
      return firstReceiptAt >= slot.getTime()
        && firstReceiptAt < slot.getTime() + maximumStartDelayMs;
    });
    if (candidates.length === 0) {
      if (now.getTime() < slot.getTime() + maximumStartDelayMs) continue;
      failures.push({
        code: "scheduled_execution_missing",
        detail: `no monitor receipts within ${maximumStartDelayMs / 1_000}s after slot`,
        slot: slot.toISOString(),
      });
      continue;
    }
    if (candidates.length > 1) {
      failures.push({
        code: "scheduled_execution_duplicate",
        detail: `found ${candidates.length} monitor executions for slot`,
        slot: slot.toISOString(),
      });
      continue;
    }

    const [executionId, receipts] = candidates[0]!;
    scheduledExecutionIds.add(executionId);
    const lastReceiptAt = Math.max(...receipts.map((receipt) => receipt.createdAt.getTime()));
    if (lastReceiptAt >= slot.getTime() + maximumCompletionDelayMs) {
      failures.push({
        code: "scheduled_execution_slow",
        detail: `last receipt exceeded ${maximumCompletionDelayMs / 1_000}s after slot`,
        slot: slot.toISOString(),
        executionId,
      });
    }
    evaluateScheduledExecution({
      executionId,
      expectedItems,
      receipts,
      failures,
    });
  }

  const scheduledReceipts = input.receipts.filter((receipt) =>
    scheduledExecutionIds.has(receipt.executionId));
  const extraExecutionIds = [...executions.keys()]
    .filter((executionId) => !scheduledExecutionIds.has(executionId))
    .sort();
  const expectedReceipts =
    slots.length * input.expectedItems.length * DEEP_ANALYSIS_SERVING_OBSERVATION_STAGES.length;

  return {
    schema: "deep-analysis-serving-observation-v1",
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    start: input.start.toISOString(),
    end: input.end.toISOString(),
    generatedAt: now.toISOString(),
    cadenceSeconds: cadenceMs / 1_000,
    maximumStartDelaySeconds: maximumStartDelayMs / 1_000,
    maximumCompletionDelaySeconds: maximumCompletionDelayMs / 1_000,
    expectedSlots: slots.length,
    evaluatedSlots,
    observedScheduledExecutions: scheduledExecutionIds.size,
    expectedItems: input.expectedItems.length,
    expectedReceipts,
    observedReceipts: scheduledReceipts.length,
    scheduledExecutionIds: [...scheduledExecutionIds].sort(),
    extraExecutionIds,
    failures,
  };
}

function groupReceiptsByExecution(
  receipts: DeepAnalysisServingObservationReceipt[],
): Map<string, DeepAnalysisServingObservationReceipt[]> {
  const grouped = new Map<string, DeepAnalysisServingObservationReceipt[]>();
  for (const receipt of receipts) {
    const current = grouped.get(receipt.executionId) ?? [];
    current.push(receipt);
    grouped.set(receipt.executionId, current);
  }
  return grouped;
}

function evaluateScheduledExecution(input: {
  executionId: string;
  expectedItems: Map<string, DeepAnalysisServingObservationItem>;
  receipts: DeepAnalysisServingObservationReceipt[];
  failures: DeepAnalysisServingObservationFailure[];
}): void {
  for (const receipt of input.receipts) {
    if (!input.expectedItems.has(receipt.promotionItemId)) {
      input.failures.push({
        code: "unexpected_promotion_item",
        detail: "receipt promotion item is not in the frozen active set",
        executionId: input.executionId,
        promotionItemId: receipt.promotionItemId,
        stage: receipt.stage,
        receiptId: receipt.id,
      });
    }
  }

  for (const item of input.expectedItems.values()) {
    for (const stage of DEEP_ANALYSIS_SERVING_OBSERVATION_STAGES) {
      const matches = input.receipts.filter((receipt) =>
        receipt.promotionItemId === item.promotionItemId && receipt.stage === stage);
      if (matches.length === 0) {
        input.failures.push({
          code: "receipt_missing",
          detail: "scheduled execution did not record the required stage receipt",
          executionId: input.executionId,
          promotionItemId: item.promotionItemId,
          stage,
        });
        continue;
      }
      if (matches.length > 1) {
        input.failures.push({
          code: "receipt_duplicate",
          detail: `scheduled execution recorded ${matches.length} receipts for one item/stage`,
          executionId: input.executionId,
          promotionItemId: item.promotionItemId,
          stage,
        });
        continue;
      }
      const receipt = matches[0]!;
      if (receipt.publicRunId !== item.publicRunId) {
        input.failures.push({
          code: "receipt_run_mismatch",
          detail: `receipt run=${receipt.publicRunId} expected=${item.publicRunId}`,
          executionId: input.executionId,
          promotionItemId: item.promotionItemId,
          stage,
          receiptId: receipt.id,
        });
      }
      if (receipt.status !== "passed") {
        input.failures.push({
          code: "receipt_not_passed",
          detail: `receipt status=${receipt.status}`,
          executionId: input.executionId,
          promotionItemId: item.promotionItemId,
          stage,
          receiptId: receipt.id,
        });
      }
      if (receipt.verifierVersion !== DEEP_ANALYSIS_SERVING_VERIFIER_VERSION) {
        input.failures.push({
          code: "receipt_verifier_mismatch",
          detail: `receipt verifier=${receipt.verifierVersion}`,
          executionId: input.executionId,
          promotionItemId: item.promotionItemId,
          stage,
          receiptId: receipt.id,
        });
      }
      if (sha256Hex(stableJson(receipt.evidence)) !== receipt.evidenceSha256) {
        input.failures.push({
          code: "receipt_evidence_hash_mismatch",
          detail: "DB evidence hash does not match canonical evidence",
          executionId: input.executionId,
          promotionItemId: item.promotionItemId,
          stage,
          receiptId: receipt.id,
        });
      }
      if (!receipt.artifactKey) {
        input.failures.push({
          code: "receipt_artifact_missing",
          detail: "receipt does not reference an immutable R2 artifact",
          executionId: input.executionId,
          promotionItemId: item.promotionItemId,
          stage,
          receiptId: receipt.id,
        });
      }
    }
  }
}

export async function verifyDeepAnalysisServingObservationArtifacts(input: {
  storage: R2ObjectStorage;
  receipts: DeepAnalysisServingObservationReceipt[];
  scheduledExecutionIds: string[];
  concurrency?: number;
}): Promise<DeepAnalysisServingObservationFailure[]> {
  const scheduledExecutionIds = new Set(input.scheduledExecutionIds);
  const receipts = input.receipts.filter((receipt) =>
    scheduledExecutionIds.has(receipt.executionId));
  const concurrency = Math.max(1, Math.min(input.concurrency ?? 8, 16));
  const failures = await mapWithConcurrency(receipts, concurrency, async (receipt) => {
    if (!receipt.artifactKey) return [];
    try {
      const body = await input.storage.getObjectText(receipt.artifactKey);
      const expectedBody = `${stableJson({
        schema: "deep-analysis-stage-evidence-v1",
        runId: receipt.publicRunId,
        stage: receipt.stage,
        status: receipt.status,
        verifierVersion: receipt.verifierVersion,
        evidence: receipt.evidence,
      })}\n`;
      const keyHash = /stage-evidence-([0-9a-f]{64})\.json$/.exec(receipt.artifactKey)?.[1];
      if (
        body !== expectedBody
        || keyHash === undefined
        || sha256Hex(Buffer.from(body, "utf8")) !== keyHash
      ) {
        return [{
          code: "artifact_content_mismatch" as const,
          detail: "R2 artifact bytes do not match the DB receipt or content-addressed key",
          executionId: receipt.executionId,
          promotionItemId: receipt.promotionItemId,
          stage: receipt.stage,
          receiptId: receipt.id,
        }];
      }
      return [];
    } catch (error) {
      return [{
        code: "artifact_read_failed" as const,
        detail: error instanceof Error ? error.message : String(error),
        executionId: receipt.executionId,
        promotionItemId: receipt.promotionItemId,
        stage: receipt.stage,
        receiptId: receipt.id,
      }];
    }
  });
  return failures.flat();
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  run: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await run(values[index]!);
    }
  }));
  return results;
}
