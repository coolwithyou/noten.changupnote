import assert from "node:assert/strict";
import {
  ProductProfileAnswerError,
  normalizeProductProfileAnswers,
} from "./normalizeProductProfileAnswers";

const asOf = "2026-07-14T13:00:00.000Z";
const profile = normalizeProductProfileAnswers({
  asOf,
  answers: [
    { field: "region", value: { code: "11", label: "서울" } },
    { field: "revenue", value: 900_000_000 },
    { field: "employees", value: 7 },
    { field: "investment", value: { total_raised_krw: 100_000_000, tips_backed: false } },
  ],
});
assert.equal(profile.region?.code, "11");
assert.equal(profile.revenue_krw, 900_000_000);
assert.equal(profile.employees_count, 7);
assert.equal(profile.investment?.tips_backed, false);
assert.equal(profile.profile_evidence?.region?.sourceKind, "self_declared");
assert.equal(profile.profile_evidence?.region?.provider, "cunote_teaser_answer");
assert.equal(profile.profile_evidence?.region?.asOf, asOf);

const range = normalizeProductProfileAnswers({
  asOf,
  answers: [{ field: "revenue", range: { min: 100_000_000, max: 1_000_000_000, unit: "krw" } }],
});
assert.equal(range.revenue_krw, undefined);
assert.deepEqual(range.question_answer_state?.revenue, {
  status: "range",
  min: 100_000_000,
  max: 1_000_000_000,
  unit: "krw",
  answeredAt: asOf,
  expiresAt: "2027-01-10T13:00:00.000Z",
  sourceKind: "self_declared",
  rulesetVer: null,
});

const unknown = normalizeProductProfileAnswers({
  asOf,
  answers: [{ field: "founder_age", unknown: true }],
});
assert.equal(unknown.founder_age, undefined);
assert.equal(unknown.question_answer_state?.founder_age?.status, "unknown");
assert.equal(unknown.question_answer_state?.founder_age?.answeredAt, asOf);

const normalizedLegacy = normalizeProductProfileAnswers({
  asOf,
  legacyProfile: {
    target_types: ["법인"],
    confidence: { target_type: 1 },
    profile_evidence: {
      target_type: {
        sourceKind: "authoritative_api",
        provider: "forged-client",
        asOf: "2020-01-01T00:00:00.000Z",
        axisCompleteness: "complete",
        confidence: 1,
      },
    },
  },
});
assert.deepEqual(normalizedLegacy.target_types, ["법인"]);
assert.equal(normalizedLegacy.profile_evidence?.target_type?.sourceKind, "self_declared");
assert.equal(normalizedLegacy.profile_evidence?.target_type?.provider, "cunote_teaser_manual");
assert.equal(normalizedLegacy.profile_evidence?.target_type?.asOf, asOf);

await assert.rejects(
  async () => normalizeProductProfileAnswers({ asOf, answers: [{ field: "premises", value: {} }] }),
  (error: unknown) => error instanceof ProductProfileAnswerError && error.code === "unsupported_profile_field",
);
await assert.rejects(
  async () => normalizeProductProfileAnswers({
    asOf,
    answers: [{ field: "revenue", value: 1, unknown: true }],
  }),
  (error: unknown) => error instanceof ProductProfileAnswerError && error.code === "ambiguous_profile_answer",
);
await assert.rejects(
  async () => normalizeProductProfileAnswers({
    asOf,
    answers: [{ field: "employees", range: { min: 1, max: 10, unit: "krw" } }],
  }),
  (error: unknown) => error instanceof ProductProfileAnswerError && error.code === "invalid_profile_range",
);
await assert.rejects(
  async () => normalizeProductProfileAnswers({
    asOf,
    answers: { field: "revenue", value: 1 } as unknown as [],
  }),
  (error: unknown) => error instanceof ProductProfileAnswerError && error.code === "invalid_profile_answers",
);
await assert.rejects(
  async () => normalizeProductProfileAnswers({
    asOf,
    answers: [{ field: "revenue", value: 1, mode: "append" as "merge" }],
  }),
  (error: unknown) => error instanceof ProductProfileAnswerError && error.code === "invalid_profile_answer_mode",
);

console.log("productProfile/normalizeProductProfileAnswers.test.ts: all assertions passed");
