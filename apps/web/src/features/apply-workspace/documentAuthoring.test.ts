import assert from "node:assert/strict";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import {
  classifyDocumentAuthoringTask,
  computeAuthoringProgress,
  isStudioTaskComplete,
} from "./documentAuthoring";

function field(overrides: Partial<ConnectedDocumentField>): ConnectedDocumentField {
  return {
    fieldId: overrides.fieldId ?? "field-1",
    fieldKey: overrides.fieldKey ?? "field_1",
    label: overrides.label ?? "상호명",
    section: overrides.section ?? null,
    fieldType: overrides.fieldType ?? "text",
    required: overrides.required ?? true,
    sourceSpan: overrides.sourceSpan ?? null,
    mappedCompanyField: overrides.mappedCompanyField ?? null,
    fillStrategy: overrides.fillStrategy ?? "user_input",
    position: overrides.position ?? null,
    visualEvidence: overrides.visualEvidence ?? null,
  };
}

assert.equal(classifyDocumentAuthoringTask(field({ label: "상호명" })).mode, "quick");
assert.equal(classifyDocumentAuthoringTask(field({ label: "창업분야", fieldType: "checkbox" })).kind, "choice");
assert.equal(classifyDocumentAuthoringTask(field({ label: "경력사항", fieldType: "long_text" })).mode, "studio");
assert.equal(classifyDocumentAuthoringTask(field({ label: "기술/자격증/입상실적" })).kind, "repeating_table");
assert.equal(classifyDocumentAuthoringTask(field({ label: "신청인(대표자) 서명", fillStrategy: "manual" })).kind, "attachment_or_stamp");
assert.equal(classifyDocumentAuthoringTask(field({ label: "주민등록번호", fillStrategy: "manual" })).mode, "quick");
assert.equal(classifyDocumentAuthoringTask(field({ label: "사업 참여 목적", fieldType: "long_text" })).kind, "assisted_longform");
assert.equal(isStudioTaskComplete("edited"), false);
assert.equal(isStudioTaskComplete("not_applicable"), true);

const quick = classifyDocumentAuthoringTask(field({ fieldId: "quick", label: "상호명" }));
const studio = classifyDocumentAuthoringTask(field({ fieldId: "studio", label: "경력사항", fieldType: "table" }));
const progress = computeAuthoringProgress({
  tasks: [quick, studio],
  answers: { 상호명: { value: "창업노트", status: "accepted", source: "user", updatedAt: "2026-07-23" } },
  studioTaskStates: { studio: "confirmed" },
  pendingLabels: new Set(),
});
assert.deepEqual(progress, {
  total: 2,
  confirmed: 2,
  quick: { total: 1, confirmed: 1 },
  studio: { total: 1, confirmed: 1 },
});

console.log("document authoring classification passed");
