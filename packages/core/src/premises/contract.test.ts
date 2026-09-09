import assert from "node:assert/strict";
import type {
  CompanyProfileFieldEvidence,
  GrantCriterion,
  PremisesProfileValue,
} from "@cunote/contracts";
import {
  evaluatePremisesCriterion,
  inspectPremisesCriterionSourceCompatibility,
  InvalidPremisesProfileError,
  normalizePremisesProfileValue,
  parsePremisesCriterionValue,
  parseStoredPremisesProfileValue,
} from "./contract.js";

const criterion = (overrides: Partial<GrantCriterion> = {}): GrantCriterion => ({
  id: "criterion-premises-1",
  dimension: "premises",
  kind: "required",
  operator: "exists",
  value: {
    schemaVersion: "premises-v1",
    state: "registered_current_site",
    sidoCodes: ["11"],
    facilityTypes: ["headquarters"],
    facilitySemantics: "any",
    basisDate: "2026-09-09",
  },
  confidence: 1,
  source_span: "2026년 9월 9일 현재 서울특별시에 등록된 본사를 둔 기업",
  needs_review: false,
  ...overrides,
});

const profile = (overrides: Partial<PremisesProfileValue> = {}): PremisesProfileValue => ({
  schemaVersion: "premises-v1",
  locations: [{
    locationId: "00000000-0000-4000-8000-000000000001",
    facilityType: "headquarters",
    sidoCode: "11",
    validFrom: "2026-09-09",
    validTo: "2026-09-09",
  }],
  coverage: {
    facilityTypes: ["headquarters"],
    validFrom: "2026-09-09",
    validTo: "2026-09-09",
    asOf: "2026-09-08T15:30:00.000Z",
    completeness: "complete",
  },
  ...overrides,
});

const evidence = (overrides: Partial<CompanyProfileFieldEvidence> = {}): CompanyProfileFieldEvidence => ({
  sourceKind: "self_declared",
  provider: "cunote_profile_question",
  asOf: "2026-09-08T15:30:00.000Z",
  axisCompleteness: "complete",
  confidence: 0.6,
  scope: "user",
  persistenceClass: "portable_user_answer",
  ...overrides,
});
const evidenceWithoutScope = evidence();
delete evidenceWithoutScope.scope;
const evidenceWithoutPersistence = evidence();
delete evidenceWithoutPersistence.persistenceClass;

const evaluate = (
  targetProfile: unknown = profile(),
  targetEvidence: CompanyProfileFieldEvidence | undefined = evidence(),
  targetCriterion = criterion(),
  asOf = new Date("2026-09-08T15:30:00.000Z"),
) => evaluatePremisesCriterion({
  criterion: targetCriterion,
  profile: targetProfile,
  evidence: targetEvidence,
  asOf,
});

const exact = parsePremisesCriterionValue(criterion().value);
assert.equal(exact.ok, true);
assert.deepEqual(exact.ok ? exact.value.sidoCodes : [], ["11"]);

for (const [label, value] of [
  ["district", { ...criterion().value, districtCodes: ["11680"] }],
  ["future", { ...criterion().value, state: "planned_relocation" }],
  ["relative-date", { ...criterion().value, basisDate: "공고일" }],
  ["unknown-sido", { ...criterion().value, sidoCodes: ["37"] }],
  ["unknown-facility", { ...criterion().value, facilityTypes: ["branch"] }],
] as const) {
  const parsed = parsePremisesCriterionValue(value);
  assert.equal(parsed.ok, false, `${label} must remain outside premises-v1`);
}

const normalized = normalizePremisesProfileValue({
  ...profile(),
  coverage: { ...profile().coverage, asOf: "2000-01-01T00:00:00.000Z" },
}, { asOf: "2026-09-08T15:30:00Z" });
assert.equal(normalized.coverage.asOf, "2026-09-08T15:30:00.000Z", "server asOf replaces client provenance");
assert.equal(parseStoredPremisesProfileValue(normalized).ok, true);
assert.throws(
  () => normalizePremisesProfileValue({
    ...profile(),
    locations: [{ ...profile().locations[0]!, validFrom: "2026-09-10", validTo: null }],
  }, { asOf: "2026-09-08T15:30:00.000Z" }),
  (error: unknown) => error instanceof InvalidPremisesProfileError && error.field.includes("validFrom"),
  "KST 2026-09-09 boundary allows the 9th but rejects future 10th",
);

