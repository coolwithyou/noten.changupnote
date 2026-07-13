import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import {
  decodeCompanyProfileRows,
  encodeCompanyProfileRows,
  type CompanyProfilePersistenceRow,
} from "./drizzle.js";

const now = new Date("2026-07-13T00:00:00.000Z");
const profile: CompanyProfile = {
  id: "company-1",
  name: "테스트 법인",
  region: { code: "41", label: "경기" },
  business_status: { active: true, label: "계속사업자" },
  target_types: ["법인사업자"],
  list_completeness: { target_type: "partial" },
  confidence: {
    region: 0.99,
    business_status: 1,
    target_type: 0.95,
  },
  profile_evidence: {
    region: {
      sourceKind: "authoritative_api",
      provider: "popbill",
      asOf: "2026-07-12T23:00:00.000Z",
      axisCompleteness: "complete",
      confidence: 0.99,
      supplemental: [{
        sourceKind: "self_declared",
        provider: "cunote_profile_question",
        asOf: "2026-07-12T22:00:00.000Z",
        axisCompleteness: "complete",
        confidence: 0.6,
      }],
    },
    business_status: {
      sourceKind: "authoritative_api",
      provider: "nts",
      asOf: "2026-07-13T00:00:00.000Z",
      axisCompleteness: "complete",
      confidence: 1,
    },
    target_type: {
      sourceKind: "authoritative_api",
      provider: "popbill",
      asOf: "2026-07-12T23:00:00.000Z",
      axisCompleteness: "partial",
      confidence: 0.95,
    },
  },
  question_answer_state: {
    founder_age: {
      status: "unknown",
      answeredAt: "2026-07-13T00:00:00.000Z",
      expiresAt: "2026-08-12T00:00:00.000Z",
      sourceKind: "self_declared",
      rulesetVer: "matching-v5",
    },
    employees: {
      status: "range",
      answeredAt: "2026-07-13T00:00:00.000Z",
      expiresAt: "2026-08-12T00:00:00.000Z",
      sourceKind: "self_declared",
      rulesetVer: "matching-v5",
      min: 10,
      max: 19,
      unit: "people",
    },
  },
};

const encoded = encodeCompanyProfileRows("company-1", profile, now, "user-1");
assert.equal(encoded.find((row) => row.dimension === "region")?.source, "popbill");
assert.equal(encoded.find((row) => row.dimension === "business_status")?.source, "nts");
assert.equal(encoded.find((row) => row.dimension === "founder_age")?.confidence, 0);
assert.equal(encoded.find((row) => row.dimension === "employees")?.confidence, 0);

const decoded = decodeCompanyProfileRows(
  { id: "company-1", kind: "active", name: "테스트 법인" },
  encoded as CompanyProfilePersistenceRow[],
);
assert.deepEqual(decoded.region, profile.region);
assert.deepEqual(decoded.business_status, profile.business_status);
assert.deepEqual(decoded.target_types, profile.target_types);
assert.deepEqual(decoded.profile_evidence, profile.profile_evidence);
assert.deepEqual(decoded.question_answer_state, profile.question_answer_state);
assert.equal(decoded.founder_age, undefined, "metadata-only unknown row는 실제 값이 아니다");
assert.equal(decoded.employees_count, undefined, "range state row는 exact 직원 수가 아니다");
assert.equal(decoded.confidence?.founder_age, undefined, "metadata-only row는 known confidence가 아니다");
assert.equal(decoded.confidence?.employees, undefined, "range state row는 known confidence가 아니다");

const legacyCodef = decodeCompanyProfileRows(
  { id: "company-2", kind: "active", name: null },
  [{
    dimension: "founder_age",
    value: { founder_age: 38 },
    source: "codef",
    confidence: 0.9,
    asOf: now,
  }],
);
assert.equal(legacyCodef.founder_age, 38);
assert.deepEqual(legacyCodef.profile_evidence?.founder_age, {
  sourceKind: "auth_supplied",
  provider: "codef",
  asOf: now.toISOString(),
  axisCompleteness: "complete",
  confidence: 0.9,
});

console.log("company-profile-persistence.test.ts: all assertions passed");
