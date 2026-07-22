import assert from "node:assert/strict";
import type { IRBlock } from "kordoc";
import {
  applyContextualEdits,
  extractContextualRoundtripFields,
  prepareContextualEdits,
} from "./editable-regions";
import { planRoundtripFields } from "./field-planner";

const blocks: IRBlock[] = [
  {
    type: "table",
    pageNumber: 1,
    table: {
      rows: 7,
      cols: 4,
      hasHeader: true,
      cells: [
        row("사업자 구분", "□ 개인  □ 법인  □ 공동대표", "", ""),
        row("산업분야", "□ 자동차  □ 조선\n□ AI  □ 기타(  )", "업종", "자동차용 신품 제동장치 제조업 (C30392)\n[참고] 분류표 참조"),
        row("관련기술현황", "특허출원", "특허등록", "대표특허명"),
        row("", "※1건 이상 보유시 ○ 표시", "※1건 이상 보유시 ○ 표시", ""),
        row("재무현황", "2023년", "2024년", "2025년"),
        row("매출액", "(천원)", "(천원)", "(천원)"),
        row("종업원수", "(명)", "(명)", "(명)"),
      ],
    },
  },
  { type: "heading", text: "1. 사업 참여 목적 및 지원 필요성", pageNumber: 2 },
  {
    type: "paragraph",
    text: "- (기술·제품 소개) 핵심 기술과 제품의 차별성 제시\n- (정량 지표) 측정 가능한 목표 제시",
    pageNumber: 2,
  },
];

const fields = extractContextualRoundtripFields(blocks, "a".repeat(64));
assert.equal(fields.filter((field) => field.writeOperation === "toggle_text_choice").length, 2);
assert.equal(fields.filter((field) => field.writeOperation === "insert_before_unit").length, 6);
assert.equal(fields.filter((field) => field.writeOperation === "replace_instruction").length, 2);
assert.equal(fields.filter((field) => field.writeOperation === "replace_span").length, 3);

const businessType = requiredField("사업자 구분");
assert.equal(businessType.inputKind, "single_choice");
const revenue2024 = requiredField("매출액 · 2024년");
assert.equal(revenue2024.unit, "천원");
const patentApplication = requiredField("특허출원 보유 여부");
const industryCode = requiredField("업종");
const narrative = requiredField("기술·제품 소개");

const fieldChoices = {
  [businessType.fieldInstanceId]: [businessType.options[1]!.optionId],
  [patentApplication.fieldInstanceId]: [patentApplication.options[0]!.optionId],
};
const values = {
  [revenue2024.fieldInstanceId]: "123456",
  [industryCode.fieldInstanceId]: "응용 소프트웨어 개발 및 공급업 (J58222)",
  [narrative.fieldInstanceId]: "AI 문서 자동화 기술의 구조 보존 성능을 차별점으로 제시합니다.",
};
const edits = prepareContextualEdits(fields, values, fieldChoices);
assert.equal(edits.length, 5);
const edited = structuredClone(blocks);
applyContextualEdits(edited, edits);

const editedTable = edited[0]!.table!;
assert.match(editedTable.cells[0]![1]!.text, /□ 개인\s+☑ 법인/);
assert.equal(editedTable.cells[3]![1]!.text, "○");
assert.equal(editedTable.cells[5]![2]!.text, "123456 (천원)");
assert.match(editedTable.cells[1]![3]!.text, /^응용 소프트웨어 개발 및 공급업 \(J58222\)/);
assert.match(editedTable.cells[1]![3]!.text, /\[참고\] 분류표 참조$/);
assert.match(edited[2]!.text!, /^AI 문서 자동화 기술/);
assert.match(edited[2]!.text!, /\(정량 지표\)/);

const planned = await planRoundtripFields({
  fields: [revenue2024],
  markdown: "매출액 2024년 (천원)",
  apiKey: "test-key",
  fetchImpl: async () => new Response(JSON.stringify({
    stop_reason: "tool_use",
    content: [{
      type: "tool_use",
      name: "emit_application_field_plan",
      input: {
        decisions: [{
          candidate_id: revenue2024.fieldInstanceId,
          is_user_input: true,
          suggested_label: "2024년 매출액",
          input_kind: "number",
          confidence: 0.99,
          help_text: "2024년 매출액을 천원 단위로 입력",
          evidence: "매출액 2024년 (천원)",
        }],
      },
    }],
  }), { status: 200 }),
});
assert.equal(planned.summary.status, "llm");
assert.equal(planned.fields[0]!.analysisSource, "llm");
assert.equal(planned.fields[0]!.inputKind, "number");
assert.equal(planned.fields[0]!.helperText, "2024년 매출액을 천원 단위로 입력");

console.log("application-roundtrip editable region tests: ok");

function row(...texts: string[]) {
  return texts.map((text) => ({ text, colSpan: 1, rowSpan: 1 }));
}

function requiredField(labelIncludes: string) {
  const field = fields.find((candidate) => candidate.label.includes(labelIncludes));
  assert.ok(field, `field not found: ${labelIncludes}`);
  return field;
}

