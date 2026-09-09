import assert from "node:assert/strict";
import type { CompanyProfile, PremisesProfileValue } from "@cunote/contracts";
import { assembleCompanyProfile, companyProfileToFieldUpdates } from "../company/assemble-company-profile.js";
import { InvalidCompanyProfileFieldError, updateCompanyProfileField } from "../company/update-profile-field.js";

const asOf = "2026-09-08T15:30:00.000Z";
const rawValue = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "premises-v1",
  locations: [{
    locationId: "00000000-0000-4000-8000-000000000001",
    facilityType: "headquarters",
    sidoCode: "11",
    validFrom: "2026-01-01",
    validTo: null,
  }],
  coverage: {
    facilityTypes: ["headquarters"],
    validFrom: "2026-01-01",
    validTo: "2026-09-09",
    completeness: "complete",
    asOf: "2000-01-01T00:00:00.000Z",
  },
  ...overrides,
});

const personalUpdate = (value: unknown = rawValue()) => ({
  field: "premises" as const,
  value,
  mode: "replace" as const,
  sourceKind: "self_declared" as const,
  provider: "cunote_profile_question",
  asOf,
  axisCompleteness: "complete" as const,
  confidence: 0.6,
  observation: {
    scope: "user" as const,
    persistenceClass: "portable_user_answer" as const,
  },
});

const updated = updateCompanyProfileField({}, personalUpdate());
assert.equal(updated.premises?.coverage.asOf, asOf, "server asOf stamps personal answer");
assert.equal(updated.profile_evidence?.premises?.axisCompleteness, "complete");
assert.equal(updated.profile_evidence?.premises?.scope, "user");
assert.equal(updated.profile_evidence?.premises?.persistenceClass, "portable_user_answer");

const afterOtherField = updateCompanyProfileField(updated, {
  field: "employees",
  value: 12,
  sourceKind: "self_declared",
  provider: "cunote_profile_question",
  asOf,
  observation: { scope: "user", persistenceClass: "portable_user_answer" },
});
assert.deepEqual(afterOtherField.premises, updated.premises, "unrelated field update preserves premises");
assert.deepEqual(afterOtherField.profile_evidence?.premises, updated.profile_evidence?.premises);

for (const update of [
  { ...personalUpdate(), provider: "registry" },
  { ...personalUpdate(), sourceKind: "public_registry" as const },
  { ...personalUpdate(), observation: { scope: "shared" as const, persistenceClass: "portable_user_answer" as const } },
  { ...personalUpdate(), observation: { scope: "user" as const, persistenceClass: "versioned_provider_observation" as const } },
  { ...personalUpdate(), mode: "merge" as const },
]) {
  assert.throws(
    () => updateCompanyProfileField({}, update),
    InvalidCompanyProfileFieldError,
    "unsupported provenance or merge must not create a usable premises profile",
  );
}

const sharedProfile: CompanyProfile = {
  premises: JSON.parse(JSON.stringify(updated.premises)) as PremisesProfileValue,
  profile_evidence: {
    premises: {
      sourceKind: "public_registry",
      provider: "registry",
      asOf,
      axisCompleteness: "complete",
      confidence: 1,
      scope: "shared",
      persistenceClass: "versioned_provider_observation",
    },
  },
};
assert.equal(assembleCompanyProfile({ baseProfile: sharedProfile, updates: [], asOf }).profile.premises, undefined);
assert.deepEqual(companyProfileToFieldUpdates(sharedProfile), [], "unsupported shared premises is not assembled");
const malformedLegacy = {
  premises: {} as PremisesProfileValue,
  profile_evidence: { premises: updated.profile_evidence!.premises! },
};
assert.doesNotThrow(() => assembleCompanyProfile({ baseProfile: malformedLegacy, updates: [], asOf }));
assert.equal(assembleCompanyProfile({ baseProfile: malformedLegacy, updates: [], asOf }).profile.premises, undefined);

const assembled = assembleCompanyProfile({
  baseProfile: sharedProfile,
  updates: [
    {
      field: "premises",
      value: sharedProfile.premises,
      mode: "replace",
      sourceKind: "public_registry",
      provider: "registry",
      asOf,
      axisCompleteness: "complete",
      observation: { scope: "shared", persistenceClass: "versioned_provider_observation" },
    },
    personalUpdate(updated.premises),
  ],
  asOf,
});
assert.equal(assembled.profile.premises?.locations[0]?.sidoCode, "11");
assert.equal(assembled.profile.profile_evidence?.premises?.scope, "user");
assert.equal(assembled.decisions.filter((decision) => decision.field === "premises").length, 1);

const jsonRoundTrip = JSON.parse(JSON.stringify(assembled.profile)) as CompanyProfile;
assert.deepEqual(companyProfileToFieldUpdates(jsonRoundTrip).map((update) => update.field), ["premises"]);
assert.deepEqual(
  assembleCompanyProfile({ baseProfile: {}, updates: companyProfileToFieldUpdates(jsonRoundTrip), asOf }).profile.premises,
  assembled.profile.premises,
);

console.log("premises-v1 profile integration tests passed");
