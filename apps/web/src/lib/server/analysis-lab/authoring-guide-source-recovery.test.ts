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
  createAuthoringGuideSourceRecoveryManifest,
  hashAuthoringGuideSourceRecoveryManifest,
} from "./authoring-guide-source-recovery";
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
await rm(repositoryRoot, { recursive: true, force: true });

console.log("authoring-guide-source-recovery tests passed");
