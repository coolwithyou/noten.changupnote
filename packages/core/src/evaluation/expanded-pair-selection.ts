import { createHash } from "node:crypto";
import type { MatchingV3PairReviewTask } from "./pair-review-packet.js";

export interface ExpandedPairSelection {
  tasks: MatchingV3PairReviewTask[];
  bySource: Record<string, number>;
  byBusinessKind: Record<string, number>;
  byPredictedEligibility: Record<string, number>;
  grantCoverage: number;
  companyCoverage: number;
}

export function selectExpandedPairReviewCandidates(input: {
  tasks: MatchingV3PairReviewTask[];
  targetCount?: number;
}): ExpandedPairSelection {
  const targetCount = input.targetCount ?? 500;
  if (!Number.isInteger(targetCount) || targetCount < 100 || targetCount > input.tasks.length) {
    throw new Error(`targetCount must be 100..${input.tasks.length}`);
  }
  const selected: MatchingV3PairReviewTask[] = [];
  const selectedIds = new Set<string>();
  const byGrant = groupBy(input.tasks, (task) => task.grantId);
  for (const tasks of byGrant.values()) add([...tasks].sort(compareHash)[0]!, selected, selectedIds);
  const coveredCompanies = new Set(selected.map((task) => task.companyId));
  const byCompany = groupBy(input.tasks, (task) => task.companyId);
  for (const [companyId, tasks] of byCompany) {
    if (!coveredCompanies.has(companyId)) add([...tasks].sort(compareHash)[0]!, selected, selectedIds);
  }
  const strata = groupBy(input.tasks.filter((task) => !selectedIds.has(task.pairId)), stratum);
  const queues = [...strata.entries()].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, tasks]) => ({ key, tasks: [...tasks].sort(compareHash), index: 0 }));
  while (selected.length < targetCount) {
    let added = false;
    for (const queue of queues) {
      const task = queue.tasks[queue.index];
      if (!task) continue;
      queue.index += 1;
      add(task, selected, selectedIds);
      added = true;
      if (selected.length >= targetCount) break;
    }
    if (!added) break;
  }
  if (selected.length !== targetCount) throw new Error(`could only select ${selected.length}/${targetCount} pairs`);
  return {
    tasks: selected.sort((left, right) => left.pairId.localeCompare(right.pairId)),
    bySource: histogram(selected.map((task) => source(task))),
    byBusinessKind: histogram(selected.map((task) => task.businessKind)),
    byPredictedEligibility: histogram(selected.map((task) => task.predictedEligibility)),
    grantCoverage: new Set(selected.map((task) => task.grantId)).size,
    companyCoverage: new Set(selected.map((task) => task.companyId)).size,
  };
}

function stratum(task: MatchingV3PairReviewTask): string {
  return `${source(task)}:${task.businessKind}:${task.predictedEligibility}`;
}
function source(task: MatchingV3PairReviewTask): string {
  return task.grantId.split(":")[0] ?? "unknown";
}
function compareHash(left: MatchingV3PairReviewTask, right: MatchingV3PairReviewTask): number {
  return hash(left.pairId).localeCompare(hash(right.pairId));
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function add(task: MatchingV3PairReviewTask, selected: MatchingV3PairReviewTask[], ids: Set<string>): void {
  if (ids.has(task.pairId)) return;
  ids.add(task.pairId);
  selected.push(task);
}
function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}
function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
