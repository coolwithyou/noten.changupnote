import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import { simulateBusinessAudienceFilter } from "./business-filter-simulation.js";

const grants = [
  grant("company", "일반기업", "기업 지원"),
  grant("individual", "일반인", "교육생 모집 만 39세 이하"),
  grant("unknown", "대학생", "대상 확인 필요"),
];
const report = simulateBusinessAudienceFilter({
  grants,
  companies: [{
    companyId: "company-1",
    businessKind: "corporation",
    profile: { target_types: ["법인"], confidence: { target_type: 1 } },
  }],
  asOf: new Date("2026-07-12T00:00:00.000Z"),
});
assert.equal(report.grantCountBefore, 3);
assert.equal(report.grantCountAfter, 2);
assert.equal(report.excludedGrantCount, 1);
assert.equal(report.excluded[0]?.sourceId, "individual");
assert.equal(report.audienceCounts.unknown, 1, "근거가 약한 individual token은 보존한다");
assert.equal(report.gates.allExcludedAreSafeIndividual, true);
assert.equal(report.gates.readinessGateMaintained, true);
assert.equal(report.matchingFilterEnabled, false);

console.log("business-audience-filter-simulation: ok");

function grant(sourceId: string, target: string, detail: string): NormalizedGrant<Record<string, string>> {
  return {
    raw: {
      source: "kstartup",
      source_id: sourceId,
      payload: { aply_trgt: target, aply_trgt_ctnt: detail },
      status: "normalized",
    },
    grant: {
      source: "kstartup",
      source_id: sourceId,
      title: sourceId,
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 1,
    },
    criteria: [],
    extraction_manifest: {
      grantId: `kstartup:${sourceId}`,
      revision: "r1",
      sourceFieldsSeen: ["aply_trgt"],
      attachmentsExpected: 0,
      attachmentsFetched: 0,
      attachmentsConverted: 0,
      sectionsDetected: [],
      extractorVersion: "test",
      completedAt: "2026-07-12T00:00:00.000Z",
      warnings: ["criteria_missing"],
      readiness: "unstructured",
    },
  };
}
