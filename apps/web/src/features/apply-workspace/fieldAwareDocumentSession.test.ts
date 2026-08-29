import assert from "node:assert/strict";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import { buildDocumentAuthoringTasks } from "./documentAuthoring";
import { buildFieldAwareDocumentSession, fieldSelectionTargetKey } from "./fieldAwareDocumentSession";

const atomic: ConnectedDocumentField = {
  fieldId: "field-company",
  fieldKey: "company_name",
  label: "상호명",
  section: "기업 현황",
  fieldType: "text",
  required: true,
  sourceSpan: null,
  mappedCompanyField: null,
  fillStrategy: "ask_user",
  position: null,
  visualEvidence: null,
  guidance: "사업자등록증의 상호명을 적습니다.",
};
const table: ConnectedDocumentField = {
  ...atomic,
  fieldId: "field-careers",
  fieldKey: "career_rows",
  label: "경력사항",
  fieldType: "table",
};
const longText: ConnectedDocumentField = {
  ...atomic,
  fieldId: "field-introduction",
  fieldKey: "introduction",
  label: "자기소개",
  fieldType: "long_text",
};
const choice: ConnectedDocumentField = {
  ...atomic,
  fieldId: "field-founder-type",
  fieldKey: "founder_type",
  label: "창업자 유형",
  sourceSpan: "□ 예비창업자 □ 폐업 후 재창업자",
};
const tasks = buildDocumentAuthoringTasks([atomic, table, choice, longText]);

const ready = buildFieldAwareDocumentSession({
  tasks,
  answers: {},
  selectedFieldId: atomic.fieldId,
  bindingStatuses: new Map([
    [atomic.fieldId, "unique"],
    [table.fieldId, "unique"],
    [choice.fieldId, "unique"],
    [longText.fieldId, "unique"],
  ]),
  bindingTargets: new Map([
    [atomic.fieldId, { kind: "table_cell_text", section: 0, parentPara: 1, controlIndex: 0, cellIndex: 1, cellParagraph: 0 }],
    [table.fieldId, { kind: "table_cell_text", section: 0, parentPara: 1, controlIndex: 0, cellIndex: 2, cellParagraph: 0 }],
    [choice.fieldId, { kind: "table_cell_text", section: 0, parentPara: 1, controlIndex: 0, cellIndex: 3, cellParagraph: 0 }],
    [longText.fieldId, { kind: "table_cell_region", section: 0, parentPara: 1, controlIndex: 0, cellIndex: 4 }],
  ]),
  bindingsResolved: true,
  fieldEditorAgentAvailable: true,
  suggestableLabels: new Set([atomic.label, table.label, choice.label, longText.label]),
  suggestingLabels: new Set(),
});
assert.equal(ready.selected?.fieldId, atomic.fieldId);
assert.equal(ready.selected?.assistAvailability, "ready");
assert.equal(ready.selected?.canRequestSuggestion, true);
assert.equal(ready.selected?.guidance, "사업자등록증의 상호명을 적습니다.");
assert.equal(ready.fields[1]?.assistAvailability, "unsupported_kind");
assert.equal(ready.fields[2]?.assistAvailability, "ready");
assert.equal(ready.fields[3]?.assistAvailability, "ready");
assert.equal(ready.boundCount, 4);

const flagOff = buildFieldAwareDocumentSession({
  tasks: [tasks[0]!],
  answers: {},
  selectedFieldId: null,
  bindingStatuses: new Map([[atomic.fieldId, "unique"]]),
  bindingTargets: new Map([[atomic.fieldId, {
    kind: "table_cell_text", section: 0, parentPara: 1, controlIndex: 0, cellIndex: 1, cellParagraph: 0,
  }]]),
  bindingsResolved: true,
  fieldEditorAgentAvailable: false,
  suggestableLabels: new Set([atomic.label]),
  suggestingLabels: new Set(),
});
assert.equal(flagOff.selected?.assistAvailability, "rollout_off");
assert.equal(flagOff.selected?.canRequestSuggestion, false);

const unresolved = buildFieldAwareDocumentSession({
  tasks: [tasks[0]!],
  answers: {},
  selectedFieldId: null,
  bindingStatuses: new Map(),
  bindingTargets: new Map(),
  bindingsResolved: false,
  fieldEditorAgentAvailable: true,
  suggestableLabels: new Set([atomic.label]),
  suggestingLabels: new Set(),
});
assert.equal(unresolved.selected?.bindingStatus, "resolving");
assert.equal(unresolved.selected?.assistAvailability, "binding_resolving");

assert.equal(fieldSelectionTargetKey({
  kind: "table_cell_text",
  section: 0,
  parentPara: 4,
  controlIndex: 1,
  cellIndex: 3,
  cellParagraph: 0,
}), "table_cell:0:4:1:3");
assert.equal(
  fieldSelectionTargetKey({
    kind: "table_cell_text", section: 0, parentPara: 4,
    controlIndex: 1, cellIndex: 3, cellParagraph: 1,
  }),
  "table_cell:0:4:1:3",
);
assert.equal(fieldSelectionTargetKey({
  kind: "table_cell_region",
  section: 0,
  parentPara: 4,
  controlIndex: 1,
  cellIndex: 3,
}), "table_cell:0:4:1:3");
assert.equal(fieldSelectionTargetKey({
  kind: "form_text",
  section: 0,
  paragraph: 7,
  fieldId: 41,
}), "form_text:0:7:41");
assert.equal(fieldSelectionTargetKey({
  kind: "body_paragraph_text",
  section: 0,
  paragraph: 12,
  length: 17,
  valueStart: 9,
  valueEnd: 17,
}), "body_paragraph:0:12");
assert.equal(fieldSelectionTargetKey({
  kind: "body_paragraph",
  section: 0,
  paragraph: 12,
  charOffset: 0,
  length: 17,
}), "body_paragraph:0:12");

console.log("field-aware document session tests passed");
