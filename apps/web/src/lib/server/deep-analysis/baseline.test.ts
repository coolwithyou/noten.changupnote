import assert from "node:assert/strict";
import { buildActiveDeepAnalysisBaselineReport } from "./baseline";

const report = buildActiveDeepAnalysisBaselineReport({
  generatedAt: "2026-07-25T00:00:00.000Z",
  promotionReleaseCount: 0,
  bySource: {
    bizinfo: {
      activeCount: 350,
      activeWithHwpCount: 269,
      hwpAttachmentCount: 430,
      hwpArchivedCount: 174,
      hwpConvertedCount: 3,
      hwpFailedCount: 0,
      criteriaGrantCount: 350,
      deepCriteriaGrantCount: 0,
    },
    kstartup: {
      activeCount: 274,
      activeWithHwpCount: 126,
      hwpAttachmentCount: 226,
      hwpArchivedCount: 37,
      hwpConvertedCount: 11,
      hwpFailedCount: 6,
      criteriaGrantCount: 273,
      deepCriteriaGrantCount: 0,
    },
  },
});

assert.equal(report.totals.activeCount, 624);
assert.equal(report.totals.hwpAttachmentCount, 656);
assert.equal(report.totals.hwpConvertedCount, 14);
assert.equal(report.totals.criteriaGrantCount, 623);
assert.equal(report.conservation.blockedOrFailed, 624);
assert.equal(report.conservation.delta, 0);
assert.equal(report.conservation.passed, true);
assert.deepEqual(report.blockers.map((item) => item.code), [
  "deep_analysis_instrumentation_missing",
]);

console.log("deep analysis baseline tests passed");
