import assert from "node:assert/strict";
import { orderDeepAnalysisCohortCandidates } from "./cohort";

function candidate(input: {
  grantId: string;
  source: string;
  dDay: number;
  hasHwp?: boolean;
  dimensionCount?: number;
  needsReview?: boolean;
  matchExposureCount?: number;
}) {
  return {
    sourceId: input.grantId,
    title: input.grantId,
    applyEnd: new Date("2026-08-01T00:00:00.000Z"),
    jobId: `job-${input.grantId}`,
    jobPriority: 0,
    jobStatus: "pending" as const,
    sourceRevisionSha256: input.grantId.padEnd(64, "a").slice(0, 64),
    hasHwp: false,
    dimensionCount: 22,
    needsReview: false,
    matchExposureCount: 0,
    ...input,
  };
}

const ordered = orderDeepAnalysisCohortCandidates([
  candidate({ grantId: "b-late", source: "bizinfo", dDay: 30, hasHwp: true }),
  candidate({ grantId: "k-urgent", source: "kstartup", dDay: 2 }),
  candidate({ grantId: "b-urgent", source: "bizinfo", dDay: 3 }),
  candidate({
    grantId: "k-hwp",
    source: "kstartup",
    dDay: 20,
    hasHwp: true,
    dimensionCount: 1,
  }),
]);
assert.deepEqual(
  ordered.map((item) => item.grantId),
  ["k-urgent", "b-urgent", "k-hwp", "b-late"],
  "source별 상위 후보를 round-robin하되 각 source 안에서는 계획 우선순위를 보존한다",
);
assert.equal(
  orderDeepAnalysisCohortCandidates([
    candidate({ grantId: "late-hwp", source: "bizinfo", dDay: 20, hasHwp: true }),
    candidate({ grantId: "urgent-text", source: "bizinfo", dDay: 1 }),
  ])[0]?.grantId,
  "urgent-text",
  "D-day 7일 이내가 HWP 보유보다 우선한다",
);

console.log("deep-analysis cohort tests passed");
