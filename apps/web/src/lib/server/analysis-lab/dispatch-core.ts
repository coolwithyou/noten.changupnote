import { createHash } from "node:crypto";
import type {
  LabAudit,
  LabAuditItem,
  LabRun,
} from "@/features/dev/analysis-lab/contract";
import { isAiAuditConcur } from "@/features/dev/analysis-lab/contract";
import type { AuditSourceAiReview } from "./audit-store";

export type DispatchCollectTarget = "audit_file" | "overlay";
export type DispatchItemKind = "criterion" | "axis" | "question_check";

export interface DispatchCandidateItem {
  sourceItemKey: string;
  collectTarget: DispatchCollectTarget;
  itemKind: DispatchItemKind;
  criterionIndex: number | null;
  dimension: string | null;
  payload: Record<string, unknown>;
}

export interface DispatchNoticeCandidate {
  run: LabRun;
  review: AuditSourceAiReview;
  audit: LabAudit | null;
  items: DispatchCandidateItem[];
}

export interface DispatchAssignment {
  noticeIndex: number;
  item: DispatchCandidateItem;
  reviewerIndex: number;
  blind: boolean;
  overlapGroup: string | null;
}

export function excludePreviouslyDispatched(
  runId: string,
  items: DispatchCandidateItem[],
  distributedKeys: ReadonlySet<string>,
): DispatchCandidateItem[] {
  return items.filter((item) => !distributedKeys.has(`${runId}:${item.sourceItemKey}`));
}

/** 신규 확인 질문은 주간 전체에서 결정론적으로 N건만 뽑고 나머지 검수 항목은 유지한다. */
export function limitQuestionSpotchecks(
  notices: DispatchNoticeCandidate[],
  options: { seed: number; limit: number },
): DispatchNoticeCandidate[] {
  const candidates = notices.flatMap((notice, noticeIndex) =>
    notice.items
      .filter((item) => item.itemKind === "question_check")
      .map((item) => ({
        noticeIndex,
        key: `${notice.run.runId}:${item.sourceItemKey}`,
        rank: seededRank(options.seed ^ 0x71c3a5d9, `${notice.run.runId}:${item.sourceItemKey}`),
      })));
  const selected = new Set(
    candidates
      .sort((left, right) => left.rank - right.rank || left.key.localeCompare(right.key))
      .slice(0, Math.max(0, options.limit))
      .map((item) => item.key),
  );
  return notices.flatMap((notice) => {
    const items = notice.items.filter((item) =>
      item.itemKind !== "question_check"
      || selected.has(`${notice.run.runId}:${item.sourceItemKey}`));
    return items.length > 0 ? [{ ...notice, items }] : [];
  });
}

export function buildDispatchCandidateItems(input: {
  run: LabRun;
  review: AuditSourceAiReview;
  audit: LabAudit | null;
}): DispatchCandidateItem[] {
  const result: DispatchCandidateItem[] = [];
  const frozenCriterionIndexes = new Set<number>();
  const frozenAxisDimensions = new Set<string>();

  for (const auditItem of input.audit?.items ?? []) {
    if (auditItem.humanVerdict !== null || isAiAuditConcur(auditItem)) continue;
    const item = auditDispatchItem(input.run, auditItem);
    result.push(item);
    if (auditItem.kind === "criterion" && auditItem.criterionIndex !== undefined) {
      frozenCriterionIndexes.add(auditItem.criterionIndex);
    }
    if (auditItem.kind === "axis" && auditItem.dimension) frozenAxisDimensions.add(auditItem.dimension);
  }

  const reviewByCriterion = new Map(
    input.review.criterionReviews.map((item) => [item.criterionIndex, item]),
  );
  for (const [criterionIndex, criterion] of input.run.criteria.entries()) {
    if (!frozenCriterionIndexes.has(criterionIndex)) {
      const reasons: string[] = [];
      if (
        criterion.spanVerified === false
        && (criterion.kind === "required" || criterion.kind === "exclusion")
      ) reasons.push("span_unverified");
      if (criterion.confidence < 0.6) reasons.push("low_confidence");
      if (reasons.length > 0) {
        result.push({
          sourceItemKey: `overlay:c:${criterionIndex}`,
          collectTarget: "overlay",
          itemKind: "criterion",
          criterionIndex,
          dimension: criterion.dimension,
          payload: {
            reasons,
            criterion,
            aiReview: reviewByCriterion.get(criterionIndex) ?? null,
          },
        });
      }
    }
    if (criterion.confirmation) {
      result.push({
        sourceItemKey: `overlay:q:${criterionIndex}`,
        collectTarget: "overlay",
        itemKind: "question_check",
        criterionIndex,
        dimension: criterion.dimension,
        payload: {
          reason: "confirmation_spotcheck",
          criterion: {
            dimension: criterion.dimension,
            kind: criterion.kind,
            operator: criterion.operator,
            value: criterion.value,
            sourceSpan: criterion.sourceSpan,
          },
          confirmation: criterion.confirmation,
        },
      });
    }
  }

  for (const axis of input.review.axisReviews) {
    if (axis.verdict !== "missed_condition" || frozenAxisDimensions.has(axis.dimension)) continue;
    result.push({
      sourceItemKey: `overlay:a:${axis.dimension}`,
      collectTarget: "overlay",
      itemKind: "axis",
      criterionIndex: null,
      dimension: axis.dimension,
      payload: { reason: "missed_condition", aiReview: axis },
    });
  }

  return result.sort((left, right) => left.sourceItemKey.localeCompare(right.sourceItemKey));
}

