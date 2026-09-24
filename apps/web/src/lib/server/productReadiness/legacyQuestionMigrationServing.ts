import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
} from "../analysis-serving/promotionSnapshot";

export interface LegacyQuestionMigrationServingRow {
  readonly releaseDbId: string;
  readonly parentPromotionItemId: string | null;
  readonly grantId: string;
  readonly releaseStatus: string;
  readonly itemStatus: string;
  readonly servingStateSha256: string | null;
  readonly appliedAt: Date | null;
}

export interface LegacyQuestionMigrationServingState {
  readonly parentPromotionItemId: string;
  readonly grantId: string;
  readonly servingStateSha256: string;
  readonly appliedAt: Date;
}

export interface LegacyQuestionMigrationQuestionCandidate {
  readonly questionId: string;
  readonly grantId: string;
  readonly criterionId: string;
  readonly reusable: string;
}

export interface VerifiedLegacyQuestionMigrationBinding {
  readonly questionId: string;
  readonly grantId: string;
  readonly criterionId: string;
  readonly parentPromotionItemId: string;
  readonly parentRunId: string;
  readonly resolutionScope: "per_notice" | "company_fact";
}

/**
 * 같은 promotion parent에 여러 제한 이관이 이어질 수 있으므로 가장 최근 applied successor만
 * serving frontier로 삼는다. 최신 시각이 겹치면 임의 선택하지 않고 해당 parent를 닫는다.
 */
export function resolveLegacyQuestionMigrationServingStates(
  rows: readonly LegacyQuestionMigrationServingRow[],
): Map<string, LegacyQuestionMigrationServingState> {
  const grouped = new Map<string, Map<string, LegacyQuestionMigrationServingRow[]>>();
  for (const row of rows) {
    if (
      !row.parentPromotionItemId
      || row.releaseStatus !== "active"
      || row.itemStatus !== "applied"
      || !row.servingStateSha256
      || !/^[a-f0-9]{64}$/u.test(row.servingStateSha256)
      || !row.appliedAt
    ) continue;
    const releases = grouped.get(row.parentPromotionItemId) ?? new Map();
    const values = releases.get(row.releaseDbId) ?? [];
    values.push(row);
    releases.set(row.releaseDbId, values);
    grouped.set(row.parentPromotionItemId, releases);
  }
  const result = new Map<string, LegacyQuestionMigrationServingState>();
  for (const [parentPromotionItemId, releases] of grouped) {
    const candidates = [...releases.values()].flatMap((items) => {
      const first = items[0]!;
      if (items.some((item) =>
        item.grantId !== first.grantId
        || item.servingStateSha256 !== first.servingStateSha256)) return [];
      return [{
        ...first,
        appliedAt: new Date(Math.max(...items.map((item) => item.appliedAt!.getTime()))),
      }];
    });
    const ordered = candidates.sort((left, right) =>
      right.appliedAt.getTime() - left.appliedAt.getTime());
    const newest = ordered[0];
    if (
      !newest
      || ordered[1]?.appliedAt.getTime() === newest.appliedAt.getTime()
    ) continue;
    result.set(parentPromotionItemId, {
      parentPromotionItemId,
      grantId: newest.grantId,
      servingStateSha256: newest.servingStateSha256!,
      appliedAt: newest.appliedAt,
    });
  }
  return result;
}

export async function loadLegacyQuestionMigrationServingStates(
  db: CunoteDbSession,
  parentPromotionItemIds: readonly string[],
): Promise<Map<string, LegacyQuestionMigrationServingState>> {
  const ids = [...new Set(parentPromotionItemIds)];
  if (ids.length === 0) return new Map();
  const rows = await db.select({
    releaseDbId: schema.analysisLabLegacyQuestionMigrationItems.releaseDbId,
    parentPromotionItemId: schema.analysisLabLegacyQuestionMigrationItems.parentPromotionItemId,
    grantId: schema.analysisLabLegacyQuestionMigrationItems.grantId,
    releaseStatus: schema.analysisLabPromotionReleases.status,
    itemStatus: schema.analysisLabLegacyQuestionMigrationItems.status,
    servingStateSha256: schema.analysisLabLegacyQuestionMigrationItems.servingStateSha256,
    appliedAt: schema.analysisLabLegacyQuestionMigrationItems.appliedAt,
  }).from(schema.analysisLabLegacyQuestionMigrationItems)
    .innerJoin(
      schema.analysisLabPromotionReleases,
      eq(
        schema.analysisLabPromotionReleases.id,
        schema.analysisLabLegacyQuestionMigrationItems.releaseDbId,
      ),
    )
    .where(and(
      inArray(schema.analysisLabLegacyQuestionMigrationItems.parentPromotionItemId, ids),
      eq(schema.analysisLabLegacyQuestionMigrationItems.status, "applied"),
      eq(schema.analysisLabPromotionReleases.status, "active"),
      isNotNull(schema.analysisLabLegacyQuestionMigrationItems.servingStateSha256),
    ))
    .orderBy(desc(schema.analysisLabLegacyQuestionMigrationItems.appliedAt));
  return resolveLegacyQuestionMigrationServingStates(rows);
}

/**
 * 일반 question provenance를 우회하지 않고, 제한 이관 원장과 현재 serving frontier가 exact로
 * 일치하는 successor만 사용자 답변 가능한 matcher 결속으로 올린다.
 */
