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
  isNonMatchingApplicationCriterion(criterion("정부지원사업 참여제한 중인 기업은 신청할 수 없음", {
    dimension: "sanction",
    operator: "in",
  })),
  false,
  "신청 시점에 이미 존재하는 제재 상태는 결격으로 보존한다",
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
