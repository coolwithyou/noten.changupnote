// 공모 딥분석 실험실 — 현재 DB grant_criteria(A) vs 딥분석 criteria(B) 축별 비교 (dev 전용).
// 비교는 JSON 정규화(키 정렬) 문자열 동치로 충분하다는 계약(contract.ts LabDimensionVerdict)을 따른다.
import { CRITERION_DIMENSIONS, type CriterionDimension } from "@cunote/contracts";
import type {
  LabAxisAssessment,
  LabCriterion,
  LabCurrentCriterion,
  LabDimensionDiff,
  LabDimensionVerdict,
} from "@/features/dev/analysis-lab/contract";

/**
 * 축 한국어 라벨 — packages/core/src/matching/match.ts 의 labelFor(비export)를 복제(dev 전용 허용).
 * 원천이 바뀌면 이 맵도 함께 갱신할 것.
 */
export const DIMENSION_LABELS: Record<CriterionDimension, string> = {
  region: "지역",
  biz_age: "업력",
  industry: "업종/분야",
  size: "기업규모",
  revenue: "매출",
  employees: "고용",
  founder_age: "대표자 연령",
  founder_trait: "대표자 속성",
  certification: "인증",
  prior_award: "기수혜",
  ip: "지식재산",
  target_type: "신청대상",
  business_status: "영업상태",
  tax_compliance: "세금 체납",
  credit_status: "신용 상태",
  sanction: "제재·참여제한",
  financial_health: "재무 건전성",
  insured_workforce: "고용보험 피보험자",
  investment: "투자 유치",
  premises: "사업장·입지",
  export_performance: "수출 실적",
  other: "기타",
};

export function computeLabDimensionDiffs(input: {
  current: LabCurrentCriterion[];
  proposed: LabCriterion[];
  assessments: LabAxisAssessment[];
}): LabDimensionDiff[] {
  const assessmentByDimension = new Map(
    input.assessments.map((assessment) => [assessment.dimension, assessment]),
  );
  return CRITERION_DIMENSIONS.map((dimension) => {
    const current = input.current.filter((criterion) => criterion.dimension === dimension);
    const proposed = input.proposed.filter((criterion) => criterion.dimension === dimension);
    return {
      dimension,
      label: DIMENSION_LABELS[dimension],
      current,
      proposed,
      assessment: assessmentByDimension.get(dimension) ?? null,
      verdict: computeVerdict(current, proposed),
    };
  });
}

function computeVerdict(
  current: LabCurrentCriterion[],
  proposed: LabCriterion[],
): LabDimensionVerdict {
  if (current.length === 0 && proposed.length === 0) return "none";
  if (current.length === 0) return "new";
  if (proposed.length === 0) return "only_current";
  // 양쪽 다 있으면 kind·operator·실질 value 의 정규화 키 "집합" 비교로 same/changed 판정(v2 보정).
  // 집합(중복 접기)인 이유: 현행 DB 에 동일 criterion 이 중복 적재된 사례가 있어(용인시 region 2건)
  // 멀티셋 비교는 형태 노이즈를 changed 로 과판정한다.
  const currentKeys = new Set(current.map((criterion) => essenceKey(criterion)));
  const proposedKeys = new Set(proposed.map((criterion) => essenceKey(criterion)));
  const same =
    currentKeys.size === proposedKeys.size &&
    [...currentKeys].every((key) => proposedKeys.has(key));
  return same ? "same" : "changed";
}

/**
 * 주석성 키(note/labels/basis)와 의미 없는 기본값(null·""·[]·{})을 걷어낸
 * "실질 값"으로 비교 키를 만든다(v2 보정). 예: region 의 {regions:["41"],labels:["경기"],nationwide:false}
 * 와 {regions:["41"],note:"…"} 는 실질 동일 → same.
 * false 는 원칙적으로 보존한다 — include_preliminary:false(예비창업자 제외 명시)처럼 부재와
 * 의미가 다른 키가 있기 때문. "부재 = false" 가 합의된 키만 예외로 떨어뜨린다(Codex 리뷰 M3).
 */
const ANNOTATION_KEYS = new Set(["note", "labels", "basis"]);
const DEFAULT_FALSE_KEYS = new Set(["nationwide"]);

function essenceKey(criterion: { kind: string; operator: string; value: unknown }): string {
  return stableStringify({
    kind: criterion.kind,
    operator: criterion.operator,
    value: essenceValue(criterion.value ?? null),
  });
}

function essenceValue(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => essenceValue(item));
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (ANNOTATION_KEYS.has(key)) continue;
    const entry = essenceValue(raw);
    if (entry === null || entry === undefined || entry === "") continue;
    if (entry === false && DEFAULT_FALSE_KEYS.has(key)) continue;
    if (Array.isArray(entry) && entry.length === 0) continue;
    if (typeof entry === "object" && !Array.isArray(entry) && Object.keys(entry).length === 0) {
      continue;
    }
    result[key] = entry;
  }
  return result;
}

/** 객체 키를 재귀 정렬해 직렬화(비교용 정규화). */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}
