import { closeCunoteDb, getCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  listDeepAnalysisCohortCandidates,
  orderDeepAnalysisCohortCandidates,
} from "./cohort";
import { prepareDeepAnalysisInput } from "./prepareInput";
import { sha256Hex, stableJson } from "./sourceRevision";
import {
  deepAnalysisClaimCohortSha256,
  resolveDeepAnalysisWorkerPolicy,
} from "./workerPolicy";

loadMonorepoEnv();

const limit = numberArg("limit", 20, 1, 100);
const scanLimit = numberArg("scan-limit", Math.max(200, limit * 10), limit, 2_000);
const db = getCunoteDb();
const storage = createR2ObjectStorageFromEnv();
if (!storage) throw new Error("R2 storage environment is incomplete");
const policy = resolveDeepAnalysisWorkerPolicy({
  ...process.env,
  DEEP_ANALYSIS_WORKER_MODE: "observe_only",
});

try {
  const candidates = orderDeepAnalysisCohortCandidates(
    await listDeepAnalysisCohortCandidates({
      db,
      modelPolicyVersion: policy.modelPolicyVersion,
      limit: scanLimit,
    }),
  );
  const items = [];
  const skipped = [];
  for (const [rank, candidate] of candidates.entries()) {
    if (items.length >= limit) break;
    try {
      const seal = await prepareDeepAnalysisInput({
        db,
        storage,
        grantId: candidate.grantId,
        maxTotalChars: policy.maxTotalInputChars,
      });
      if (!seal.sealed) {
        skipped.push({
          grantId: candidate.grantId,
          source: candidate.source,
          sourceId: candidate.sourceId,
          reason: "input_not_sealed",
          blockers: [...new Set(seal.blockers.map((blocker) => blocker.code))],
        });
        continue;
      }
      if (seal.sourceRevisionSha256 !== candidate.sourceRevisionSha256) {
        skipped.push({
          grantId: candidate.grantId,
          source: candidate.source,
          sourceId: candidate.sourceId,
          reason: "job_source_revision_stale",
        });
        continue;
      }
      items.push({
        rank: rank + 1,
        grantId: candidate.grantId,
        source: candidate.source,
        sourceId: candidate.sourceId,
        title: candidate.title,
        dDay: candidate.dDay,
        hasHwp: candidate.hasHwp,
        dimensionCount: candidate.dimensionCount,
        needsReview: candidate.needsReview,
        matchExposureCount: candidate.matchExposureCount,
        jobId: candidate.jobId,
        jobPriority: candidate.jobPriority,
        sourceRevisionSha256: candidate.sourceRevisionSha256,
        inputSha256: seal.inputSha256,
        attachmentManifestSha256: seal.attachmentManifestSha256,
      });
    } catch (error) {
      skipped.push({
        grantId: candidate.grantId,
        source: candidate.source,
        sourceId: candidate.sourceId,
        reason: "verification_error",
        error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
      });
    }
  }
  const grantIds = items.map((item) => item.grantId);
  const claimCohortSha256 = deepAnalysisClaimCohortSha256(grantIds);
  const manifestBody = {
    schema: "deep-analysis-claim-cohort-manifest-v1",
    generatedAt: new Date().toISOString(),
    modelPolicyVersion: policy.modelPolicyVersion,
    requestedCount: limit,
    selectedCount: items.length,
    claimCohortSha256,
    items,
    skipped,
  };
  const output = {
    ...manifestBody,
    manifestSha256: sha256Hex(stableJson(manifestBody)),
    activationEnv: {
      DEEP_ANALYSIS_CLAIM_SCOPE: "bounded",
      DEEP_ANALYSIS_CLAIM_GRANT_IDS: [...grantIds].sort().join(","),
      DEEP_ANALYSIS_CLAIM_COHORT_SHA256: claimCohortSha256,
    },
    passed: items.length === limit,
  };
  console.log(JSON.stringify(output, null, 2));
  if (!output.passed) process.exitCode = 2;
} finally {
  await closeCunoteDb();
}

function numberArg(name: string, fallback: number, min: number, max: number): number {
  const prefix = `--${name}=`;
  const raw = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  const value = raw ? Number(raw) : fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}