assert.equal(evaluate().result, "pass", "inclusive location and coverage boundaries pass");
assert.equal(evaluate(profile({
  locations: [{ ...profile().locations[0]!, validFrom: "2026-09-01", validTo: null }],
})).result, "pass", "open-ended current location passes");
assert.equal(evaluate(profile({
  coverage: { ...profile().coverage, completeness: "partial" },
}), evidence({ axisCompleteness: "partial" })).result, "pass", "an exact positive hit does not require complete negative coverage");
assert.equal(evaluate(profile({
  coverage: { ...profile().coverage, facilityTypes: ["headquarters"] },
}), evidence(), criterion({
  value: { ...criterion().value, facilityTypes: ["headquarters", "factory"] },
  source_span: "2026년 9월 9일 현재 서울특별시에 등록된 본사 또는 공장을 둔 기업",
})).result, "pass", "an exact covered location satisfies any without proving every alternative absent");

for (const [label, source_span, value] of [
  [
    "district omission",
    "2026년 9월 9일 현재 서울특별시 강남구에 등록된 본사를 둔 기업",
    criterion().value,
  ],
  [
    "future relocation",
    "선정 후 3개월 이내 서울특별시로 본사를 이전할 예정인 기업",
    criterion().value,
  ],
  [
    "document-specific proof",
    "공장등록증상 2026년 9월 9일 현재 경기도에 등록된 공장을 보유한 기업",
    { ...criterion().value, sidoCodes: ["41"], facilityTypes: ["factory"] },
  ],
  [
    "paired alternatives",
    "2026년 9월 9일 현재 등록된 본사는 서울특별시에 있거나 등록된 공장은 경기도에 있는 기업",
    { ...criterion().value, sidoCodes: ["11", "41"], facilityTypes: ["headquarters", "factory"] },
  ],
  [
    "tenure",
    "2026년 9월 9일 기준 1년 이상 계속하여 서울특별시에 등록된 본사를 둔 기업",
    criterion().value,
  ],
] as const) {
  const support = inspectPremisesCriterionSourceCompatibility({ value, sourceSpan: source_span });
  assert.equal(support.ok, false, `${label} must fail semantic admission`);
  assert.equal(evaluate(profile(), evidence(), criterion({ value, source_span })).result, "unknown", `${label} must not pass matching`);
}

for (const [label, source_span, value] of [
  [
    "same-province facilities",
    "2026년 9월 9일 현재 서울특별시에 등록된 본사 또는 공장을 둔 기업",
    { ...criterion().value, facilityTypes: ["headquarters", "factory"] },
  ],
  [
    "Sejong official city name",
    "2026년 9월 9일 현재 세종특별자치시에 등록된 본사를 둔 기업",
    { ...criterion().value, sidoCodes: ["36"] },
  ],
] as const) {
  assert.equal(
    inspectPremisesCriterionSourceCompatibility({ value, sourceSpan: source_span }).ok,
    true,
    `${label} must remain representable`,
  );
}

for (const [label, sourceSpan, value, note] of [
  ["date mismatch", "2026년 9월 8일 현재 서울특별시에 등록된 본사를 둔 기업", criterion().value, undefined],
  ["relative only", "공고일 현재 서울특별시에 등록된 본사를 둔 기업", criterion().value, undefined],
  ["province subset", "2026년 9월 9일 현재 서울특별시에 등록된 본사를 둔 기업", { ...criterion().value, sidoCodes: ["11", "41"] }, undefined],
  ["facility subset", "2026년 9월 9일 현재 서울특별시에 등록된 본사를 둔 기업", { ...criterion().value, facilityTypes: ["headquarters", "factory"] }, undefined],
  ["negation", "2026년 9월 9일 현재 서울특별시에 등록된 본사가 없는 기업", criterion().value, undefined],
  ["all-of", "2026년 9월 9일 현재 서울특별시에 등록된 본사와 공장을 둔 기업", { ...criterion().value, facilityTypes: ["headquarters", "factory"] }, undefined],
  ["note cannot backfill", "지원 대상 기업", criterion().value, "2026년 9월 9일 현재 서울특별시에 등록된 본사를 둔 기업"],
] as const) {
  assert.equal(
    inspectPremisesCriterionSourceCompatibility({ value, sourceSpan, note }).ok,
    false,
    `${label} must fail source compatibility`,
  );
}