function auditDispatchItem(run: LabRun, item: LabAuditItem): DispatchCandidateItem {
  if (item.kind === "criterion") {
    const criterionIndex = item.criterionIndex ?? -1;
    return {
      sourceItemKey: `audit:c:${criterionIndex}`,
      collectTarget: "audit_file",
      itemKind: "criterion",
      criterionIndex,
      dimension: run.criteria[criterionIndex]?.dimension ?? null,
      payload: {
        reason: item.reason,
        criterion: run.criteria[criterionIndex] ?? null,
        aiVerdict: item.aiVerdict,
        aiNote: item.aiNote,
        aiAuditVerdict: item.aiAuditVerdict ?? null,
        aiAuditNote: item.aiAuditNote ?? null,
      },
    };
  }
  return {
    sourceItemKey: `audit:a:${item.dimension ?? "unknown"}`,
    collectTarget: "audit_file",
    itemKind: "axis",
    criterionIndex: null,
    dimension: item.dimension ?? null,
    payload: {
      reason: item.reason,
      aiVerdict: item.aiVerdict,
      aiNote: item.aiNote,
      aiAuditVerdict: item.aiAuditVerdict ?? null,
      aiAuditNote: item.aiAuditNote ?? null,
    },
  };
}

export function assignDispatchCandidates(
  notices: DispatchNoticeCandidate[],
  options: { seed: number; reviewerCount: number; overlapRatio: number },
): DispatchAssignment[] {
  if (options.reviewerCount < 1) throw new Error("reviewerCount는 1 이상이어야 합니다.");
  const ranked = notices
    .map((notice, noticeIndex) => ({
      noticeIndex,
      itemCount: notice.items.length,
      tie: seededRank(options.seed, notice.run.runId),
    }))
    .sort((left, right) =>
      right.itemCount - left.itemCount
      || left.tie - right.tie
      || left.noticeIndex - right.noticeIndex);
  const loads = Array.from({ length: options.reviewerCount }, () => 0);
  const primaryByNotice = new Map<number, number>();
  for (const entry of ranked) {
    let reviewerIndex = 0;
    for (let index = 1; index < loads.length; index += 1) {
      if (loads[index]! < loads[reviewerIndex]!) reviewerIndex = index;
    }
    primaryByNotice.set(entry.noticeIndex, reviewerIndex);
    loads[reviewerIndex]! += entry.itemCount;
  }

  const overlapCount =
    notices.length === 0 || options.reviewerCount < 2 || options.overlapRatio <= 0
      ? 0
      : Math.max(1, Math.round(notices.length * options.overlapRatio));
  const overlapNotices = new Set(
    notices
      .map((notice, noticeIndex) => ({
        noticeIndex,
        rank: seededRank(options.seed ^ 0x5f3759df, notice.run.runId),
      }))
      .sort((left, right) => left.rank - right.rank)
      .slice(0, Math.min(overlapCount, notices.length))
      .map((entry) => entry.noticeIndex),
  );

  const assignments: DispatchAssignment[] = [];
  for (const [noticeIndex, notice] of notices.entries()) {
    const primary = primaryByNotice.get(noticeIndex) ?? 0;
    for (const item of notice.items) {
      const overlapping = overlapNotices.has(noticeIndex);
      const overlapGroup = overlapping
        ? deterministicUuid(`${options.seed}:${notice.run.runId}:${item.sourceItemKey}`)
        : null;
      assignments.push({
        noticeIndex,
        item,
        reviewerIndex: primary,
        blind: overlapping,
        overlapGroup,
      });
      if (overlapping) {
        assignments.push({
          noticeIndex,
          item,
          reviewerIndex: (primary + 1) % options.reviewerCount,
          blind: true,
          overlapGroup,
        });
      }
    }
  }
  return assignments;
}

