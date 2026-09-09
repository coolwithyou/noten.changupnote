import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import {
  decodeCompanyProfileRows,
  encodeCompanyProfileRows,
  type CompanyProfilePersistenceRow,
} from "./drizzle";

const company = { id: "11111111-1111-4111-8111-111111111111", kind: "active" as const, name: "개인 사업장 테스트" };
const userId = "22222222-2222-4222-8222-222222222222";
const now = new Date("2026-09-08T15:30:00.000Z");
const profile: CompanyProfile = {
  employees_count: 12,
  premises: {
    schemaVersion: "premises-v1",
    locations: [{
      locationId: "33333333-3333-4333-8333-333333333333",
      facilityType: "headquarters",
      sidoCode: "11",
      validFrom: "2026-01-01",
      validTo: null,
    }],
    coverage: {
      facilityTypes: ["headquarters"],
      validFrom: "2026-01-01",
      validTo: "2026-09-09",
      asOf: now.toISOString(),
      completeness: "complete",
    },
  },
  profile_evidence: {
    employees: {
      sourceKind: "self_declared",
      provider: "cunote_profile_question",
      asOf: now.toISOString(),
      axisCompleteness: "complete",
      confidence: 0.6,
      scope: "user",
      persistenceClass: "portable_user_answer",
    },
    premises: {
      sourceKind: "self_declared",
      provider: "cunote_profile_question",
      asOf: now.toISOString(),
      axisCompleteness: "complete",
      confidence: 0.6,
      scope: "user",
      persistenceClass: "portable_user_answer",
    },
  },
  confidence: { employees: 0.6, premises: 0.6 },
};

const encoded = encodeCompanyProfileRows(company.id, profile, now, userId) as CompanyProfilePersistenceRow[];
const premisesRows = encoded.filter((row) => row.dimension === "premises");
assert.equal(premisesRows.length, 1);
assert.equal(premisesRows[0]?.userId, userId);
const reopened = decodeCompanyProfileRows(company, encoded);
assert.deepEqual(reopened.premises, profile.premises, "typed JSON survives save/head reload");
assert.equal(reopened.employees_count, 12, "unrelated value survives the same whole-scope save");
assert.equal(reopened.profile_evidence?.premises?.scope, "user");
assert.equal(reopened.profile_evidence?.premises?.persistenceClass, "portable_user_answer");

const sharedAttempt = encodeCompanyProfileRows(company.id, profile, now);
assert.equal(sharedAttempt.some((row) => row.dimension === "premises"), false, "premises cannot be encoded as shared");
const forgedSharedRow: CompanyProfilePersistenceRow[] = premisesRows.map((row) => ({ ...row, userId: null }));
assert.equal(decodeCompanyProfileRows(company, forgedSharedRow).premises, undefined, "shared-row scope cannot be spoofed by JSON metadata");
const metadataOnlyRow: CompanyProfilePersistenceRow[] = premisesRows.map((row) => {
  const { schemaVersion: _schemaVersion, locations: _locations, coverage: _coverage, ...metadata } = row.value;
  return { ...row, value: { ...metadata, _cunote_value_present: false } };
});
const metadataOnly = decodeCompanyProfileRows(company, metadataOnlyRow);
assert.equal(metadataOnly.premises, undefined, "metadata-only premises rows cannot create a value");
assert.equal(metadataOnly.profile_evidence?.premises, undefined, "metadata-only premises evidence is discarded with the row");

const missingValueProfile: CompanyProfile = {
  profile_evidence: { premises: profile.profile_evidence!.premises! },
};
assert.equal(
  encodeCompanyProfileRows(company.id, missingValueProfile, now, userId).some((row) => row.dimension === "premises"),
  false,
  "personal premises evidence without a valid compound value does not persist a fallback row",
);

console.log("premises-v1 persistence tests passed");
