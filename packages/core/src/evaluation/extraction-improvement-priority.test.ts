import assert from "node:assert/strict";
import type { CompanyProfile, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { planExtractionImprovements } from "./extraction-improvement-priority.js";

const companies: CompanyProfile[] = [
  { id: "c1", region: { code: "11" }, revenue_krw: 80_000_000 },
  { id: "c2", region: { code: "11" } },
];
const plan = planExtractionImprovements({
  companies,
  grants: [
    grant("attachment", [regionCriterion()], "partial", ["attachment_fetch_incomplete"]),
    grant("review", [regionCriterion()], "structured_unreviewed", []),
    grant("missing", [], "unstructured", ["criteria_missing"]),
  ],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.equal(plan.candidateCount, 2);
assert.equal(plan.candidates[0]?.grantId, "bizinfo:attachment", "즉시 eligible을 여는 첨부 작업이 먼저다");
assert.equal(plan.candidates.find((candidate) => candidate.sourceId === "attachment")?.primaryAction, "archive_attachments");
assert.equal(plan.candidates.find((candidate) => candidate.sourceId === "missing")?.primaryAction, "reextract");
assert.equal(plan.bySource.bizinfo?.candidateCount, 2);

console.log("extraction-improvement-priority: ok");

function regionCriterion(): GrantCriterion {
  return {
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["11"] },
    confidence: 1,
    source_field: "target",
    source_span: "서울 소재 기업",
  };
}
function grant(
  sourceId: string,
  criteria: GrantCriterion[],
  readiness: "structured_unreviewed" | "partial" | "unstructured",
  warnings: Array<"attachment_fetch_incomplete" | "criteria_missing">,
): NormalizedGrant<Record<string, unknown>> {
  return {
    raw: { source: "bizinfo", source_id: sourceId, payload: {}, status: "normalized" },
    grant: {
      source: "bizinfo",
      source_id: sourceId,
      title: sourceId,
      status: "open",
      apply_end: "2026-07-31",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria,
    extraction_manifest: {
      grantId: `bizinfo:${sourceId}`,
      revision: "r1",
      sourceFieldsSeen: [],
      attachmentsExpected: warnings.includes("attachment_fetch_incomplete") ? 1 : 0,
      attachmentsFetched: 0,
      attachmentsConverted: 0,
      sectionsDetected: criteria.length ? ["required"] : [],
      extractorVersion: "test",
      completedAt: "2026-07-01T00:00:00.000Z",
      warnings,
      readiness,
    },
  };
}
