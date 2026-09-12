import assert from "node:assert/strict";
import { buildProfileAutofillProjection, ProfileAutofillProjectionError } from "./profileAutofillProjection";

const current = {
  회사명: {
    value: "창업노트 주식회사",
    status: "suggested" as const,
    source: "profile" as const,
    suggestedValue: "창업노트 주식회사",
    basis: "사업자 정보",
    fieldId: "field-company",
    updatedAt: "seeded",
  },
  사업계획: {
    value: "사용자 작성",
    status: "edited" as const,
    source: "user" as const,
    fieldId: "field-plan",
    updatedAt: "manual",
  },
};

const applied = buildProfileAutofillProjection({
  operation: "apply",
  fieldIds: ["field-company"],
  currentAnswers: current,
  currentMaterializedAnswers: { "field-plan": "사용자 작성" },
  requestedMaterializedAnswers: {
    "field-plan": "사용자 작성",
    "field-company": "창업노트 주식회사",
  },
  currentHeadRevisionId: "revision-before",
  revisionId: "revision-auto",
  at: "accepted",
});
assert.equal(applied.fieldAnswers.회사명?.status, "accepted");
assert.equal(applied.fieldAnswers.회사명?.materializedRevisionId, "revision-auto");
assert.equal(applied.materializedAnswers["field-company"], "창업노트 주식회사");
assert.equal(applied.fieldAnswers.사업계획?.status, "edited");

const undone = buildProfileAutofillProjection({
  operation: "undo",
  fieldIds: ["field-company"],
  currentAnswers: applied.fieldAnswers,
  currentMaterializedAnswers: applied.materializedAnswers,
  requestedMaterializedAnswers: { "field-plan": "사용자 작성" },
  currentHeadRevisionId: "revision-auto",
  revisionId: "revision-undo",
  at: "undone",
});
assert.equal(undone.fieldAnswers.회사명?.status, "dismissed");
assert.equal(undone.fieldAnswers.회사명?.materializedRevisionId, undefined);
assert.equal(undone.materializedAnswers["field-company"], undefined);

assert.throws(() => buildProfileAutofillProjection({
  operation: "apply",
  fieldIds: ["field-company"],
  currentAnswers: { ...current, 회사명: { ...current.회사명, status: "edited", source: "user" } },
  currentMaterializedAnswers: {},
  requestedMaterializedAnswers: { "field-company": "창업노트 주식회사" },
  currentHeadRevisionId: null,
  revisionId: "revision-rejected",
}), (error) => error instanceof ProfileAutofillProjectionError
  && error.code === "profile_autofill_answer_conflict");

assert.throws(() => buildProfileAutofillProjection({
  operation: "apply",
  fieldIds: ["field-company"],
  currentAnswers: current,
  currentMaterializedAnswers: { "field-plan": "사용자 작성" },
  requestedMaterializedAnswers: {
    "field-plan": "덮어쓴 값",
    "field-company": "창업노트 주식회사",
  },
  currentHeadRevisionId: "revision-before",
  revisionId: "revision-rejected",
}), (error) => error instanceof ProfileAutofillProjectionError
  && error.code === "profile_autofill_materialized_conflict");

console.log("profile autofill projection tests passed");
