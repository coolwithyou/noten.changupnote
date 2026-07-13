import assert from "node:assert/strict";
import type { Grant, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { buildExtractionReadinessReport } from "./report.js";

const criterion: GrantCriterion = {
  dimension: "region",
  operator: "in",
  kind: "required",
  confidence: 0.9,
  source_span: "경기도 소재 기업",
  value: { regions: ["41"] },
};

const report = buildExtractionReadinessReport([
  normalized("kstartup", "ready", [criterion]),
  normalized("bizinfo", "pending", [criterion], [{
    filename: "공고문.hwp",
    archive_url: "https://archive.test/notice.hwp",
    sha256: "abc",
  }]),
  normalized("bizinfo", "empty", []),
], { sampleLimit: 2 });

assert.equal(report.grantCount, 3);
assert.deepEqual(report.readinessCounts, { structured_unreviewed: 1, partial: 1, unstructured: 1 });
assert.equal(report.warningCounts.attachment_conversion_incomplete, 1);
assert.equal(report.warningCounts.criteria_missing, 1);
assert.equal(report.attachmentStatusCounts.pending, 1);
assert.equal(report.bySource.kstartup?.grantCount, 1);
assert.equal(report.bySource.bizinfo?.grantCount, 2);
assert.equal(report.incompleteSamples.length, 2);
assert.equal(report.incompleteSamples[0]?.grantId, "bizinfo:empty", "criteria missing is highest priority");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "readiness_histogram",
    "warning_histogram",
    "attachment_status_histogram",
    "source_stratification",
    "priority_samples",
  ],
}, null, 2));

function normalized(
  source: "kstartup" | "bizinfo",
  sourceId: string,
  criteria: GrantCriterion[],
  attachments?: NonNullable<NormalizedGrant["raw"]["attachments"]>,
): NormalizedGrant<Record<string, unknown>> {
  const grant: Grant = {
    source,
    source_id: sourceId,
    title: sourceId,
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.9,
  };
  return {
    raw: {
      source,
      source_id: sourceId,
      payload: {},
      ...(attachments ? { attachments } : {}),
      status: "normalized",
    },
    grant,
    criteria,
  };
}
