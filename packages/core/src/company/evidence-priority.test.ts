import assert from "node:assert/strict";
import type { CompanyProfileEvidenceObservation, CriterionDimension } from "@cunote/contracts";
import { resolveEvidencePrecedence } from "./evidence-priority.js";

const base: CompanyProfileEvidenceObservation = {
  sourceKind: "authoritative_api",
  provider: "dart",
  axisCompleteness: "complete",
  confidence: 0.9,
  asOf: "2026-01-01T00:00:00.000Z",
};

const cases: Array<{
  name: string;
  dimension: CriterionDimension;
  current: CompanyProfileEvidenceObservation;
  incoming: CompanyProfileEvidenceObservation;
  decision: "replace" | "retain";
  reason: string;
}> = [
  {
    name: "newer lower-priority financial provider cannot overwrite",
    dimension: "revenue",
    current: { ...base, provider: "codef" },
    incoming: { ...base, provider: "nice", asOf: "2026-07-12T00:00:00.000Z" },
    decision: "retain",
    reason: "provider_priority",
  },
  {
    name: "newer NICE cannot overwrite DART public filing",
    dimension: "financial_health",
    current: { ...base, provider: "dart" },
    incoming: { ...base, provider: "nice", asOf: "2026-07-12T00:00:00.000Z" },
    decision: "retain",
    reason: "provider_priority",
  },
  {
    name: "newer unknown IP provider cannot overwrite KIPRIS",
    dimension: "ip",
    current: { ...base, provider: "kipris" },
    incoming: { ...base, provider: "unknown-ip", asOf: "2026-07-12T00:00:00.000Z" },
    decision: "retain",
    reason: "provider_priority",
  },
  {
    name: "newer CODEF status cannot overwrite NTS business status",
    dimension: "business_status",
    current: { ...base, provider: "nts" },
    incoming: { ...base, provider: "codef", asOf: "2026-07-12T00:00:00.000Z" },
    decision: "retain",
    reason: "provider_priority",
  },
  {
    name: "same provider fresher evidence replaces",
    dimension: "employees",
    current: { ...base, provider: "kcomwel" },
    incoming: { ...base, provider: "kcomwel", asOf: "2026-07-12T00:00:00.000Z" },
    decision: "replace",
    reason: "same_provider_freshness",
  },
  {
    name: "complete beats partial at the same source tier",
    dimension: "ip",
    current: { ...base, provider: "kipris", axisCompleteness: "partial" },
    incoming: { ...base, provider: "kipris", axisCompleteness: "complete", asOf: "2025-01-01T00:00:00.000Z" },
    decision: "replace",
    reason: "completeness",
  },
  {
    name: "authoritative complete beats newer derived",
    dimension: "business_status",
    current: { ...base, provider: "nts" },
    incoming: {
      ...base,
      sourceKind: "derived",
      provider: "heuristic",
      asOf: "2026-07-12T00:00:00.000Z",
    },
    decision: "retain",
    reason: "source_priority",
  },
  {
    name: "complete self-declared retains primary over partial authoritative observation",
    dimension: "industry",
    current: {
      ...base,
      sourceKind: "self_declared",
      provider: "cunote_profile_question",
      axisCompleteness: "complete",
    },
    incoming: {
      ...base,
      provider: "codef",
      axisCompleteness: "partial",
      asOf: "2026-07-12T00:00:00.000Z",
    },
    decision: "retain",
    reason: "completeness",
  },
  {
    name: "unknown provider tie conservatively retains current",
    dimension: "other",
    current: { ...base, provider: "unknown-a" },
    incoming: { ...base, provider: "unknown-b", asOf: "2026-07-12T00:00:00.000Z" },
    decision: "retain",
    reason: "unknown_provider_tie",
  },
  {
    name: "known preferred provider beats unknown provider",
    dimension: "certification",
    current: { ...base, provider: "unknown-cert-source" },
    incoming: { ...base, provider: "startup_confirmation" },
    decision: "replace",
    reason: "provider_priority",
  },
];

for (const testCase of cases) {
  const actual = resolveEvidencePrecedence(testCase);
  assert.equal(actual.decision, testCase.decision, testCase.name);
  assert.equal(actual.reason, testCase.reason, testCase.name);
  assert.equal(actual.primary, testCase.decision === "replace" ? "incoming" : "current", testCase.name);
  assert.equal(actual.supplemental, testCase.decision === "replace" ? "current" : "incoming", testCase.name);
  assert.ok(actual.explanation.length > 0, testCase.name);
}

console.log(`evidence-priority: ${cases.length} cases passed`);