export async function loadVerifiedLegacyQuestionMigrationBindings(
  db: CunoteDbSession,
  candidates: readonly LegacyQuestionMigrationQuestionCandidate[],
): Promise<Map<string, VerifiedLegacyQuestionMigrationBinding>> {
  const candidateByQuestionId = new Map(candidates.flatMap((candidate) => (
    (candidate.reusable === "per_notice" || candidate.reusable === "company_fact")
      ? [[candidate.questionId, candidate] as const]
      : []
  )));
  const questionIds = [...candidateByQuestionId.keys()];
  if (questionIds.length === 0) return new Map();

  const migrationRows = await db.select({
    releaseDbId: schema.analysisLabLegacyQuestionMigrationItems.releaseDbId,
    releaseStatus: schema.analysisLabPromotionReleases.status,
    itemStatus: schema.analysisLabLegacyQuestionMigrationItems.status,
    questionId: schema.analysisLabLegacyQuestionMigrationItems.migratedQuestionId,
    grantId: schema.analysisLabLegacyQuestionMigrationItems.grantId,
    criterionId: schema.analysisLabLegacyQuestionMigrationItems.criterionId,
    parentPromotionItemId: schema.analysisLabLegacyQuestionMigrationItems.parentPromotionItemId,
  }).from(schema.analysisLabLegacyQuestionMigrationItems)
    .innerJoin(
      schema.analysisLabPromotionReleases,
      eq(
        schema.analysisLabPromotionReleases.id,
        schema.analysisLabLegacyQuestionMigrationItems.releaseDbId,
      ),
    )
    .where(and(
      inArray(schema.analysisLabLegacyQuestionMigrationItems.migratedQuestionId, questionIds),
      eq(schema.analysisLabLegacyQuestionMigrationItems.status, "applied"),
      eq(schema.analysisLabPromotionReleases.status, "active"),
      isNotNull(schema.analysisLabLegacyQuestionMigrationItems.parentPromotionItemId),
    ));
  const rowsByQuestionId = new Map<string, typeof migrationRows>();
  for (const row of migrationRows) {
    if (!row.questionId) continue;
    rowsByQuestionId.set(row.questionId, [...(rowsByQuestionId.get(row.questionId) ?? []), row]);
  }
  const exactRows = [...rowsByQuestionId.entries()].flatMap(([questionId, rows]) => {
    const candidate = candidateByQuestionId.get(questionId);
    if (!candidate || rows.length !== 1) return [];
    const row = rows[0]!;
    return row.parentPromotionItemId
      && row.grantId === candidate.grantId
      && row.criterionId === candidate.criterionId
      ? [{ row, candidate }]
      : [];
  });
  if (exactRows.length === 0) return new Map();

  const grantIds = [...new Set(exactRows.map(({ row }) => row.grantId))];
  const parentRows = await db.select({
    parentPromotionItemId: schema.analysisLabPromotionItems.id,
    grantId: schema.analysisLabPromotionItems.grantId,
    runId: schema.analysisLabPromotionItems.runId,
    itemStatus: schema.analysisLabPromotionItems.status,
    rolledBackAt: schema.analysisLabPromotionItems.rolledBackAt,
    releaseStatus: schema.analysisLabPromotionReleases.status,
  }).from(schema.analysisLabPromotionItems)
    .innerJoin(
      schema.analysisLabPromotionReleases,
      eq(schema.analysisLabPromotionReleases.id, schema.analysisLabPromotionItems.releaseDbId),
    )
    .where(and(
      inArray(schema.analysisLabPromotionItems.grantId, grantIds),
      eq(schema.analysisLabPromotionItems.status, "applied"),
      inArray(schema.analysisLabPromotionReleases.status, ["active", "canary_passed"]),
    ));
  const uniqueParentByGrant = new Map<string, (typeof parentRows)[number]>();
  for (const grantId of grantIds) {
    const rows = parentRows.filter((row) => row.grantId === grantId && row.rolledBackAt === null);
    if (rows.length === 1) uniqueParentByGrant.set(grantId, rows[0]!);
  }
  const parentIds = [...new Set(exactRows.map(({ row }) => row.parentPromotionItemId!))];
  const successorStates = await loadLegacyQuestionMigrationServingStates(db, parentIds);
  const confirmedLinks = await db.select({
    canonicalGrantId: schema.dedupLinks.canonicalGrantId,
    memberGrantId: schema.dedupLinks.memberGrantId,
  }).from(schema.dedupLinks).where(eq(schema.dedupLinks.confirmed, true));
  const currentStateByGrant = new Map(await Promise.all(grantIds.map(async (grantId) => {
    const snapshot = await loadPromotionGrantSnapshot(db, grantId, confirmedLinks);
    return [grantId, promotionGrantSnapshotStateSha256(snapshot)] as const;
  })));

  return new Map(exactRows.flatMap(({ row, candidate }) => {
    const parent = uniqueParentByGrant.get(row.grantId);
    const successor = successorStates.get(row.parentPromotionItemId!);
    const resolutionScope = candidate.reusable === "company_fact"
      ? "company_fact" as const
      : candidate.reusable === "per_notice"
        ? "per_notice" as const
        : null;
    if (
      !resolutionScope
      || !parent
      || parent.parentPromotionItemId !== row.parentPromotionItemId
      || !successor
      || successor.grantId !== row.grantId
      || successor.servingStateSha256 !== currentStateByGrant.get(row.grantId)
    ) return [];
    return [[candidate.questionId, {
      questionId: candidate.questionId,
      grantId: candidate.grantId,
      criterionId: candidate.criterionId,
      parentPromotionItemId: parent.parentPromotionItemId,
      parentRunId: parent.runId,
      resolutionScope,
    }] as const];
  }));
}

export function promotionStateMatchesParentOrMigration(input: {
  readonly currentStateSha256: string;
  readonly parentAfterSha256: string;
  readonly successor?: LegacyQuestionMigrationServingState | undefined;
  readonly grantId: string;
}): boolean {
  if (input.currentStateSha256 === input.parentAfterSha256) return true;
  return input.successor?.grantId === input.grantId
    && input.successor.servingStateSha256 === input.currentStateSha256;
}
