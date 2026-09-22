import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";

export interface SourceRebindServingState {
  readonly parentPromotionItemId: string;
  readonly grantId: string;
  readonly rootSourceRevisionSha256: string;
  readonly rootSourceRawSha256: string;
  readonly sourceRevisionChain: readonly string[];
  readonly previousSourceRevisionSha256: string;
  readonly previousSourceRawSha256: string;
  readonly currentSourceRevisionSha256: string;
  readonly currentSourceRawSha256: string;
  readonly currentMaterialSourceRevisionSha256: string;
  readonly servingStateSha256: string;
  readonly appliedAt: Date;
}

interface SourceRebindServingRow extends Omit<
  SourceRebindServingState,
  "rootSourceRevisionSha256" | "rootSourceRawSha256" | "sourceRevisionChain"
> {
  readonly releaseStatus: string;
  readonly itemStatus: string;
}

/**
 * active/applied receipt가 하나의 분기 없는 revision chain을 이룰 때만 최신 frontier를 반환한다.
 * 같은 previous revision의 분기, 끊긴 chain, raw 연속성 파손은 parent 전체를 닫는다.
 */
export function resolveSourceRebindServingStates(
  rows: readonly SourceRebindServingRow[],
): Map<string, SourceRebindServingState> {
  const grouped = new Map<string, SourceRebindServingRow[]>();
  const invalidParents = new Set<string>();
  for (const row of rows) {
    if (
      row.releaseStatus !== "active"
      || row.itemStatus !== "applied"
      || !validSha(row.previousSourceRevisionSha256)
      || !validSha(row.previousSourceRawSha256)
      || !validSha(row.currentSourceRevisionSha256)
      || !validSha(row.currentSourceRawSha256)
      || !validSha(row.currentMaterialSourceRevisionSha256)
      || !validSha(row.servingStateSha256)
      || !(row.appliedAt instanceof Date)
    ) {
      invalidParents.add(row.parentPromotionItemId);
      continue;
    }
    grouped.set(row.parentPromotionItemId, [
      ...(grouped.get(row.parentPromotionItemId) ?? []),
      row,
    ]);
  }
  return new Map([...grouped].flatMap(([parentPromotionItemId, candidates]) => {
    if (invalidParents.has(parentPromotionItemId)) return [];
    const currentRevisions = new Set(candidates.map((candidate) => candidate.currentSourceRevisionSha256));
    const roots = candidates.filter((candidate) =>
      !currentRevisions.has(candidate.previousSourceRevisionSha256));
    const byPrevious = new Map<string, SourceRebindServingRow[]>();
    for (const candidate of candidates) {
      byPrevious.set(candidate.previousSourceRevisionSha256, [
        ...(byPrevious.get(candidate.previousSourceRevisionSha256) ?? []),
        candidate,
      ]);
    }
    if (roots.length !== 1 || [...byPrevious.values()].some((rows) => rows.length !== 1)) return [];
    const root = roots[0]!;
    const visited = new Set<string>();
    let row = root;
    const sourceRevisionChain = [root.previousSourceRevisionSha256];
    while (true) {
      if (visited.has(row.currentSourceRevisionSha256)) return [];
      visited.add(row.currentSourceRevisionSha256);
      sourceRevisionChain.push(row.currentSourceRevisionSha256);
      const nextRows = byPrevious.get(row.currentSourceRevisionSha256) ?? [];
      if (nextRows.length === 0) break;
      const next = nextRows[0]!;
      if (
        next.grantId !== root.grantId
        || next.previousSourceRawSha256 !== row.currentSourceRawSha256
        || next.currentMaterialSourceRevisionSha256 !== row.currentMaterialSourceRevisionSha256
        || next.appliedAt.getTime() < row.appliedAt.getTime()
      ) return [];
      row = next;
    }
    if (visited.size !== candidates.length) return [];
    return [[parentPromotionItemId, {
      parentPromotionItemId,
      grantId: row.grantId,
      rootSourceRevisionSha256: root.previousSourceRevisionSha256,
      rootSourceRawSha256: root.previousSourceRawSha256,
      sourceRevisionChain: Object.freeze(sourceRevisionChain),
      previousSourceRevisionSha256: row.previousSourceRevisionSha256,
      previousSourceRawSha256: row.previousSourceRawSha256,
      currentSourceRevisionSha256: row.currentSourceRevisionSha256,
      currentSourceRawSha256: row.currentSourceRawSha256,
      currentMaterialSourceRevisionSha256: row.currentMaterialSourceRevisionSha256,
      servingStateSha256: row.servingStateSha256,
      appliedAt: row.appliedAt,
    }] as const];
  }));
}

