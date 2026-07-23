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
import { normalizeGrantLlmCriteria } from "@cunote/core";
import type { LabCriterion, LabReview, LabRun } from "@/features/dev/analysis-lab/contract";

export const ANALYSIS_LAB_SHADOW_SOURCE_PREFIX = "lab-shadow";
export const ANALYSIS_LAB_SHADOW_PARSER_VERSION = "analysis-lab-shadow-v1";
/** 변환 산출 criterion 의 source_field — 현행 파이프라인 산출과 육안 구분용. */
export const ANALYSIS_LAB_SHADOW_SOURCE_FIELD = "analysis_lab_deep";

/** 공고(런) 1건의 변환 보고 — 손실을 은폐하지 않고 전량 집계한다. */
export interface ShadowConversionReport {
  grantId: string;
  runId: string;
  /** 검수 verdict 별 건수. correct 만 변환 대상이다. */
  verdicts: { correct: number; needs_edit: number; wrong: number; unsure: number };
  /** axisReviews 의 missed_condition 수 — 섀도 미반영(하한 추정 caveat 재료). */
  missedConditions: number;
  /** correct 중 run.criteria 인덱스가 유효해 변환 입력 row 가 된 수. */
  inputRows: number;
  /** 변환 산출 criterion 수(강등 포함). */
  converted: number;
  /** 강등(other/text_only 다운그레이드 또는 region 방어) 수 — needs_review=true 산출분. */
  downgraded: number;
  /** 탈락(normalize 가 null 반환) 수. 변환 전체 실패(error≠null) 시엔 입력 전량. */
  dropped: number;
  /** assertGrantCriteriaContract 등 변환 전체 실패 사유 — 공고 단위로 격리한다. */
  error: string | null;
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
  return {
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value,
    confidence: criterion.confidence,
    ...(criterion.sourceSpan ? { source_span: criterion.sourceSpan } : {}),
    source_field: ANALYSIS_LAB_SHADOW_SOURCE_FIELD,
    needs_review: needsReview,
  };
}

export interface LabCriterionSelection {
  criterionIndex: number;
  needsReview: boolean;
}

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
  run: LabRun,
  input: {
    selections: LabCriterionSelection[];
    verdicts?: ShadowConversionReport["verdicts"];
    missedConditions?: number;
  },
): ShadowConversionResult {
  const rows = input.selections.flatMap(({ criterionIndex, needsReview }) => {
    const criterion = run.criteria[criterionIndex];
    return criterion ? [toLlmRow(criterion, needsReview)] : [];
  });

  let criteria: GrantCriterion[] = [];
  let error: string | null = null;
  try {
    criteria = normalizeGrantLlmCriteria({ criteria: rows }, run.sourceId, {
      sourcePrefix: ANALYSIS_LAB_SHADOW_SOURCE_PREFIX,
      parserVersion: ANALYSIS_LAB_SHADOW_PARSER_VERSION,
      contractLabel: `lab-shadow:${run.sourceId}`,
      forceNeedsReview: false,
    });
  } catch (caught) {
    criteria = [];
    error = caught instanceof Error ? caught.message : String(caught);
  }

  // 강등 판별: 정상 변환분은 needs_review=false(위 계약), 강등 3경로(M4 예약축·M1 span
  // 부재·region 방어)는 모두 needs_review=true 로 산출된다 — 값 하나로 판별 가능.
  const downgraded = criteria.filter((criterion) => criterion.needs_review === true).length;

  return {
    criteria,
    report: {
      grantId: run.grantId,
      runId: run.runId,
      verdicts: input.verdicts ?? {
        correct: input.selections.filter((item) => !item.needsReview).length,
        needs_edit: 0,
        wrong: 0,
        unsure: input.selections.filter((item) => item.needsReview).length,
      },
      missedConditions: input.missedConditions ?? 0,
      inputRows: rows.length,
      converted: criteria.length,
      downgraded,
      dropped: error === null ? rows.length - criteria.length : rows.length,
      error,
    },
  };
}
