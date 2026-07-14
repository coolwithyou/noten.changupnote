import assert from "node:assert/strict";
import type { CompanyProfile } from "@cunote/contracts";
import {
  assembleCompanyProfile,
  canonicalCompanyProfileObservationIdentity,
  type CompanyProfileFieldUpdate,
} from "../index.js";

const asOf = "2026-07-14T00:00:00.000Z";
const base: CompanyProfile = {
  revenue_krw: 900_000_000,
  business_status: { label: "확인 전" },
  investment: { total_raised_krw: 100_000_000, last_round: null },
  confidence: { revenue: 0.7, business_status: 0.6, investment: 0.6 },
  profile_evidence: {
    revenue: evidence("authoritative_api", "dart", "2026-06-01T00:00:00.000Z", 0.7),
    business_status: evidence("authoritative_api", "nts", asOf, 0.6),
    investment: evidence("self_declared", "cunote_profile_question", asOf, 0.6),
  },
};

const updates: CompanyProfileFieldUpdate[] = [
  update("revenue", 1_000_000_000, "authoritative_api", "codef", "2026-05-01T00:00:00.000Z", 0.9),
  update("revenue", 1_200_000_000, "authoritative_api", "codef", "2026-07-01T00:00:00.000Z", 0.9),
  update("revenue", 1_100_000_000, "self_declared", "cunote_profile_question", asOf, 0.6),
];

const expected = assembleCompanyProfile({ baseProfile: base, updates, asOf });
assert.equal(expected.profile.revenue_krw, 1_200_000_000);
assert.equal(Object.hasOwn(expected.profile.business_status ?? {}, "active"), false);
assert.equal(expected.profile.business_status?.active, undefined, "business_status.active unknown을 false로 바꾸면 안 된다");
assert.equal(expected.profile.investment?.last_round, null, "investment.last_round null과 unknown을 구분한다");

for (let seed = 1; seed <= 48; seed += 1) {
  assert.deepEqual(
    assembleCompanyProfile({ baseProfile: base, updates: permute(updates, seed), asOf }),
    expected,
    `fixed-seed permutation ${seed}`,
  );
}

const equalTieUpdates = [
  update("employees", 12, "authoritative_api", "kcomwel", asOf, 0.9),
  update("employees", 12, "authoritative_api", "KCOMWEL", asOf, 0.9),
];
const equalTie = assembleCompanyProfile({ baseProfile: { confidence: {} }, updates: equalTieUpdates, asOf });
assert.equal(equalTie.profile.employees_count, 12);
assert.ok(equalTie.decisions.some((decision) => decision.valueDisposition === "deduplicated"));
assert.equal(equalTie.profile.profile_evidence?.employees?.supplemental, undefined);

const unequalTieUpdates = [
  update("employees", 12, "authoritative_api", "kcomwel", asOf, 0.9),
  update("employees", 18, "authoritative_api", "KCOMWEL", asOf, 0.9),
];
const conflict = assembleCompanyProfile({ baseProfile: { confidence: {} }, updates: unequalTieUpdates, asOf });
assert.equal(conflict.profile.employees_count, undefined, "완전 동률의 서로 다른 값은 unknown으로 닫는다");
assert.equal(conflict.profile.profile_evidence?.employees?.provider, "cunote_profile_conflict");
assert.equal(conflict.profile.profile_evidence?.employees?.supplemental?.length, 2);
assert.ok(conflict.decisions.every((decision) => decision.valueDisposition === "conflict_unknown"));
assert.deepEqual(
  assembleCompanyProfile({ baseProfile: { confidence: {} }, updates: [...unequalTieUpdates].reverse(), asOf }),
  conflict,
);

const staleSameProvider = [
  update("employees", 12, "authoritative_api", "registry-a", asOf, 0.9),
  update("employees", 12, "authoritative_api", "registry-b", asOf, 0.9),
  update("employees", 18, "authoritative_api", "registry-b", asOf, 0.7),
];
const deduplicatedTie = assembleCompanyProfile({
  baseProfile: { confidence: {} },
  updates: staleSameProvider,
  asOf,
});
assert.equal(deduplicatedTie.profile.employees_count, 12, "provider 내부 열위 관측은 exact-tie conflict를 만들지 않는다");
assert.ok(deduplicatedTie.decisions.some((decision) => decision.valueDisposition === "deduplicated"));
assert.deepEqual(
  assembleCompanyProfile({ baseProfile: { confidence: {} }, updates: [...staleSameProvider].reverse(), asOf }),
  deduplicatedTie,
);

const identity = canonicalCompanyProfileObservationIdentity({
  dimension: "investment",
  sourceKind: "self_declared",
  provider: " CUNOTE_PROFILE_QUESTION ",
  scope: "user",
  asOf,
  value: { last_round: null, total_raised_krw: 100_000_000 },
  observationVersion: "1",
});
assert.equal(identity.provider, "cunote_profile_question");
assert.equal(identity.scope, "user");
assert.match(identity.observationId, /^profile-observation-[0-9a-f]{16}$/);

console.log("company/assemble-company-profile.test.ts: all assertions passed");

function evidence(
  sourceKind: "authoritative_api" | "self_declared",
  provider: string,
  observedAt: string,
  confidence: number,
) {
  return { sourceKind, provider, asOf: observedAt, axisCompleteness: "complete" as const, confidence };
}

function update(
  field: "revenue" | "employees",
  value: number,
  sourceKind: "authoritative_api" | "self_declared",
  provider: string,
  observedAt: string,
  confidence: number,
): CompanyProfileFieldUpdate {
  return {
    field,
    value,
    sourceKind,
    provider,
    asOf: observedAt,
    axisCompleteness: "complete",
    confidence,
  };
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
