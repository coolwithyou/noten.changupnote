import assert from "node:assert/strict";
import { VERSION } from "kordoc";
import type { RoundtripFieldCandidate } from "@/features/dev/analysis-lab/application-roundtrip-contract";
import {
  buildRoundtripFillValues,
  classifyRoundtripDocument,
  generateRoundtripSampleValue,
  assessRoundtripInputField,
  inferRoundtripInputKind,
} from "./core";

assert.equal(VERSION, "4.2.3", "왕복 실험은 검증된 Kordoc 4.2.3을 사용해야 한다");

const announcement = classifyRoundtripDocument({
  filename: "2026년 창업지원사업 모집공고문.hwp",
  markdown: "모집 공고\n신청기간: 2026. 7. 1. ~ 7. 31.\n지원대상과 선정절차 및 유의사항",
  fields: [],
  formConfidence: 0.1,
});
assert.equal(announcement.role, "announcement");

const guidance = classifyRoundtripDocument({
  filename: "2. (관리지침) 온실가스 국제감축사업 관리지침(2026.3.)_수정.hwpx",
  markdown: [
    "신청기업 대표자 담당자 연락처 사업자등록번호".repeat(40),
    "사업개요 추진계획 사업화 계획 시장현황".repeat(14),
    "모집 공고 신청기간 지원대상 선정절차 유의사항".repeat(5),
    "개인정보 수집 서약합니다 확약합니다 증빙서류".repeat(30),
  ].join("\n"),
  fields: Array.from({ length: 203 }, (_, index) =>
    field({ id: `guidance-${index}`, label: `지침 표 ${index}`, occurrence: index })),
  formConfidence: 0.49,
});
assert.equal(
  guidance.role,
  "announcement",
  "독립 관리지침의 빈 표와 신청 관련 서술을 빠른 작성 양식으로 오인하면 안 된다",
);

const policyDocument = classifyRoundtripDocument({
  filename: "붙임 3-1. 산업기술혁신사업 공통 운영요령(고시 제2024-218호).hwpx",
  markdown: "사업자 대표자 신청기업 사업개요 추진계획 개인정보 수집".repeat(80),
  fields: Array.from({ length: 905 }, (_, index) =>
    field({ id: `policy-${index}`, label: `정책 표 ${index}`, occurrence: index })),
  formConfidence: 0.64,
});
assert.equal(
  policyDocument.role,
  "announcement",
  "법령·규정·운영요령의 대량 빈 표를 신청서로 오인해 LLM 비용을 쓰면 안 된다",
);

const guidanceWithApplication = classifyRoundtripDocument({
  filename: "관리지침 및 신청서.hwpx",
  markdown: "신청기업 대표자 담당자 연락처 사업자등록번호",
  fields: Array.from({ length: 5 }, (_, index) =>
    field({ id: `combined-${index}`, label: `신청 항목 ${index}`, occurrence: index })),
  formConfidence: 0.5,
});
assert.equal(
  guidanceWithApplication.role,
  "application_form",
  "파일명이 신청서를 명시하면 관리지침 표현만으로 양식을 제외하면 안 된다",
);

const plan = classifyRoundtripDocument({
  filename: "붙임2 사업계획서 양식.hwpx",
  markdown: "사업개요\n문제인식\n실현가능성\n성장전략\n시장현황\n추진계획",
  fields: [field({ id: "plan-1", label: "과제명", occurrence: 0 })],
  formConfidence: 0.4,
});
assert.equal(plan.role, "business_plan");

assert.equal(assessRoundtripInputField({ label: "연번", type: "text", row: 0 }).recommended, false);
assert.equal(
  assessRoundtripInputField({ label: "경기도 양자-반도체 팹 융합활용 R&D 지원 사업", type: "text", row: 0 }).recommended,
  false,
);
assert.equal(assessRoundtripInputField({ label: "사업계획서 작성 목차", type: "text", row: 0 }).recommended, false);
assert.equal(assessRoundtripInputField({ label: "2026년    월     일", type: "date", row: 12 }).recommended, false);
assert.equal(assessRoundtripInputField({ label: "대표자명", type: "text", row: 2 }).recommended, true);
assert.equal(assessRoundtripInputField({ label: "회사소개*", type: "text", row: 1, required: true }).recommended, true);
assert.equal(assessRoundtripInputField({ label: "기업소개", type: "text", row: 3 }).recommended, true);
assert.equal(assessRoundtripInputField({ label: "혁신성*", type: "text", row: 4, required: true }).recommended, true);
assert.equal(inferRoundtripInputKind("회사소개*", "text"), "textarea");

assert.deepEqual(
  generateRoundtripSampleValue({ label: "사업자등록번호", type: "idnum" }),
  { value: "123-45-67890", reason: "사업자등록번호 형식 샘플" },
);

const repeated = [
  field({ id: "name-0", label: "성명", occurrence: 0, originalValue: "기존대표" }),
  field({ id: "name-1", label: "성명", occurrence: 1 }),
];
const prepared = buildRoundtripFillValues(repeated, { "name-1": "김창업" });
assert.deepEqual(prepared.values, { "성명": ["기존대표", "김창업"] });
assert.deepEqual(prepared.requested.map((item) => item.field.fieldInstanceId), ["name-1"]);

console.log("application-roundtrip core tests: ok");

function field(input: {
  id: string;
  label: string;
  occurrence: number;
  originalValue?: string;
}): RoundtripFieldCandidate {
  return {
    fieldInstanceId: input.id,
    label: input.label,
    displayLabel: input.label,
    normalizedLabel: input.label,
    originalValue: input.originalValue ?? "",
    type: "text",
    required: false,
    empty: !input.originalValue,
    recommendedInput: true,
    inputLikelihood: 0.9,
    inputSignals: ["테스트"],
    sampleValue: "샘플",
    sampleReason: "테스트",
    source: "kordoc-form",
    inputKind: "text",
    writeOperation: "kordoc_field",
    helperText: null,
    unit: null,
    options: [],
    analysisSource: "heuristic",
    llmConfidence: null,
    location: { blockIndex: 1, row: input.occurrence, col: 1, occurrence: input.occurrence, pageNumber: null },
  };
}
