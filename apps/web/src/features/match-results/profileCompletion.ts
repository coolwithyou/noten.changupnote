import type { CriterionDimension, MatchingProfileAnswerRequest, MatchingProfileView } from "@cunote/contracts";

/** 제품 진입을 위한 공통 정보. 공고별 자격 조건이나 22축 전체의 완료율이 아니다. */
export const BASIC_PROFILE_DIMENSIONS = ["region", "industry", "biz_age", "target_type"] as const satisfies readonly CriterionDimension[];
export type ProfileInputState = "automatic" | "entered" | "absent" | "partial" | "unknown" | "missing" | "disputed";

export function profileInputState(
  row: MatchingProfileView["rows"][number] | undefined,
  answers: readonly MatchingProfileAnswerRequest[] = [],
): ProfileInputState {
  if (!row) return "missing";
  if (row.sourceDisputed) return "disputed";
  if (row.status === "known") {
    if (row.displayValue === "해당 없음") return "absent";
    return row.sourceKind === "self_declared" ? "entered" : "automatic";
  }
  let latest: MatchingProfileAnswerRequest | undefined;
  for (let index = answers.length - 1; index >= 0; index -= 1) {
    if (answers[index]?.field === row.dimension) { latest = answers[index]; break; }
  }
  if (latest?.unknown) return "unknown";
  return row.status === "partial" ? "partial" : "missing";
}

export const PROFILE_INPUT_STATE_LABELS: Record<ProfileInputState, string> = {
  automatic: "조회됨", entered: "직접 입력", absent: "해당 없음", partial: "일부 확인",
  unknown: "모름 · 미완료", missing: "미입력",
  disputed: "원천 정정 · 확인 필요",
};

export function buildProfileCompletion(view: MatchingProfileView) {
  const rows = new Map(view.rows.map((row) => [row.dimension, row]));
  const remaining = BASIC_PROFILE_DIMENSIONS.filter((dimension) => rows.get(dimension)?.status !== "known");
  const total = BASIC_PROFILE_DIMENSIONS.length;
  const completed = total - remaining.length;
  return { total, completed, percent: Math.round(completed / total * 100), remaining };
}
