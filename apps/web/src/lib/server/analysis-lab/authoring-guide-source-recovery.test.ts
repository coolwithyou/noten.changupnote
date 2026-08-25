import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AuthoringGuideAdoptionManifest,
  AuthoringGuideAdoptionManifestItem,
} from "./authoring-guide-adoption";
import {
  writeAuthoringGuideAdoptionManifest,
} from "./authoring-guide-adoption-production";
import {
  assertAuthoringGuideSourceRecoveryManifest,
  createAuthoringGuideSourceRecoveryManifest,
  hashAuthoringGuideSourceRecoveryManifest,
} from "./authoring-guide-source-recovery";
import {
  createAuthoringGuideSourceRecoveryGrant,
  createAuthoringGuideSourceRecoveryReceipt,
  normalizeAuthoringGuideSourceRecoveryGrant,
  runAuthoringGuideSourceRecoveryRounds,
  type AuthoringGuideSourceRecoveryRoundResult,
} from "./authoring-guide-source-recovery-execution";
import { parseAuthoringGuideSourceRecoveryExecutionCliArgs } from "./authoring-guide-source-recovery-execution-cli";
import {
  approveAuthoringGuideSourceRecovery,
  assertExactAuthoringGuideSourceRecoveryMaterial,
  readAuthoringGuideSourceRecoveryExecutionArtifact,
} from "./authoring-guide-source-recovery-execution-production";
import { parseAuthoringGuideSourceRecoveryCliArgs } from "./authoring-guide-source-recovery-cli";
import {
  prepareAuthoringGuideSourceRecovery,
  sourceRecoveryRuntimeReadiness,
  writeAuthoringGuideSourceRecoveryManifest,
} from "./authoring-guide-source-recovery-production";

const A = "a".repeat(64);
const B = "b".repeat(64);
const C = "c".repeat(64);
const D = "d".repeat(64);

function item(input: {
  grantId: string;
  source: "bizinfo" | "kstartup";
  disposition: "projection_ready" | "source_recovery_required" | "rerun_required";
  blockers?: Array<{ code: string; attachmentId: string | null; message: string }>;
}): AuthoringGuideAdoptionManifestItem {
  const blockers = input.blockers ?? [];
  return {
    grantId: input.grantId,
    source: input.source,
    sourceId: `source-${input.grantId.slice(-1)}`,
    title: `공고 ${input.grantId.slice(-1)}`,
    disposition: input.disposition,
    reasons: blockers.length > 0 ? ["current_source_unsealed"] : [],
    requiresReleaseValidation: true,
    advisoryPreviewOnly: true,
    run: {
      runId: "run-2026-08-26T000000.000Z-ab12cd",
      artifactPath: "spike-out/run.json",
      artifactSha256: D,
      inputSha256: A,
      attachmentManifestSha256: B,
    },
    current: {
      inputSha256: A,
      attachmentManifestSha256: B,
      sourceRevisionSha256: C,
      sourceSealed: blockers.length === 0,
      operationalInputSha256: A,
      operationalAttachmentManifestSha256: B,
      sourceBlockers: blockers,
    },
    evidence: {
      programIntentPresent: true,
      criterionCount: 1,
      verifiedSourceSpanCount: 1,
      projectedCriterionCount: 1,
    },
    authoringGuidePreview: null,
  };
}

function adoptionManifest(): AuthoringGuideAdoptionManifest {
  return {
    schema: "authoring-guide-adoption-manifest-v1",
    preparedAt: "2026-08-26T01:00:00.000Z",
    asOfKst: "2026-08-26",
    execution: {
      mode: "offline_read_only",
      modelCallsMade: 0,
      databaseWritesMade: 0,
      promotionAuthorized: false,
    },
    population: {
      strictEligibleGrantCount: 538,
      historicalPublishableRunCount: 3,
    },
    summary: {
      projectionReady: 1,
      reviewRequired: 0,
      sourceRecoveryRequired: 1,
      rerunRequired: 1,
    },
    items: [
      item({
        grantId: "00000000-0000-4000-8000-000000000001",
        source: "bizinfo",
        disposition: "source_recovery_required",
        blockers: [{
          code: "blocked_conversion",
          attachmentId: "attachment-1",
          message: "conversion missing",
        }],
      }),
      item({
        grantId: "00000000-0000-4000-8000-000000000002",
        source: "kstartup",
        disposition: "rerun_required",
        blockers: [{
          code: "blocked_fetch",
          attachmentId: "attachment-2",
          message: "fetch failed",
        }],
      }),
      item({
        grantId: "00000000-0000-4000-8000-000000000003",
        source: "bizinfo",
        disposition: "projection_ready",
      }),
    ],
  };
}

