import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  anonymizeCohortSampleId,
  buildAutofillCohortReport,
  renderAutofillCohortMarkdown,
  type AutofillCohortSampleInput,
} from "./autofill-cohort-measurement.js";

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), "fixtures/autofill-cohort-measurement.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { samples: AutofillCohortSampleInput[] };
assert.throws(() => buildAutofillCohortReport({ samples: fixture.samples, secret: "" }), /secret/);
const alpha = "alpha-secret-with-at-least-32-bytes";
const beta = "beta-secret-with-at-least-32-bytes!";
assert.equal(anonymizeCohortSampleId("123-45-67890", alpha), anonymizeCohortSampleId("1234567890", alpha));
assert.notEqual(anonymizeCohortSampleId("1234567890", alpha), anonymizeCohortSampleId("1234567890", beta));
assert.throws(() => anonymizeCohortSampleId("1234567890", "short"), /32 bytes/);
assert.throws(() => anonymizeCohortSampleId("abc1234567890", alpha), /only digits/);
assert.throws(() => anonymizeCohortSampleId("123456789", alpha), /exactly 10 digits/);

const report = buildAutofillCohortReport({ samples: fixture.samples, secret: alpha, generatedAt: "2026-07-12T00:00:00.000Z" });
const serialized = JSON.stringify(report);
assert.equal(serialized.includes("123-45-67890"), false);
assert.equal(serialized.includes("987-65-43210"), false);
assert.equal(report.status, "measurement_harness_complete_sample_pending");
assert.equal(report.gates.overall, "sample-pending");
assert.deepEqual(report.cohorts["small-corporation"]?.coverage.authoritative_axis_coverage, { numerator: 2, denominator: 38, ratio: 2 / 38 });
assert.deepEqual(report.cohorts["small-corporation"]?.unknownsResolvedPerQuestion, { numerator: 5, denominator: 2, ratio: 2.5 });
assert.equal(report.sources["exact-paid"]?.attempted, 1);
assert.equal(report.sources["exact-paid"]?.skipped, 1);
assert.equal(report.sources["exact-paid"]?.decision, "insufficient-evidence");
assert.equal(report.sources["exact-free"]?.decision, "insufficient-evidence");
assert.equal(report.sources.fuzzy?.fuzzyPrecision?.ratio, 0.5);
assert.equal(report.sources.fuzzy?.decision, "insufficient-evidence");
assert.deepEqual(report.sources["exact-paid"]?.liveLatency, { count: 1, p50Ms: 400, p95Ms: 400, maxMs: 400 });
assert.equal(report.sources["exact-paid"]?.estimatedCost, 1.25);
assert.deepEqual(report.fields.region, { verifiedCorrect: 1, verifiedIncorrect: 1, verifiedDenominator: 2, accuracy: 0.5, conflicts: 1, unverified: 0 });
assert.equal(report.fields.industry?.verifiedDenominator, 0);
assert.equal(report.fields.industry?.accuracy, null);
assert.equal(report.fields.industry?.unverified, 2);
assert.match(renderAutofillCohortMarkdown(report), /insufficient-evidence/);

const enough = Array.from({ length: 30 }, (_, index) => ({
  ...fixture.samples[0]!, businessNumber: String(1000000000 + index), fields: index < 3 ? fixture.samples[0]!.fields : [], sourceCalls: [],
}));
const ready = buildAutofillCohortReport({ samples: enough, secret: alpha, generatedAt: "2026-07-12T00:00:00.000Z" });
assert.equal(ready.status, "initial_measurement_complete");
const withoutTruth = enough.map((sample, index) => ({ ...sample, fields: index < 3 ? [{ field: "region" as const, verified: true }] : [] }));
assert.equal(buildAutofillCohortReport({ samples: withoutTruth, secret: alpha }).gates.verificationReady, false);

const reordered = buildAutofillCohortReport({ samples: [...enough].reverse(), secret: alpha, generatedAt: ready.generatedAt });
assert.deepEqual(reordered, ready);
assert.throws(() => buildAutofillCohortReport({ samples: [{ ...enough[0]!, cohorts: ["ACME Corp"] as never }], secret: alpha }), /cohort ID/);
assert.throws(() => buildAutofillCohortReport({ samples: [{ ...enough[0]!, sourceCalls: [{ ...fixture.samples[0]!.sourceCalls[0]!, source: "1234567890" as never }] }], secret: alpha }), /source ID/);
assert.throws(() => buildAutofillCohortReport({ samples: [{ ...enough[0]!, fields: [{ field: "representative-name" as never, verified: false }] }], secret: alpha }), /field ID/);

const fuzzyCalls = (correct: number) => Array.from({ length: 20 }, (_, index) => ({ source: "fuzzy" as const, outcome: "found" as const, durationMs: index, cacheHit: false, estimatedCost: 0, joinKind: "fuzzy" as const, fuzzyCorrect: index < correct }));
const fuzzyBase = enough.map((sample, index) => ({ ...sample, sourceCalls: index === 0 ? fuzzyCalls(19) : [] }));
assert.equal(buildAutofillCohortReport({ samples: fuzzyBase, secret: alpha }).sources.fuzzy?.decision, "go");
assert.deepEqual(buildAutofillCohortReport({ samples: fuzzyBase, secret: alpha }).sources.fuzzy?.liveLatency, { count: 20, p50Ms: 9, p95Ms: 18, maxMs: 19 });
const fuzzyBelow = fuzzyBase.map((sample, index) => index === 0 ? { ...sample, sourceCalls: fuzzyCalls(18) } : sample);
const blocked = buildAutofillCohortReport({ samples: fuzzyBelow, secret: alpha });
assert.equal(blocked.sources.fuzzy?.decision, "candidate-only");
assert.equal(blocked.status, "measurement_blocked");
assert.equal(blocked.gates.overall, "no-go");

const exactBoundaryCalls = Array.from({ length: 5 }, (_, index) => ({ source: "exact-paid" as const, outcome: index === 0 ? "found" as const : "empty" as const, durationMs: 1, cacheHit: false, estimatedCost: 1, joinKind: "exact" as const }));
const exactBoundary = enough.map((sample, index) => ({ ...sample, sourceCalls: index === 0 ? exactBoundaryCalls : [] }));
assert.equal(buildAutofillCohortReport({ samples: exactBoundary, secret: alpha }).sources["exact-paid"]?.decision, "go");

console.log("autofill-cohort-measurement: ok");
