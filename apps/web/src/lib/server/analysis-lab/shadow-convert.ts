// 공모 딥분석 실험실 — 검수 확정 criterion → Grant criterion 변환기 (순수 함수, DB·fs·네트워크 미사용).
// 검수 verdict=correct 인 LabCriterion 만 normalizeGrantLlmCriteria(축별 value 정규화·
// canonicalize·M4/M1 강등·region 방어·계약 검증)를 통과시켜 매칭 엔진이 소비하는
// GrantCriterion[] 으로 바꾼다. 섀도 측정(shadow.ts)의 "후" 변형이자, 이후 golden_set
// 승격 트랙의 발행 어댑터로 재사용된다(계획 2026-07-22 §3).
//
// needs_review 의미(핵심): 사람 검수를 거쳤으므로 forceNeedsReview:false 로 통과시키고,
// row 에 needs_review 를 싣지 않아 정상 변환분은 needs_review=false 가 된다 —
// deferUnreviewedHardFail 이 hard-fail 을 유예하지 않아 exclusion 효과가 섀도에 그대로
// 드러난다(지표 4의 전제). 단 normalize 가 강등한 criterion(M4 예약축, M1 span 필수축의
// span 부재, region 코드 환원 실패)은 needs_review=true 로 나온다 — 그대로 두고 보고에
// 집계한다(변환 손실 무은폐 원칙, 계획 §3). 즉 출력의 needs_review=true ⇔ 강등이다.
//
// needs_edit/wrong/unsure 는 구조화된 수정값이 없어 변환하지 않고 건수만 보고한다.
// missed_condition(누락 조건)도 마찬가지 — 후 지표가 하한 추정인 이유(계획 §7).
import type { GrantCriterion } from "@cunote/contracts";
import { normalizeGrantLlmCriteria } from "@cunote/core/bizinfo/llm-criteria";
import {
  nonMatchingCriterionReason,
} from "@cunote/core/criteria/matching-scope";
import {
  criterionSemanticIdentity,
  readCriterionDowngradeProvenance,
} from "@cunote/core/criteria/semantic-identity";
import type { LabCriterion, LabReview, LabRun } from "@/lib/server/analysis-lab/lab-contract";
import {
  MATCHING_CONVERSION_CONTRACT_VERSION,
  inspectMatchingConversionReport,
  matchingConversionIsPromotionSafe,
  type MatchingConversionItemReport,
  type MatchingConversionItemStatus,
  type MatchingConversionReport,
} from "@/lib/server/analysis-serving/matchingConversionContract";

export const ANALYSIS_LAB_SHADOW_SOURCE_PREFIX = "lab-shadow";
export const ANALYSIS_LAB_SHADOW_PARSER_VERSION = "analysis-lab-shadow-v4";
export const ANALYSIS_LAB_SHADOW_CONVERSION_CONTRACT_VERSION =
  MATCHING_CONVERSION_CONTRACT_VERSION;
/** 변환 산출 criterion 의 source_field — 현행 파이프라인 산출과 육안 구분용. */
export const ANALYSIS_LAB_SHADOW_SOURCE_FIELD = "analysis_lab_deep";

export type ShadowConversionItemStatus = MatchingConversionItemStatus;
export type ShadowConversionItemReport = MatchingConversionItemReport;
export type ShadowConversionReport = MatchingConversionReport;
export const inspectShadowConversionReport = inspectMatchingConversionReport;
export const shadowConversionIsPromotionSafe = matchingConversionIsPromotionSafe;

/**
 * 역사 human/mixed release shadow는 scope 목록 도입 전부터 error 없음·drop 0을 허용했다.
 * 신규 v3는 공용 항목 accounting을 강제하되 진짜 무버전 report의 기존 shadow 정책만 보존한다.
 */
export function shadowConversionIsGenericReleaseSafe(
  input: Parameters<typeof matchingConversionIsPromotionSafe>[0],
): boolean {
  const legacy = input.report.contractVersion === undefined && input.report.items === undefined;
  return legacy
    ? input.report.error === null && input.report.dropped === 0
    : matchingConversionIsPromotionSafe(input);
}

export interface ShadowConversionResult {
  criteria: GrantCriterion[];
  report: ShadowConversionReport;
}

/**
 * LabCriterion(camelCase) → normalizeGrantLlmCriteria 가 기대하는 LLM row(snake_case).
 * needs_review 를 싣지 않는 것이 계약이다(위 모듈 주석) — Boolean(undefined)=false.
 */