const runtimeReadiness = {
  r2Configured: true,
  conversionServerConfigured: true,
  conversionSharedSecretConfigured: true,
};
const manifest = createAuthoringGuideSourceRecoveryManifest({
  adoptionManifestSha256: A,
  adoptionManifest: adoptionManifest(),
  runtimeReadiness,
  preparedAt: new Date("2026-08-26T02:00:00.000Z"),
});
assert.deepEqual(manifest.summary, {
  targetCount: 2,
  targetsBySource: { kstartup: 1, bizinfo: 1 },
  blockerCount: 2,
  blockersByCode: { blocked_fetch: 1, blocked_conversion: 1 },
  reclassifyAfterRecovery: 1,
  prepareRerunAfterRecovery: 1,
});
assert.equal(manifest.execution.readyForExactWriteGrant, true);
assert.equal(manifest.execution.databaseWritesAuthorized, false);
assert.equal(manifest.execution.objectStorageWritesAuthorized, false);
assert.equal(manifest.execution.externalLlmCallsAuthorized, false);
assert.equal(manifest.targets[0]?.nextActionAfterRecovery, "reclassify_adoption");
assert.equal(manifest.targets[1]?.nextActionAfterRecovery, "prepare_rerun_manifest");
assert.equal(hashAuthoringGuideSourceRecoveryManifest(manifest), hashAuthoringGuideSourceRecoveryManifest(manifest));
assert.equal(assertAuthoringGuideSourceRecoveryManifest(manifest), manifest);
assert.throws(() => assertAuthoringGuideSourceRecoveryManifest({
  ...manifest,
  execution: { ...manifest.execution, analysisJobsAuthorized: true },
} as never), /실행 계약/);

const grant = createAuthoringGuideSourceRecoveryGrant({
  manifestSha256: A,
  manifest,
  approvedBy: "owner",
  approvedAt: new Date("2026-08-26T02:10:00.000Z"),
});
assert.equal(normalizeAuthoringGuideSourceRecoveryGrant(grant).targetCount, 2);
assert.equal(grant.externalLlmCallsAuthorized, false);
assert.equal(grant.analysisJobsAuthorized, false);
assert.equal(grant.promotionAuthorized, false);

function roundResult(input: {
  selected: typeof manifest.targets;
  sealedGrantIds: readonly string[];
  withAnalysisJob?: boolean;
}): AuthoringGuideSourceRecoveryRoundResult {
  const sealed = new Set(input.sealedGrantIds);
  return {
    targets: input.selected.map((target) => ({
      grantId: target.grantId,
      source: target.source,
      sourceId: target.sourceId,
      sealed: sealed.has(target.grantId),
      blockerCodes: sealed.has(target.grantId) ? [] : [target.blockers[0]!.code],
      blockerCount: sealed.has(target.grantId) ? 0 : 1,
      sourceRevisionSha256: C,
      analysisJobId: input.withAnalysisJob ? "forbidden" as never : null,
      analysisJobStatus: null,
      error: null,
    })),
    metrics: {
      archivedCandidateCount: input.selected.length,
      selectedAttachmentCount: input.selected.length,
      archiveSucceededCount: input.selected.length,
      archiveFailedCount: 0,
      conversionCandidateAttachmentCount: 0,
      conversionJobsEnqueued: 0,
      conversionCacheHits: 0,
      conversionFailedCount: 0,
      conversionStillPendingCount: 0,
      pdfRecoveryCandidateCount: 0,
      pdfRecoverySucceededCount: 0,
      pdfRecoveryFailedCount: 0,
      deadlineReached: false,
      budgetExhausted: false,
      elapsedMs: 1,
    },
  };
}

let roundCalls = 0;
const execution = await runAuthoringGuideSourceRecoveryRounds({
  manifest,
  signal: new AbortController().signal,
  async runRound(selected) {
    roundCalls += 1;
    return roundResult({
      selected,
      sealedGrantIds: roundCalls === 1
        ? [manifest.targets[0]!.grantId]
        : [manifest.targets[1]!.grantId],
    });
  },
});
assert.equal(roundCalls, 2);
assert.equal(execution.recoveredTargetCount, 2);
assert.equal(execution.remainingTargetCount, 0);
assert.deepEqual(execution.rounds.map((round) => round.remainingTargetCount), [1, 0]);

let boundedCalls = 0;
const unresolvedExecution = await runAuthoringGuideSourceRecoveryRounds({
  manifest,
  signal: new AbortController().signal,
  async runRound(selected) {
    boundedCalls += 1;
    return roundResult({ selected, sealedGrantIds: [] });
  },
});
assert.equal(boundedCalls, 3);
assert.equal(unresolvedExecution.remainingTargetCount, 2);

await assert.rejects(() => runAuthoringGuideSourceRecoveryRounds({
  manifest,
  signal: new AbortController().signal,
  async runRound(selected) {
    return roundResult({ selected, sealedGrantIds: [], withAnalysisJob: true });
  },
}), /분석 job/);

