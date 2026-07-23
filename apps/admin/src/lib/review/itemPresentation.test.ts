import assert from "node:assert/strict"

import {
  buildReviewItemPresentation,
  reviewDimensionLabel,
} from "./itemPresentation"

const size = buildReviewItemPresentation({
  itemKind: "criterion",
  collectTarget: "overlay",
  dimension: "size",
  blind: false,
  payload: {
    criterion: {
      dimension: "size",
      kind: "required",
      operator: "in",
      value: { tags: ["소기업"] },
      confidence: 0.95,
      sourceSpan: "소상공인이란, 소기업 중 소상공인 기준을 충족하는 기업",
    },
    reason: "span_unverified",
  },
})

assert.equal(size.title, "기업 규모")
assert.equal(size.kindLabel, "필수 조건")
assert.equal(size.extractedValue, "소기업")
assert.match(size.question, /AI 분석/)
assert.match(size.question, /소기업/)
assert.match(size.question, /실제로 이렇게 요구하나요/)
assert.match(size.evidence ?? "", /소상공인/)
assert.equal(size.context[0]?.value, "목록 중 하나")

const axis = buildReviewItemPresentation({
  itemKind: "axis",
  collectTarget: "overlay",
  dimension: "region",
  blind: false,
  payload: { reasons: ["missed_condition", "low_confidence"] },
})
assert.equal(axis.title, "지역·소재지")
assert.match(axis.question, /누락됐을 가능성/)
assert.equal(axis.context.length, 2)

const blind = buildReviewItemPresentation({
  itemKind: "criterion",
  collectTarget: "audit_file",
  dimension: "biz_age",
  blind: true,
  payload: {
    criterion: {
      dimension: "biz_age",
      kind: "required",
      value: { minMonths: 12, maxMonths: 84 },
    },
  },
})
assert.doesNotMatch(blind.question, /AI/)
assert.match(blind.question, /업력/)
assert.equal(blind.extractedValue, "12~84")

assert.equal(reviewDimensionLabel("tax_compliance"), "세금 체납")
assert.equal(reviewDimensionLabel("future_dimension"), "future dimension")

console.log("review item presentation tests: ok")