function toLlmRow(criterion: LabCriterion, needsReview = false): Record<string, unknown> {
  const normalized = normalizeParentheticalTargetExclusion(criterion);
  return {
    dimension: normalized.dimension,
    kind: normalized.kind,
    operator: normalized.operator,
    value: normalized.value,
    confidence: normalized.confidence,
    ...(normalized.sourceSpan ? { source_span: normalized.sourceSpan } : {}),
    ...(normalized.note ? { note: normalized.note } : {}),
    source_field: ANALYSIS_LAB_SHADOW_SOURCE_FIELD,
    needs_review: needsReview || (
      normalized.dimension === "premises" && normalized.spanVerified !== true
    ),
  };
}

/**
 * "(중앙행정기관) 국토부, 행안부 … 등 참여불가"에서 `등`은 배제 유형을 더 여는 말이
 * 아니라 괄호 안 유형의 기관 예시를 더 여는 말이다. 괄호 유형 1개와 value target이
 * 정확히 일치하고 참여/신청 불가가 명시된 경우에만 exclusion 목록을 closed로 교정한다.
 */
function normalizeParentheticalTargetExclusion(criterion: LabCriterion): LabCriterion {
  if (
    criterion.dimension !== "target_type"
    || criterion.kind !== "exclusion"
    || criterion.operator !== "not_in"
    || !criterion.sourceSpan
  ) {
    return criterion;
  }
  const value = record(criterion.value);
  const targets = Array.isArray(value.targets)
    ? value.targets.filter((target): target is string => typeof target === "string" && target.trim().length > 0)
    : [];
  if (value.list_semantics !== "open" || targets.length !== 1) return criterion;

  const source = criterion.sourceSpan.normalize("NFC").replace(/\s+/g, " ").trim();
  const category = /^[-–—•·]?\s*\(([^)]+)\)/.exec(source)?.[1];
  if (!category || compact(category) !== compact(targets[0]!)) return criterion;
  if (!/(?:참여|신청|지원)\s*(?:이\s*)?(?:불가|금지|제외)/.test(source)) return criterion;

  return {
    ...criterion,
    value: { ...value, list_semantics: "closed" },
  };
}