const receipt = createAuthoringGuideSourceRecoveryReceipt({
  grantSha256: B,
  manifestSha256: A,
  manifest,
  execution,
  startedAt: new Date("2026-08-26T02:20:00.000Z"),
  finishedAt: new Date("2026-08-26T02:21:00.000Z"),
  adoptionManifest: adoptionManifest(),
  adoptionArtifact: { sha256: D, path: "spike-out/adoption.json" },
});
assert.equal(receipt.stopReason, "completed");
assert.equal(receipt.summary.externalLlmCalls, 0);
assert.equal(receipt.summary.analysisJobsEnqueued, 0);
assert.equal(receipt.summary.promotionAuthorized, false);

const notReady = createAuthoringGuideSourceRecoveryManifest({
  adoptionManifestSha256: A,
  adoptionManifest: adoptionManifest(),
  runtimeReadiness: { ...runtimeReadiness, conversionSharedSecretConfigured: false },
  preparedAt: new Date("2026-08-26T02:00:00.000Z"),
});
assert.equal(notReady.execution.readyForExactWriteGrant, false);

assert.deepEqual(parseAuthoringGuideSourceRecoveryCliArgs([
  `--adoption-manifest=${A}`,
]), { adoptionManifestSha256: A });
assert.throws(
  () => parseAuthoringGuideSourceRecoveryCliArgs(["--adoption-manifest=bad"]),
  /lab:authoring-guide:recovery:prepare/,
);
assert.deepEqual(sourceRecoveryRuntimeReadiness({
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "access",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
  R2_BUCKET_URL: "https://example.invalid",
  CONVERSION_SERVER_URL: "https://conversion.example.invalid",
  CONVERSION_SHARED_SECRET: "shared",
}), runtimeReadiness);
assert.deepEqual(parseAuthoringGuideSourceRecoveryExecutionCliArgs([
  "grant",
  `--manifest=${A}`,
  "--approved-by=owner",
]), { command: "grant", manifestSha256: A, approvedBy: "owner" });
assert.deepEqual(parseAuthoringGuideSourceRecoveryExecutionCliArgs([
  "run",
  `--grant=${B}`,
]), { command: "run", grantSha256: B });

const repositoryRoot = await mkdtemp(join(tmpdir(), "cunote-source-recovery-"));
const adoptionArtifact = await writeAuthoringGuideAdoptionManifest(adoptionManifest(), repositoryRoot);
const loaded = await prepareAuthoringGuideSourceRecovery({
  adoptionManifestSha256: adoptionArtifact.sha256,
  runtimeReadiness,
  preparedAt: new Date("2026-08-26T02:00:00.000Z"),
  repositoryRoot,
});
assert.equal(loaded.source.adoptionManifestSha256, adoptionArtifact.sha256);
const artifact = await writeAuthoringGuideSourceRecoveryManifest(loaded, repositoryRoot);
assert.equal(
  artifact.sha256,
  hashAuthoringGuideSourceRecoveryManifest(loaded),
);
assert.equal((await readFile(artifact.path, "utf8")).endsWith("\n"), true);
const grantArtifact = await approveAuthoringGuideSourceRecovery({
  manifestSha256: artifact.sha256,
  approvedBy: "owner",
  approvedAt: new Date("2026-08-26T02:10:00.000Z"),
  repositoryRoot,
});
const storedGrant = normalizeAuthoringGuideSourceRecoveryGrant(
  await readAuthoringGuideSourceRecoveryExecutionArtifact(
    "grants",
    grantArtifact.grantSha256,
    repositoryRoot,
  ),
);
assert.equal(storedGrant.manifestSha256, artifact.sha256);
assert.doesNotThrow(() => assertExactAuthoringGuideSourceRecoveryMaterial(
  loaded,
  adoptionManifest(),
));
const driftBase = adoptionManifest();
const drifted: AuthoringGuideAdoptionManifest = {
  ...driftBase,
  items: driftBase.items.map((entry, index) => index === 0
    ? { ...entry, current: { ...entry.current, operationalInputSha256: B } }
    : entry),
};
assert.throws(
  () => assertExactAuthoringGuideSourceRecoveryMaterial(loaded, drifted),
  /material이 준비 시점과 달라졌습니다/,
);
const productionSource = await readFile(join(
  process.cwd(),
  "apps/web/src/lib/server/analysis-lab/authoring-guide-source-recovery-execution-production.ts",
), "utf8");
assert.match(productionSource, /enqueuePreparedJobs: false/);
assert.doesNotMatch(productionSource, /resolveGrantImageOcrAdapter|verifyClaude|runLabAnalysis/);
assert.match(productionSource, /createDeepRepairLiveRuntimeAuthority/);
assert.match(productionSource, /assertExactAuthoringGuideSourceRecoveryMaterial\(manifest, current\)/);
await rm(repositoryRoot, { recursive: true, force: true });

console.log("authoring-guide-source-recovery tests passed");
