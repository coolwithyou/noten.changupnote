import assert from "node:assert/strict";
import { extractPriorAwardCriteria, parsePriorAwardSentence, splitPriorAwardCandidateClauses } from "./extract.js";

const sample = [
  "동일한 과제로 다른 정부지원사업에 참여 중인 기업",
  "당해연도 타 부처 유사 정부보조금과 중복 수혜하는 기업",
  "현재 다른 창업보육센터(BI)에 중복 입주 중인 기업",
  "청년창업사관학교 또는 Start-up NEST 수료기업",
].join(" · ");

const disabled = extractPriorAwardCriteria(sample);
assert.equal(disabled.criteria.length, 0, "P3 default keeps L1 defense enabled");
assert.equal(disabled.residualSpans.length, 4);

const enabled = extractPriorAwardCriteria(sample, { enabled: true, sourceField: "exclusion" });
assert.equal(enabled.criteria.length, 4);
assert.equal(enabled.residualSpans.length, 0);
assert.deepEqual(enabled.criteria[0]?.value, {
  scope: "self",
  self_kind: "same_project",
  channel: "general",
  labels: ["동일한 과제로 다른 정부지원사업에 참여 중인 기업"],
});
assert.deepEqual(enabled.criteria[1]?.value, {
  scope: "self",
  self_kind: "same_year_other_support",
  channel: "general",
  labels: ["당해연도 타 부처 유사 정부보조금과 중복 수혜하는 기업"],
});
assert.equal((enabled.criteria[2]?.value as { channel?: unknown }).channel, "incubation_tenancy");
assert.deepEqual(enabled.criteria[3]?.value, {
  scope: "program_type",
  programs: ["startup_academy", "startup_nest"],
  states: ["graduated"],
  labels: ["청년창업사관학교 또는 Start-up NEST 수료기업"],
});

assert.deepEqual(parsePriorAwardSentence("최근 3년 이내 초기창업패키지 수혜 완료 기업 제외"), {
  scope: "program",
  programs: ["chogi_startup_package"],
  states: ["completed"],
  within: { value: 3, unit: "year" },
  labels: ["최근 3년 이내 초기창업패키지 수혜 완료 기업 제외"],
});
assert.equal(parsePriorAwardSentence("제출서류가 허위인 기업"), null);
assert.equal(parsePriorAwardSentence("중복참여 제한"), null, "표제만으로 self criterion을 만들지 않음");
assert.equal(
  parsePriorAwardSentence("※ 중복 수혜 확인 시 선정취소 및 지원금 전액 환수"),
  null,
  "선정 후 조치 안내는 별도 자격 criterion으로 중복 생성하지 않음",
);
assert.deepEqual(
  parsePriorAwardSentence("정부기관으로부터 본 사업과 동일한 지원 내용으로 지원금을 받은 기업"),
  {
    scope: "self",
    self_kind: "same_business_prior",
    channel: "general",
    labels: ["정부기관으로부터 본 사업과 동일한 지원 내용으로 지원금을 받은 기업"],
  },
  "본 사업 동일 지원 기수혜를 same_business_prior로 분류",
);
assert.deepEqual(
  parsePriorAwardSentence("동일 또는 유사한 내용의 지원을 받은 사실이 있거나 참여 중인 경우"),
  {
    scope: "self",
    self_kind: "current_similar",
    channel: "general",
    labels: ["동일 또는 유사한 내용의 지원을 받은 사실이 있거나 참여 중인 경우"],
  },
  "동일·유사 내용 지원도 self current_similar로 분류",
);
assert.equal(
  parsePriorAwardSentence("최근 3년간 동일 아이템으로 5천만원 초과 창업지원금을 받은 자"),
  null,
  "금액 임계는 boolean으로 과대 구조화하지 않음",
);
assert.equal(
  parsePriorAwardSentence("동시에 수행 가능한 지원사업은 최대 2개 과제 이하"),
  null,
  "과제 수 임계는 residual 유지",
);
assert.deepEqual(
  parsePriorAwardSentence("‘2025년 혁신 창업 스타트업 오디션’ 수료 기업"),
  {
    scope: "program",
    programs: ["혁신 창업 스타트업 오디션"],
    states: ["graduated"],
    labels: ["‘2025년 혁신 창업 스타트업 오디션’ 수료 기업"],
  },
  "비canonical 고유 사업명도 program scope로 보존",
);
assert.deepEqual(
  splitPriorAwardCandidateClauses(
    "신청서 및 증빙자료가 허위인 기업 동일 또는 유사 사업으로 타 기관 지원을 받아 중복수혜 우려가 있는 기업",
  ),
  [
    "신청서 및 증빙자료가 허위인 기업",
    "동일 또는 유사 사업으로 타 기관 지원을 받아 중복수혜 우려가 있는 기업",
  ],
  "붙은 절차 조건과 prior_award 절을 분리",
);
const mixed = extractPriorAwardCriteria(
  "동일 또는 유사한 정부 사업의 중복 지원 수혜자 신청서 및 사업계획서를 허위로 기재한 자",
  { enabled: true },
);
assert.equal(mixed.criteria.length, 1);
assert.equal(mixed.criteria[0]?.source_span, "동일 또는 유사한 정부 사업의 중복 지원 수혜자");
assert.deepEqual(mixed.residualSpans, ["신청서 및 사업계획서를 허위로 기재한 자"]);

console.log("prior-award/extract.test.ts: all assertions passed");