function compact(value: string): string {
  return value.normalize("NFC").replace(/[\s·ㆍ_-]/g, "");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export interface LabCriterionSelection {
  criterionIndex: number;
  needsReview: boolean;
}

/** 실제 변환기가 필요한 최소 원천. primary 직후 projection이 완성 LabRun을 가장하지 않는다. */
export type LabMatchingProjectionSource = Pick<
  LabRun,
  "runId" | "grantId" | "sourceId" | "criteria"
>;

/**
 * 검수 확정 런 1건을 섀도 매칭용 GrantCriterion[] 으로 변환한다.
 * 계약 검증(assertGrantCriteriaContract)이 throw 하면 공고 단위로 실패를 report 에
 * 담고 빈 criteria 를 반환한다 — 전체 실행을 크래시시키지 않는다.
 */
export function convertReviewedLabRun(run: LabRun, review: LabReview): ShadowConversionResult {
  const verdicts = { correct: 0, needs_edit: 0, wrong: 0, unsure: 0 };
  const correctIndexes: number[] = [];
  for (const item of review.criterionReviews) {
    verdicts[item.verdict] += 1;
    if (item.verdict === "correct") correctIndexes.push(item.criterionIndex);
  }
  const missedConditions = review.axisReviews
    .filter((axis) => axis.verdict === "missed_condition").length;

  // 런은 불변이라 criterionIndex 가 안정 키다 — 범위 밖 인덱스는 방어적으로 건너뛴다.
  return convertSelectedLabCriteria(run, {
    selections: correctIndexes.map((criterionIndex) => ({ criterionIndex, needsReview: false })),
    verdicts,
    missedConditions,
  });
}

/**
 * criterion 해소 상태가 섞인 승격용 변환기. 확정/비감사 correct는 needs_review=false,
 * pending은 true로 같은 normalize 호출에 함께 넣어 순서와 llm-N id 매핑을 보존한다.
 */
export function convertSelectedLabCriteria(
  run: LabMatchingProjectionSource,
  input: {
    selections: LabCriterionSelection[];
    verdicts?: ShadowConversionReport["verdicts"];
    missedConditions?: number;
  },
): ShadowConversionResult {
  interface Candidate {
    criterionIndex: number;
    source: LabCriterion;
    projected: GrantCriterion;
    report: ShadowConversionItemReport;
  }
  const candidates: Candidate[] = [];
  const items: ShadowConversionItemReport[] = input.selections.map((selection, selectionPosition) => {
    const source = run.criteria[selection.criterionIndex];
    const base: ShadowConversionItemReport = {
      selectionPosition,
      criterionIndex: selection.criterionIndex,
      needsReview: selection.needsReview,
      status: "failed",
      reason: null,
      scopeReason: null,
      outputPosition: null,
      outputCriterionId: null,
      relatedCriterionIndexes: [],
      source: source
        ? { dimension: source.dimension, kind: source.kind, operator: source.operator }
        : null,
      projected: null,
    };
    if (!source) {
      base.reason = "criterion_index_out_of_range";
      return base;
    }

    const scopeReason = nonMatchingCriterionReason({
      dimension: source.dimension,
      operator: source.operator,
      kind: source.kind,
      value: source.value,
      note: source.note,
      source_span: source.sourceSpan,
    });
    if (scopeReason !== null) {
      base.status = "scope_rejected";
      base.reason = scopeReason;
      base.scopeReason = scopeReason;
      return base;
    }

    try {
      const normalized = normalizeGrantLlmCriteria({
        criteria: [toLlmRow(source, selection.needsReview)],
      }, run.sourceId, {
        sourcePrefix: ANALYSIS_LAB_SHADOW_SOURCE_PREFIX,
        parserVersion: ANALYSIS_LAB_SHADOW_PARSER_VERSION,
        contractLabel: `lab-shadow:${run.sourceId}:criterion-${selection.criterionIndex}`,
        forceNeedsReview: false,
      });
      if (normalized.length !== 1) {
        base.status = "dropped";
        base.reason = normalized.length === 0
          ? "normalizer_returned_no_criterion"
          : `normalizer_returned_${normalized.length}_criteria`;
        return base;
      }
      const projected: GrantCriterion = {
        ...normalized[0]!,
        // 산출 순번이 아니라 불변 원본 index를 id에 결속한다. 소비자는 이 문자열을 역산하지 않는다.
        id: `${ANALYSIS_LAB_SHADOW_SOURCE_PREFIX}:${run.sourceId}:llm-${selection.criterionIndex + 1}`,
      };
      const downgradeReason = conversionDowngradeReason(projected);
      base.status = downgradeReason === null ? "converted" : "downgraded";
      base.reason = downgradeReason;
      base.projected = {
        dimension: projected.dimension,
        kind: projected.kind,
        operator: projected.operator,
      };
      candidates.push({
        criterionIndex: selection.criterionIndex,
        source,
        projected,
        report: base,
      });
      return base;
    } catch (caught) {
      base.status = "failed";
      base.reason = caught instanceof Error ? caught.message : String(caught);
      return base;
    }
  });

  // normalize 후 의미가 완전히 같은 조건은 질문/provenance 중 하나를 임의 선택하지 않는다.
  // 양쪽을 명시 보류해 이후 검수가 어느 원본 index를 해소해야 하는지 보존한다.
  const duplicateGroups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = criterionSemanticIdentity(candidate.projected);
    const group = duplicateGroups.get(key) ?? [];
    group.push(candidate);
    duplicateGroups.set(key, group);
  }
  const heldCandidates = new Set<Candidate>();
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    const criterionIndexes = group.map((candidate) => candidate.criterionIndex);
    for (const candidate of group) {
      heldCandidates.add(candidate);
      candidate.report.status = "held_duplicate";
      candidate.report.reason = "duplicate_semantic_criterion";
      candidate.report.relatedCriterionIndexes = criterionIndexes.filter(
        (criterionIndex) => criterionIndex !== candidate.criterionIndex,
      );
      candidate.report.projected = null;
    }
  }

  const publishedCandidates = candidates.filter((candidate) => !heldCandidates.has(candidate));
  const criteria = publishedCandidates.map((candidate, outputPosition) => {
    candidate.report.outputPosition = outputPosition;
    candidate.report.outputCriterionId = candidate.projected.id ?? null;
    return candidate.projected;
  });
  const blockingItems = items.filter((item) => (
    item.status === "failed" || item.status === "held_duplicate"
  ));
  const error = blockingItems.length === 0
    ? null
    : blockingItems
        .map((item) => `criterion[${item.criterionIndex}]:${item.reason ?? item.status}`)
        .join("; ");
  const downgraded = items.filter((item) => item.status === "downgraded").length;
  const dropped = items.filter((item) => (
    item.status !== "converted" && item.status !== "downgraded"
  )).length;

  return {
    criteria,
    report: {
      contractVersion: ANALYSIS_LAB_SHADOW_CONVERSION_CONTRACT_VERSION,
      grantId: run.grantId,
      runId: run.runId,
      verdicts: input.verdicts ?? {
        correct: input.selections.filter((item) => !item.needsReview).length,
        needs_edit: 0,
        wrong: 0,
        unsure: input.selections.filter((item) => item.needsReview).length,
      },
      missedConditions: input.missedConditions ?? 0,
      inputRows: items.length,
      converted: criteria.length,
      downgraded,
      dropped,
      error,
      items,
    },
  };
}

function conversionDowngradeReason(projected: GrantCriterion): string | null {
  const provenance = readCriterionDowngradeProvenance(projected);
  if (!provenance) return null;
  const value = record(projected.value);
  return typeof value.downgrade_reason === "string" ? value.downgrade_reason : null;
}
