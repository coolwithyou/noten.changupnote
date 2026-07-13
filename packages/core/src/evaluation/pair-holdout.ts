import { createHash } from "node:crypto";
import type { MatchingV3PairReviewTask } from "./pair-review-packet.js";

export interface MatchingV3PairHoldoutManifest {
  schemaVersion: "matching-v3-pair-holdout-v1";
  createdAt: string;
  selectionMethod: "sha256_pair_id_within_source_business_kind";
  targetRatio: number;
  pairIds: string[];
  strata: Record<string, { total: number; holdout: number }>;
}

export function buildMatchingV3PairHoldoutManifest(input: {
  tasks: MatchingV3PairReviewTask[];
  targetRatio?: number;
  createdAt?: Date;
}): MatchingV3PairHoldoutManifest {
  const targetRatio = input.targetRatio ?? 0.3;
  if (!Number.isFinite(targetRatio) || targetRatio <= 0 || targetRatio >= 1) {
    throw new Error("targetRatio must be between 0 and 1 exclusive");
  }
  const createdAt = input.createdAt ?? new Date();
  if (Number.isNaN(createdAt.getTime())) throw new Error("createdAt must be valid");
  const ids = new Set<string>();
  const groups = new Map<string, MatchingV3PairReviewTask[]>();
  for (const task of input.tasks) {
    if (ids.has(task.pairId)) throw new Error(`duplicate pairId ${task.pairId}`);
    ids.add(task.pairId);
    const source = task.grantId.split(":")[0] ?? "unknown";
    const stratum = `${source}:${task.businessKind}`;
    const group = groups.get(stratum) ?? [];
    group.push(task);
    groups.set(stratum, group);
  }
  const pairIds: string[] = [];
  const strata: Record<string, { total: number; holdout: number }> = {};
  for (const [stratum, tasks] of [...groups.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const holdout = Math.max(1, Math.round(tasks.length * targetRatio));
    const selected = [...tasks].sort((left, right) => hash(left.pairId).localeCompare(hash(right.pairId))).slice(0, holdout);
    pairIds.push(...selected.map((task) => task.pairId));
    strata[stratum] = { total: tasks.length, holdout };
  }
  return {
    schemaVersion: "matching-v3-pair-holdout-v1",
    createdAt: createdAt.toISOString(),
    selectionMethod: "sha256_pair_id_within_source_business_kind",
    targetRatio,
    pairIds: pairIds.sort(),
    strata,
  };
}

export function applyPairHoldoutManifest(
  tasks: MatchingV3PairReviewTask[],
  manifest: MatchingV3PairHoldoutManifest,
): MatchingV3PairReviewTask[] {
  if (manifest.schemaVersion !== "matching-v3-pair-holdout-v1") throw new Error("invalid holdout manifest schemaVersion");
  const taskIds = new Set(tasks.map((task) => task.pairId));
  const holdoutIds = new Set<string>();
  for (const pairId of manifest.pairIds) {
    if (holdoutIds.has(pairId)) throw new Error(`duplicate holdout pairId ${pairId}`);
    if (!taskIds.has(pairId)) throw new Error(`unknown holdout pairId ${pairId}`);
    holdoutIds.add(pairId);
  }
  return tasks.map((task) => ({
    ...task,
    annotationTemplate: {
      ...task.annotationTemplate,
      split: holdoutIds.has(task.pairId) ? "holdout" : "development",
    },
  }));
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
