import assert from "node:assert/strict";
import {
  classifyLabRunOutcome,
  isPublishableLabRun,
  isTerminalLabRun,
} from "./run-outcome";

const cases = [
  { label: "legacy publishable", run: { error: null }, expected: "publishable" },
  {
    label: "legacy held sentinel",
    run: { error: "primary_validation_held: $.axis_assessments.size" },
    expected: "held",
  },
  { label: "legacy provider failure", run: { error: "provider timeout" }, expected: "failed" },
  {
    label: "explicit publishable",
    run: { primaryValidationOutcome: "publishable", error: null },
    expected: "publishable",
  },
  {
    label: "new explicit held",
    run: { primaryValidationOutcome: "held", error: null },
    expected: "held",
  },
  {
    label: "current explicit held sentinel",
    run: {
      primaryValidationOutcome: "held",
      error: "primary_validation_held: $.axis_assessments.revenue",
    },
    expected: "held",
  },
  {
    label: "publishable with error is inconsistent",
    run: { primaryValidationOutcome: "publishable", error: "provider timeout" },
    expected: "failed",
  },
  {
    label: "held with infrastructure error is inconsistent",
    run: { primaryValidationOutcome: "held", error: "provider timeout" },
    expected: "failed",
  },
  {
    label: "unknown outcome fails closed",
    run: { primaryValidationOutcome: "unknown", error: null },
    expected: "failed",
  },
  {
    label: "null outcome fails closed",
    run: { primaryValidationOutcome: null, error: null },
    expected: "failed",
  },
  {
    label: "explicit publishable without error field fails closed",
    run: { primaryValidationOutcome: "publishable" },
    expected: "failed",
  },
  {
    label: "explicit held without error field fails closed",
    run: { primaryValidationOutcome: "held" },
    expected: "failed",
  },
  {
    label: "publishable plus held sentinel is inconsistent",
    run: {
      primaryValidationOutcome: "publishable",
      error: "primary_validation_held: $.axis_assessments.industry",
    },
    expected: "failed",
  },
  { label: "non-string error fails closed", run: { error: 503 }, expected: "failed" },
  { label: "missing error fails closed", run: {}, expected: "failed" },
] as const;

for (const item of cases) {
  assert.equal(classifyLabRunOutcome(item.run), item.expected, item.label);
}

assert.equal(isPublishableLabRun({ primaryValidationOutcome: "held", error: null }), false);
assert.equal(isPublishableLabRun({ error: null }), true);
assert.equal(isTerminalLabRun({ primaryValidationOutcome: "held", error: null }), true);
assert.equal(isTerminalLabRun({ error: "provider timeout" }), false);

console.log("✅ LabRun outcome — legacy 호환·held terminal·모순 fail-closed");
