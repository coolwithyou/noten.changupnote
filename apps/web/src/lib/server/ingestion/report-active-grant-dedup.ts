import { eq } from "drizzle-orm";
import {
  findGrantDedupAssessments,
  grantDedupKey,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();
const asOf = dateArg(readArg("asOf")) ?? new Date();
const limit = boundedInteger(readArg("limit"), 2_000, 1, 5_000);
const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const entries = await repositories.grants.listActiveGrants({
    asOf,
    limit,
    includeConfirmedDuplicates: true,
  });
  const visibleEntries = await repositories.grants.listActiveGrants({ asOf, limit });
  const assessments = findGrantDedupAssessments(entries);
  const autoDuplicates = assessments.filter((item) => item.decision === "auto_duplicate");
  const review = assessments.filter((item) => item.decision === "review");
  const activeKeys = new Set(entries.map((entry) => grantDedupKey(entry.grant)));
  const confirmedRows = await db.select({
    canonicalGrantId: schema.dedupLinks.canonicalGrantId,
    memberGrantId: schema.dedupLinks.memberGrantId,
    score: schema.dedupLinks.score,
  }).from(schema.dedupLinks).where(eq(schema.dedupLinks.confirmed, true));
  const confirmedActive = confirmedRows.filter((row) =>
    activeKeys.has(row.canonicalGrantId) && activeKeys.has(row.memberGrantId));
  const confirmedPairs = new Set(confirmedActive.map((row) => pairKey(row.canonicalGrantId, row.memberGrantId)));
  const duplicateExcessCount = connectedDuplicateExcess(autoDuplicates.map((item) => [item.leftGrantKey, item.rightGrantKey]));
  const confirmedAutoPairCount = autoDuplicates.filter((item) =>
    confirmedPairs.has(pairKey(item.leftGrantKey, item.rightGrantKey))).length;
  const entryByKey = new Map(entries.map((entry) => [grantDedupKey(entry.grant), entry]));

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    activeGrantCountIncludingConfirmedMembers: entries.length,
    activeGrantCountAfterConfirmedSuppression: visibleEntries.length,
    confirmedSuppressedOccurrenceCount: entries.length - visibleEntries.length,
    sourceCounts: histogram(entries.map((entry) => entry.grant.source)),
    decisionCounts: {
      auto_duplicate: autoDuplicates.length,
      review: review.length,
    },
    autoDuplicateExcessCount: duplicateExcessCount,
    estimatedDuplicateCardExposureRate: ratio(duplicateExcessCount, entries.length),
    confirmedActiveLinkCount: confirmedActive.length,
    confirmedAutoPairCount,
    unconfirmedAutoPairCount: autoDuplicates.length - confirmedAutoPairCount,
    gate: {
      maximumDuplicateCardExposureRate: 0.01,
      exposureGatePassed: ratio(duplicateExcessCount, entries.length) < 0.01,
      publicationReady: autoDuplicates.length === confirmedAutoPairCount,
    },
    candidates: assessments.slice(0, 100).map((item) => ({
      leftGrantKey: item.leftGrantKey,
      leftTitle: entryByKey.get(item.leftGrantKey)?.grant.title ?? null,
      leftSource: entryByKey.get(item.leftGrantKey)?.grant.source ?? null,
      rightGrantKey: item.rightGrantKey,
      rightTitle: entryByKey.get(item.rightGrantKey)?.grant.title ?? null,
      rightSource: entryByKey.get(item.rightGrantKey)?.grant.source ?? null,
      decision: item.decision,
      confirmed: confirmedPairs.has(pairKey(item.leftGrantKey, item.rightGrantKey)),
      relation: item.relation,
      score: item.score,
      reasons: item.reasons,
      conflicts: {
        year: item.signals.yearConflict,
        round: item.signals.roundConflict,
        schedule: item.signals.scheduleConflict,
      },
    })),
    reminders: [
      "auto_duplicate만 confirmed link 자동 승격 대상이다",
      "review 후보와 extension/reannouncement는 사람 확인 전 숨기지 않는다",
      "confirmed member만 사용자 활성 목록에서 제외한다",
    ],
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function connectedDuplicateExcess(edges: Array<[string, string]>): number {
  const parent = new Map<string, string>();
  const find = (value: string): string => {
    const current = parent.get(value) ?? value;
    if (current === value) return value;
    const root = find(current);
    parent.set(value, root);
    return root;
  };
  for (const [left, right] of edges) {
    const leftRoot = find(left);
    const rightRoot = find(right);
    parent.set(left, leftRoot);
    parent.set(right, rightRoot);
    if (leftRoot !== rightRoot) parent.set(rightRoot, leftRoot);
  }
  const groups = new Map<string, number>();
  for (const value of parent.keys()) {
    const root = find(value);
    groups.set(root, (groups.get(root) ?? 0) + 1);
  }
  return [...groups.values()].reduce((sum, size) => sum + Math.max(0, size - 1), 0);
}

function pairKey(left: string, right: string): string {
  return [left, right].sort().join("\u0000");
}
function histogram(values: string[]): Record<string, number> {
  const result: Record<string, number> = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}
function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`--limit must be ${min}..${max}`);
  return parsed;
}
function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --asOf: ${value}`);
  return date;
}
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
