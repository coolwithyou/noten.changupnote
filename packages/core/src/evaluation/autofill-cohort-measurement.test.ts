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
assert.equal(anonymizeCohortSampleId("123-45-67890", "alpha"), anonymizeCohortSampleId("1234567890", "alpha"));
assert.notEqual(anonymizeCohortSampleId("1234567890", "alpha"), anonymizeCohortSampleId("1234567890", "beta"));

const report = buildAutofillCohortReport({ samples: fixture.samples, secret: "test-only-secret", generatedAt: "2026-07-12T00:00:00.000Z" });
const serialized = JSON.stringify(report);
assert.equal(serialized.includes("123-45-67890"), false);
assert.equal(serialized.includes("987-65-43210"), false);
assert.equal(report.status, "measurement_harness_complete_sample_pending");
assert.equal(report.gates.overall, "sample-pending");
assert.equal(report.cohorts["small-corporation"]?.coverage.authoritative_axis_coverage.numerator, 1);
assert.deepEqual(report.cohorts["small-corporation"]?.unknownsResolvedPerQuestion, { numerator: 5, denominator: 2, ratio: 2.5 });
assert.equal(report.sources["exact-paid"]?.attempted, 1);
assert.equal(report.sources["exact-paid"]?.skipped, 1);
assert.equal(report.sources["exact-paid"]?.decision, "no-go");
assert.equal(report.sources["exact-free"]?.decision, "conditional-call");
assert.equal(report.sources.fuzzy?.fuzzyPrecision?.ratio, 0.5);
assert.equal(report.sources.fuzzy?.decision, "candidate-only");
assert.deepEqual(report.sources["exact-paid"]?.liveLatency, { count: 1, p50Ms: 400, p95Ms: 400, maxMs: 400 });
assert.equal(report.sources["exact-paid"]?.estimatedCost, 1.25);
assert.deepEqual(report.fields.region, { verifiedCorrect: 1, verifiedIncorrect: 1, verifiedDenominator: 2, accuracy: 0.5, conflicts: 1, unverified: 0 });
assert.equal(report.fields.industry?.verifiedDenominator, 0);
assert.equal(report.fields.industry?.accuracy, null);
assert.equal(report.fields.industry?.unverified, 2);
assert.match(renderAutofillCohortMarkdown(report), /candidate-only/);

const enough = Array.from({ length: 30 }, (_, index) => ({
  ...fixture.samples[0]!, businessNumber: String(1000000000 + index), fields: index < 3 ? fixture.samples[0]!.fields : [],
}));
assert.equal(buildAutofillCohortReport({ samples: enough, secret: "secret" }).status, "initial_measurement_complete");

console.log("autofill-cohort-measurement: ok");
