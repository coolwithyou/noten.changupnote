import assert from "node:assert/strict";
import { VERSION } from "kordoc";
import type { RoundtripFieldCandidate } from "@/features/dev/analysis-lab/application-roundtrip-contract";
import {
  buildRoundtripFillValues,
  classifyRoundtripDocument,
  generateRoundtripSampleValue,
  assessRoundtripInputField,
} from "./core";

assert.equal(VERSION, "4.2.3", "왕복 실험은 검증된 Kordoc 4.2.3을 사용해야 한다");

const announcement = classifyRoundtripDocument({
  filename: "2026년 창업지원사업 모집공고문.hwp",
  markdown: "모집 공고\n신청기간: 2026. 7. 1. ~ 7. 31.\n지원대상과 선정절차 및 유의사항",
  fields: [],
  formConfidence: 0.1,
});
assert.equal(announcement.role, "announcement");

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
