import assert from "node:assert/strict";
import type {
  CompanyProfile,
  CompanyProfileEvidenceObservation,
  CriterionDimension,
  GrantCriterion,
} from "@cunote/contracts";
import {
  matchGrantCriteria,
  OPERATIONAL_PROFILE_DIMENSIONS,
  PROFILE_FIELD_SPEC,
  updateCompanyProfileField,
} from "@cunote/core";
import {
  decodeCompanyProfileRows,
  decodeCompanyProfileRowsLegacy,
  encodeCompanyProfileRows,
  type CompanyProfilePersistenceRow,
} from "./drizzle.js";

const now = new Date("2026-07-14T00:00:00.000Z");
const evidence = Object.fromEntries(
  OPERATIONAL_PROFILE_DIMENSIONS.map((dimension) => [dimension, observationFor(dimension)]),
) as NonNullable<CompanyProfile["profile_evidence"]>;
evidence.other = observationFor("other");

const profile: CompanyProfile = {
  id: "company-1",
  name: "테스트 법인",
  is_preliminary: false,
  region: { code: "41", label: "경기" },
  biz_age_months: 25,
  industries: ["소프트웨어 개발업"],
  industry_codes: ["62", "62010", "J"],
  size: "중소기업",
  revenue_krw: 2_000_000_000,
  employees_count: 14,
  founder_age: 39,
  traits: ["여성기업", "청년"],
  certs: ["벤처기업확인서", "창업기업확인서"],
  prior_awards: ["chogi_startup_package"],
  prior_award_history: {
    records: [{ program: "chogi_startup_package", agency: "창업진흥원", year: 2025, state: "completed" }],
    self_flags: { same_project: false, same_year_other_support: true },
    has_incubation_tenancy: false,
    known_programs: ["chogi_startup_package"],
    known_program_types: ["사업화"],
  },
  ip: ["상표", "특허·실용신안"],
  target_types: ["법인", "창업기업"],
  business_status: {
    label: "상태 미확인",
    close_down_state: null,
    close_down_tax_type: "01",
  },
  tax_compliance: { flags: [], known_flags: [], exceptions: [] },
  credit_status: { flags: [], known_flags: [], exceptions: [] },
  sanction: { flags: [], known_flags: [], exceptions: [] },
  financial_health: {
    debt_ratio_pct: 120.5,
    impairment: "none",
    interest_coverage_ratio: 2.1,
    total_assets_krw: 5_000_000_000,
    equity_krw: 2_500_000_000,
    capital_krw: 1_000_000_000,
    fiscal_year: "2025",
  },
  insured_workforce: {
    employment_insurance_active: true,
    insured_count: 12,
    months_since_last_layoff: null,
    no_layoff: false,
  },
  investment: {
    total_raised_krw: 700_000_000,
    last_round: null,
    tips_backed: false,
  },
  list_completeness: {
    industry: "complete",
    founder_trait: "complete",
    certification: "complete",
    prior_award: "complete",
    ip: "complete",
    target_type: "complete",
  },
  other_conditions: { support_goals: ["사업화"], registry_match_method: "exact" },
  confidence: Object.fromEntries([
    ...OPERATIONAL_PROFILE_DIMENSIONS.map((dimension) => [dimension, 0.9] as const),
    ["other", 0.8] as const,
  ]),
  profile_evidence: evidence,
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
assert.equal(encoded.length, 20, "19축 + other row를 빠짐없이 저장한다");
assert.equal(encoded.find((row) => row.dimension === "region")?.source, "codef");
assert.equal(encoded.find((row) => row.dimension === "business_status")?.source, "nts");
assert.equal(
  encoded.find((row) => row.dimension === "certification")?.source,
  "self_declared",
  "legacy transport enum은 generic registry provider를 표현하지 못한다",
);
const certificationMeta = embeddedEvidence(encoded, "certification");
assert.equal(certificationMeta.sourceKind, "public_registry", "provider evidence를 self_declared로 relabel하지 않는다");
assert.equal(certificationMeta.provider, "startup_confirmation");
assert.equal(certificationMeta.scope, "user");
assert.equal(certificationMeta.persistenceClass, "versioned_provider_observation");
assert.equal(certificationMeta.resolverVersion, "p1-v1");
assert.match(String(certificationMeta.observationId), /^profile-observation-[0-9a-f]{16}$/);

const rows = encoded as CompanyProfilePersistenceRow[];
const company = { id: "company-1", kind: "active" as const, name: "테스트 법인" };
const decoded = decodeCompanyProfileRows(company, rows);
assert.deepEqual(stripObservationMetadata(decoded), stripObservationMetadata(profile), "full-profile round-trip");
assert.equal(Object.hasOwn(decoded.business_status ?? {}, "active"), false, "active unknown을 false로 만들지 않는다");
assert.equal(decoded.investment?.last_round, null, "last_round null을 unknown과 구분한다");
assert.deepEqual(decoded.industry_codes, profile.industry_codes);
assert.deepEqual(decoded.prior_award_history, profile.prior_award_history);
assert.deepEqual(decoded.question_answer_state, profile.question_answer_state);
assert.equal(
  decoded.profile_evidence?.certification?.observationId,
  certificationMeta.observationId,
  "stable provider observation id survives decode",
);
assert.equal(
  decoded.profile_evidence?.certification?.canonicalValue,
  certificationMeta.canonicalValue,
  "stable provider canonical value survives decode",
);

const matcherPaths = PROFILE_FIELD_SPEC.filter((entry) =>
  entry.parentDimension &&
  OPERATIONAL_PROFILE_DIMENSIONS.includes(entry.parentDimension as (typeof OPERATIONAL_PROFILE_DIMENSIONS)[number]) &&
  entry.profileOrUpdatePath.startsWith("CompanyProfile."));
for (const entry of matcherPaths) {
  const path = entry.profileOrUpdatePath.slice("CompanyProfile.".length);
  assert.deepEqual(readPath(decoded, path), readPath(profile, path), `${entry.key} matcher-path deep equality`);
}

for (let seed = 1; seed <= 40; seed += 1) {
  assert.deepEqual(
    decodeCompanyProfileRows(company, permute(rows, seed)),
    decoded,
    `DB row permutation ${seed}`,
  );
}

const sharedRevenue = updateCompanyProfileField({ confidence: {} }, {
  field: "revenue",
  value: 800_000_000,
  sourceKind: "authoritative_api",
  provider: "codef",
  asOf: now.toISOString(),
  axisCompleteness: "complete",
  confidence: 0.9,
});
const userRevenue = updateCompanyProfileField({ confidence: {} }, {
  field: "revenue",
  value: 900_000_000,
  sourceKind: "self_declared",
  provider: "cunote_profile_question",
  asOf: now.toISOString(),
  axisCompleteness: "complete",
  confidence: 0.6,
});
const sharedAndUserRows = [
  ...encodeCompanyProfileRows("company-1", sharedRevenue, now),
  ...encodeCompanyProfileRows("company-1", userRevenue, now, "user-1"),
] as CompanyProfilePersistenceRow[];
const sharedAndUser = decodeCompanyProfileRows(company, sharedAndUserRows);
assert.equal(sharedAndUser.revenue_krw, 800_000_000, "semantic precedence가 user row 조회 순서보다 우선한다");
assert.equal(sharedAndUser.profile_evidence?.revenue?.sourceKind, "authoritative_api");
assert.equal(sharedAndUser.profile_evidence?.revenue?.supplemental?.[0]?.sourceKind, "self_declared");
assert.deepEqual(
  decodeCompanyProfileRows(company, [...sharedAndUserRows].reverse()),
  sharedAndUser,
  "shared/user rows are deterministic typed updates",
);

const legacy = decodeCompanyProfileRowsLegacy(company, rows);
for (const entry of matcherPaths) {
  const path = entry.profileOrUpdatePath.slice("CompanyProfile.".length);
  assert.deepEqual(readPath(legacy, path), readPath(profile, path), `${entry.key} N-1 reconstruction`);
}

const answerProfile = updateCompanyProfileField({ confidence: {} }, {
  field: "revenue",
  value: 500_000_000,
  sourceKind: "self_declared",
  provider: "cunote_profile_question",
  asOf: now.toISOString(),
  axisCompleteness: "complete",
  confidence: 0.6,
});
const answerRows = encodeCompanyProfileRows("company-2", answerProfile, now, "user-2");
const answerMeta = embeddedEvidence(answerRows, "revenue");
assert.equal(answerMeta.persistenceClass, "portable_user_answer");
assert.equal(answerMeta.scope, "user");
const answerCompany = { id: "company-2", kind: "active" as const, name: null };
const typedAnswer = decodeCompanyProfileRows(answerCompany, answerRows as CompanyProfilePersistenceRow[]);
const rollbackAnswer = decodeCompanyProfileRowsLegacy(answerCompany, answerRows as CompanyProfilePersistenceRow[]);
assert.equal(rollbackAnswer.revenue_krw, typedAnswer.revenue_krw);
assert.equal(rollbackAnswer.profile_evidence?.revenue?.sourceKind, "self_declared");
assert.equal(rollbackAnswer.profile_evidence?.revenue?.provider, "cunote_profile_question");
const revenueCriterion: GrantCriterion = {
  dimension: "revenue",
  operator: "gte",
  kind: "required",
  confidence: 0.9,
  value: { min_krw: 100_000_000 },
};
assert.deepEqual(
  matchGrantCriteria([revenueCriterion], rollbackAnswer, { asOf: now }),
  matchGrantCriteria([revenueCriterion], typedAnswer, { asOf: now }),
  "typed answer write -> legacy rollback match parity",
);

const legacyCodef = decodeCompanyProfileRows(
  { id: "company-3", kind: "active", name: null },
  [{
    dimension: "founder_age",
    value: { founder_age: 38 },
    source: "codef",
    confidence: 0.9,
    asOf: now,
  }],
);
assert.equal(legacyCodef.founder_age, 38);
assert.equal(legacyCodef.profile_evidence?.founder_age?.sourceKind, "auth_supplied");
assert.equal(legacyCodef.profile_evidence?.founder_age?.provider, "codef");

console.log("company-profile-persistence.test.ts: all assertions passed");

function observationFor(dimension: CriterionDimension): CompanyProfileEvidenceObservation {
  if (dimension === "business_status") {
    return observation("authoritative_api", "nts", "complete", 0.9);
  }
  if (dimension === "certification") {
    return observation("public_registry", "startup_confirmation", "complete", 0.9);
  }
  if (dimension === "investment") {
    return observation("self_declared", "cunote_profile_question", "complete", 0.9);
  }
  return observation("authoritative_api", "codef", "complete", dimension === "other" ? 0.8 : 0.9);
}

function observation(
  sourceKind: CompanyProfileEvidenceObservation["sourceKind"],
  provider: string,
  axisCompleteness: "partial" | "complete",
  confidence: number,
): CompanyProfileEvidenceObservation {
  return {
    sourceKind,
    provider,
    asOf: now.toISOString(),
    axisCompleteness,
    confidence,
  };
}

function embeddedEvidence(
  persistedRows: ReturnType<typeof encodeCompanyProfileRows>,
  dimension: CriterionDimension,
): Record<string, unknown> {
  const value = persistedRows.find((row) => row.dimension === dimension)?.value;
  const metadata = value?._cunote_profile_evidence;
  assert.ok(metadata && typeof metadata === "object" && !Array.isArray(metadata));
  return metadata as Record<string, unknown>;
}

function stripObservationMetadata(input: CompanyProfile): CompanyProfile {
  const clone = structuredClone(input);
  for (const evidence of Object.values(clone.profile_evidence ?? {})) {
    if (!evidence) continue;
    stripEvidence(evidence);
    for (const supplemental of evidence.supplemental ?? []) stripEvidence(supplemental);
  }
  return clone;
}

function stripEvidence(evidence: CompanyProfileEvidenceObservation): void {
  delete evidence.scope;
  delete evidence.observationId;
  delete evidence.observationVersion;
  delete evidence.canonicalValue;
  delete evidence.persistenceClass;
  delete evidence.resolverVersion;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function permute<T>(input: readonly T[], seed: number): T[] {
  const values = [...input];
  let state = seed >>> 0;
  for (let index = values.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const target = state % (index + 1);
    [values[index], values[target]] = [values[target]!, values[index]!];
  }
  return values;
}
