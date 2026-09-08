import assert from "node:assert/strict";
import { matchGrantCriteria } from "../../packages/core/src/matching/match";
import { sourceCorrectionSnapshot } from "../../apps/web/src/lib/server/productProfile/sourceCorrections";
import {
  buildRegistryEmployeesProfile,
  buildRegistryEmployeesRow,
  SOURCE_CORRECTION_UAT,
} from "./source-correction-observation";

const before = buildRegistryEmployeesProfile("before");
const after = buildRegistryEmployeesProfile("after");
const beforeRow = buildRegistryEmployeesRow("before");
const afterRow = buildRegistryEmployeesRow("after");
const criterion = {
  dimension: "employees" as const,
  kind: "required" as const,
  operator: "lte" as const,
  value: { max: 10 },
  confidence: 1,
};

assert.equal(beforeRow.source, "self_declared", "legacy transport enum은 registry provider를 표현하지 못합니다");
assert.equal(beforeRow.userId, undefined);
assert.equal(afterRow.userId, undefined);
assert.equal(beforeRow.value.employees_count, 20);
assert.equal(afterRow.value.employees_count, 8);

const beforeEvidence = before.profile_evidence?.employees;
const afterEvidence = after.profile_evidence?.employees;
assert.equal(beforeEvidence?.sourceKind, "public_registry");
assert.equal(beforeEvidence?.provider, "registry");
assert.equal(beforeEvidence?.scope, "shared");
assert.equal(beforeEvidence?.persistenceClass, "versioned_provider_observation");
assert.equal(beforeEvidence?.observationId, afterEvidence?.observationId);
assert.notEqual(beforeEvidence?.observationVersion, afterEvidence?.observationVersion);
assert.ok(Date.parse(afterEvidence?.asOf ?? "") > Date.parse(beforeEvidence?.asOf ?? ""));

const beforeSnapshot = sourceCorrectionSnapshot(before, "employees");
const afterSnapshot = sourceCorrectionSnapshot(after, "employees");
assert.equal(beforeSnapshot.value, 20);
assert.equal(afterSnapshot.value, 8);
assert.equal(matchGrantCriteria([criterion], before).eligibility, "ineligible");
assert.equal(matchGrantCriteria([criterion], { ...before, source_disputes: ["employees"] }).eligibility, "conditional");
assert.equal(matchGrantCriteria([criterion], after).eligibility, "eligible");
assert.equal(SOURCE_CORRECTION_UAT.authority.includes("not_external_institution_refresh"), true);

console.log("source-correction-observation.test.ts: all assertions passed");