export async function loadSourceRebindServingStates(
  db: CunoteDbSession,
  parentPromotionItemIds: readonly string[],
): Promise<Map<string, SourceRebindServingState>> {
  const ids = [...new Set(parentPromotionItemIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    parentPromotionItemId: schema.analysisLabSourceRebindItems.parentPromotionItemId,
    grantId: schema.analysisLabSourceRebindItems.grantId,
    previousSourceRevisionSha256: schema.analysisLabSourceRebindItems.previousSourceRevisionSha256,
    previousSourceRawSha256: schema.analysisLabSourceRebindItems.previousSourceRawSha256,
    currentSourceRevisionSha256: schema.analysisLabSourceRebindItems.currentSourceRevisionSha256,
    currentSourceRawSha256: schema.analysisLabSourceRebindItems.currentSourceRawSha256,
    currentMaterialSourceRevisionSha256:
      schema.analysisLabSourceRebindItems.currentMaterialSourceRevisionSha256,
    servingStateSha256: schema.analysisLabSourceRebindItems.servingStateSha256,
    appliedAt: schema.analysisLabSourceRebindItems.appliedAt,
    releaseStatus: schema.analysisLabPromotionReleases.status,
    itemStatus: schema.analysisLabSourceRebindItems.status,
  }).from(schema.analysisLabSourceRebindItems)
    .innerJoin(
      schema.analysisLabPromotionReleases,
      eq(schema.analysisLabPromotionReleases.id, schema.analysisLabSourceRebindItems.releaseDbId),
    )
    .where(and(
      inArray(schema.analysisLabSourceRebindItems.parentPromotionItemId, ids),
      eq(schema.analysisLabSourceRebindItems.status, "applied"),
      eq(schema.analysisLabPromotionReleases.status, "active"),
      isNotNull(schema.analysisLabSourceRebindItems.servingStateSha256),
      isNotNull(schema.analysisLabSourceRebindItems.appliedAt),
    ));
  return resolveSourceRebindServingStates(rows as SourceRebindServingRow[]);
}

export function sourceRebindMatchesCurrent(input: {
  readonly state: SourceRebindServingState | undefined;
  readonly grantId: string;
  readonly currentStateSha256: string;
  readonly currentSourceRevisionSha256: string;
  readonly currentSourceRawSha256: string;
  readonly currentMaterialSourceRevisionSha256: string;
}): boolean {
  const state = input.state;
  return Boolean(state)
    && state!.grantId === input.grantId
    && state!.servingStateSha256 === input.currentStateSha256
    && state!.currentSourceRevisionSha256 === input.currentSourceRevisionSha256
    && state!.currentSourceRawSha256 === input.currentSourceRawSha256
    && state!.currentMaterialSourceRevisionSha256 === input.currentMaterialSourceRevisionSha256;
}

export function sourceRebindFrontierMatchesServingState(input: {
  readonly state: SourceRebindServingState | undefined;
  readonly grantId: string;
  readonly currentStateSha256: string;
}): boolean {
  return input.state?.grantId === input.grantId
    && input.state.servingStateSha256 === input.currentStateSha256;
}

function validSha(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}