assert.equal(evaluatePremisesCriterion({
  criterion: criterion(),
  profile: profile(),
  evidence: undefined,
  asOf: new Date("2026-09-08T15:30:00.000Z"),
}).result, "unknown", "missing evidence must not resolve");
for (const [label, targetEvidence] of [
  ["wrong-provider", evidence({ provider: "cunote_teaser_answer" })],
  ["shared", evidence({ scope: "shared" })],
  ["missing-scope", evidenceWithoutScope],
  ["wrong-persistence", evidence({ persistenceClass: "versioned_provider_observation" })],
  ["missing-persistence", evidenceWithoutPersistence],
  ["mismatched-asof", evidence({ asOf: "2026-09-08T15:31:00.000Z" })],
  ["wrong-completeness", evidence({ axisCompleteness: "partial" })],
] as const) {
  assert.equal(evaluate(profile(), targetEvidence).result, "unknown", `${label} evidence must not resolve`);
}

assert.equal(evaluate({ ...profile(), locations: [] }).result, "unknown", "empty complete list is not negative evidence");
assert.equal(evaluate(profile({
  locations: [{ ...profile().locations[0]!, sidoCode: "26" }],
})).result, "fail", "covered complete active no-hit fails");
assert.equal(evaluate(profile({
  locations: [{ ...profile().locations[0]!, sidoCode: "26" }],
  coverage: { ...profile().coverage, completeness: "partial" },
}), evidence({ axisCompleteness: "partial" })).result, "unknown", "partial no-hit stays unknown");
assert.equal(evaluate(profile({
  locations: [{ ...profile().locations[0]!, sidoCode: "26" }],
  coverage: { ...profile().coverage, facilityTypes: ["factory"] },
})).result, "unknown", "headquarters absence is unknown when coverage only covers factories");
assert.equal(evaluate(profile({
  locations: [{ ...profile().locations[0]!, sidoCode: "26" }],
  coverage: { ...profile().coverage, validFrom: "2026-09-08", validTo: "2026-09-08" },
})).result, "unknown", "no-hit outside the bounded coverage date stays unknown");
assert.equal(evaluate(profile({
  locations: [{ ...profile().locations[0]!, validFrom: "2026-09-01", validTo: "2026-09-08" }],
})).result, "unknown", "expired-only records do not become negative evidence");
assert.equal(evaluate(profile({
  locations: [
    { ...profile().locations[0]!, facilityType: "factory", sidoCode: "11" },
    {
      ...profile().locations[0]!,
      locationId: "00000000-0000-4000-8000-000000000002",
      facilityType: "headquarters",
      sidoCode: "26",
    },
  ],
  coverage: { ...profile().coverage, facilityTypes: ["factory", "headquarters"] },
})).result, "fail", "province and facility cannot be combined across different locations");

const criterionWithoutReview = criterion();
delete criterionWithoutReview.needs_review;
const criterionWithoutSpan = criterion();
delete criterionWithoutSpan.source_span;
assert.equal(evaluate(profile(), evidence(), criterionWithoutReview).result, "unknown");
assert.equal(evaluate(profile(), evidence(), criterion({ needs_review: true })).result, "unknown");
assert.equal(evaluate(profile(), evidence(), criterion({ kind: "preferred" })).result, "unknown");
assert.equal(evaluate(profile(), evidence(), criterionWithoutSpan).result, "unknown");
assert.equal(evaluate(profile(), evidence(), criterion({
  value: { ...criterion().value, basisDate: "2026-09-10" },
})).result, "unknown", "future basis date is not evaluated before the KST day arrives");
assert.equal(
  evaluate(profile(), evidence(), criterion(), new Date("2026-09-08T15:29:59.999Z")).result,
  "unknown",
  "future observation cannot be replayed into an earlier evaluation instant",
);

console.log("premises-v1 contract tests passed");
