import assert from "node:assert/strict";
import type { GrantCriterion } from "@cunote/contracts";
import {
  isNonMatchingApplicationCriterion,
  nonMatchingCriterionReason,
} from "./matching-scope.js";

assert.equal(
  nonMatchingCriterionReason(criterion(
    "허위 또는 과장된 정보 제출 시 선정 취소 및 향후 지원 제한 등의 불이익이 있을 수 있습니다.",
  )),
  "application_truthfulness_declaration",
);
assert.equal(
  nonMatchingCriterionReason(criterion("접수 마감일까지 계획서 등 제반서류를 제출 완료하지 않은 경우")),
  "application_document_procedure",
);
assert.equal(
  nonMatchingCriterionReason(criterion("지원신청서 및 계획서 내용과 수행내용이 상이할 경우")),
  "post_selection_obligation",
);
assert.equal(
  nonMatchingCriterionReason(criterion("협약서 등 관련 문서의 명시사항을 2회 이상 위반하거나 시정요구에 응하지 않을 경우")),
  "post_selection_obligation",
);
assert.equal(
  nonMatchingCriterionReason(criterion(
    "여타 정부·지자체 지원사업에 중복적인 지원 신청을 하지 않겠으며,",
    {
      dimension: "prior_award",
      operator: "exists",
      value: { scope: "self", self_kind: "same_year_other_support" },
    },
  )),
  "application_duplicate_support_declaration",
  "미래형 중복지원 미신청 확약은 현재 수혜 사실이 아니다",
);
assert.equal(
  nonMatchingCriterionReason(criterion(
    "다수의 사업자등록증(개인·법인)을 보유한 경우, 창업여부 기준표에 따라 신청 자격 적합여부 결정",
    { kind: "required" },
  )),
  "eligibility_calculation_instruction",
  "창업여부 계산 안내는 독립 required criterion이 아니다",
);
assert.equal(
  nonMatchingCriterionReason(criterion(
    "ㅇ 모집직무 : 경영·사무 / 광고·마케팅 / IT",
    { dimension: "industry", kind: "required" },
  )),
  "program_job_field",
  "모집직무는 신청기업 업종 자격조건이 아니다",
);
assert.equal(
  nonMatchingCriterionReason(criterion(
    "경영·사무 / 광고·마케팅 / IT 분야 고용보험 피보험자수 20인 이상 기업",
    {
      dimension: "industry",
      kind: "required",
      value: {
        note: "기업 업종 요건인지 청년 배치 직무분야인지 원문상 확정되지 않는다.",
      },
    },
  )),
  "unresolved_industry_job_field",
  "업종인지 직무인지 확정하지 못한 문구는 blocking 업종 criterion이 아니다",
);
assert.equal(
  nonMatchingCriterionReason(criterion(
    "참여기업 및 모집분야: 토스뱅크 포용금융, 현대홈쇼핑 혁신소재·기술 협업, 기타 협업 가능한 비즈니스",
    {
      dimension: "industry",
      operator: "text_only",
      kind: "required",
      value: { note: "수요기업별 협업 제안 주제" },
    },
  )),
  "program_collaboration_theme",
  "수요기업의 협업 모집 주제는 신청기업 업종 자격조건이 아니다",
);
assert.equal(
  nonMatchingCriterionReason(criterion(
    "정보통신업을 영위하는 중소기업만 신청할 수 있다.",
    {
      dimension: "industry",
      operator: "in",
      kind: "required",
      value: { tags: ["정보통신업"] },
    },
  )),
  null,
  "신청기업의 업종을 명시한 실제 자격조건은 보존한다",
);

assert.equal(
  isNonMatchingApplicationCriterion(criterion("정부지원사업 참여제한 중인 기업은 신청할 수 없음", {
    dimension: "sanction",
    operator: "in",
  })),
  false,
  "신청 시점에 이미 존재하는 제재 상태는 결격으로 보존한다",
);
assert.equal(
  isNonMatchingApplicationCriterion(criterion(
    "협약예정일 기준 연구개발기관이 금융기관 등의 채무 불이행 중이거나 부채비율이 1,000% 이상인 경우",
    { dimension: "credit_status", operator: "text_only" },
  )),
  false,
  "협약예정일을 판정 기준일로 쓴 현재 신용·재무 상태를 사후 협약의무로 오인하지 않는다",
);
assert.equal(
  isNonMatchingApplicationCriterion(criterion("신청대상은 법인사업자이며 개인사업자는 제외", {
    dimension: "target_type",
    operator: "not_in",
  })),
  false,
);
assert.equal(
  isNonMatchingApplicationCriterion(criterion("최근 3년 이내 정부지원사업에서 허위자료 제출로 참여제한 중인 기업", {
    dimension: "sanction",
    operator: "in",
  })),
  false,
  "과거 행위가 아니라 현재 참여제한 상태를 판정하는 구조화 criterion은 보존한다",
);
assert.equal(
  isNonMatchingApplicationCriterion(criterion(
    "진흥원 및 정부 또는 지자체의 각종 협약 및 계약 위반으로 참여제한 조치 중인가?",
    { dimension: "sanction", operator: "in" },
  )),
  false,
  "협약 위반 문구라도 현재 참여제한 조치 중인 상태를 묻는 결격은 보존한다",
);
assert.equal(
  isNonMatchingApplicationCriterion(criterion("현재 동일 과제에 중복 참여 중인 기업은 제외", {
    dimension: "prior_award",
    operator: "exists",
    value: { scope: "self", self_kind: "same_project" },
  })),
  false,
  "현재 중복 참여라는 명시적 사실은 보존한다",
);
assert.equal(
  isNonMatchingApplicationCriterion(criterion("당해연도 다른 정부지원사업 수혜 기업은 제외", {
    dimension: "prior_award",
    operator: "exists",
    value: { scope: "self", self_kind: "same_year_other_support" },
  })),
  false,
  "당해연도 수혜라는 명시적 사실은 보존한다",
);

console.log("matching-scope: ok");

function criterion(
  sourceSpan: string,
  overrides: Partial<GrantCriterion> = {},
): GrantCriterion {
  return {
    dimension: "other",
    operator: "text_only",
    kind: "exclusion",
    value: { note: sourceSpan },
    confidence: 1,
    source_span: sourceSpan,
    ...overrides,
  };
}