export interface AgreementMetric {
  itemKind: string;
  pairCount: number;
  agreementRate: number | null;
  kappa: number | null;
  categoryDistribution: Record<string, number>;
}

export function computeAgreementMetrics(rows: Array<{
  itemKind: string;
  overlapGroup: string | null;
  humanVerdict: string | null;
  raterKey?: string;
}>): AgreementMetric[] {
  const byKind = new Map<string, Map<string, Array<{ verdict: string; raterKey: string }>>>();
  for (const [rowIndex, row] of rows.entries()) {
    if (!row.overlapGroup || !row.humanVerdict) continue;
    const groups = byKind.get(row.itemKind) ?? new Map<string, Array<{ verdict: string; raterKey: string }>>();
    const decisions = groups.get(row.overlapGroup) ?? [];
    decisions.push({ verdict: row.humanVerdict, raterKey: row.raterKey ?? String(rowIndex) });
    groups.set(row.overlapGroup, decisions);
    byKind.set(row.itemKind, groups);
  }

  return [...byKind.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([itemKind, groups]) => {
    const pairs = [...groups.values()]
      .filter((values) => values.length === 2)
      .map((values) => values.sort((left, right) => left.raterKey.localeCompare(right.raterKey)))
      .map((values) => [values[0]!.verdict, values[1]!.verdict] as [string, string]);
    const distribution: Record<string, number> = {};
    let agreements = 0;
    const leftDistribution: Record<string, number> = {};
    const rightDistribution: Record<string, number> = {};
    for (const [left, right] of pairs) {
      distribution[left] = (distribution[left] ?? 0) + 1;
      distribution[right] = (distribution[right] ?? 0) + 1;
      leftDistribution[left] = (leftDistribution[left] ?? 0) + 1;
      rightDistribution[right] = (rightDistribution[right] ?? 0) + 1;
      if (left === right) agreements += 1;
    }
    if (pairs.length === 0) {
      return {
        itemKind,
        pairCount: 0,
        agreementRate: null,
        kappa: null,
        categoryDistribution: distribution,
      };
    }
    const observed = agreements / pairs.length;
    const categories = new Set([...Object.keys(leftDistribution), ...Object.keys(rightDistribution)]);
    let expected = 0;
    for (const category of categories) {
      expected +=
        ((leftDistribution[category] ?? 0) / pairs.length)
        * ((rightDistribution[category] ?? 0) / pairs.length);
    }
    const denominator = 1 - expected;
    return {
      itemKind,
      pairCount: pairs.length,
      agreementRate: observed,
      kappa: denominator === 0 ? null : (observed - expected) / denominator,
      categoryDistribution: distribution,
    };
  });
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function seededRank(seed: number, value: string): number {
  const digest = createHash("sha256").update(`${seed}:${value}`).digest();
  return digest.readUInt32BE(0);
}

function deterministicUuid(material: string): string {
  const hex = createHash("sha256").update(material).digest("hex").slice(0, 32).split("");
  hex[12] = "4";
  hex[16] = ["8", "9", "a", "b"][Number.parseInt(hex[16]!, 16) % 4]!;
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}
