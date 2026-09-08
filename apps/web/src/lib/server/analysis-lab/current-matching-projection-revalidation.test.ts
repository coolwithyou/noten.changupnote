import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { LabRun } from "./lab-contract";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
} from "./application-roundtrip/contract";
import {
  buildAnalysisLaunchMatchingProjectionBinding,
  buildPrimaryMatchingProjectionSnapshot,
  primaryMatchingProjectionSnapshotSha256,
  primaryProjectionSource,
} from "./primary-matching-projection";
import {
  encodeCanonical,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchGrant,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";
import {
  CURRENT_MATCHING_PROJECTION_SOURCE_EVIDENCE_SCHEMA,
  currentMatchingProjectionRevalidationPath,
  sealCurrentMatchingProjectionRevalidation,
  verifyCurrentMatchingProjectionRevalidation,
  type CurrentMatchingProjectionRevalidationRequest,
  type CurrentMatchingProjectionSourceEvidence,
} from "./current-matching-projection-revalidation";

const GRANT_ID = "00000000-0000-4000-8000-0000000009b0";
const RUN_ID = "run-2026-09-09T000000.000Z-current-projection";
const INPUT_SHA256 = "1".repeat(64);
const ATTACHMENT_SHA256 = "2".repeat(64);
const SOURCE_REVISION_SHA256 = "3".repeat(64);
const SOURCE_RAW_SHA256 = "4".repeat(64);
const roots: string[] = [];
let fetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  fetchCalls += 1;
  throw new Error("network access is forbidden in current projection revalidation tests");
}) as typeof fetch;

try {
  const fixture = await createFixture();
  const originalRunBytes = await readFile(fixture.runPath);
  const originalReceiptBytes = await readFile(fixture.receiptPath);
  const sealed = await sealCurrentMatchingProjectionRevalidation(fixture.request);
  assert.equal(sealed.artifact.authority.diagnosticOnly, true);
  assert.equal(sealed.artifact.authority.currentEvidenceOrigin, "caller_supplied_snapshot");
  assert.equal(sealed.artifact.authority.projectionInputOrigin, "immutable_original_run");
  assert.equal(sealed.artifact.authority.liveCurrentStateVerified, false);
  assert.equal(sealed.artifact.authority.serviceDatabaseReadPerformed, false);
  assert.equal(sealed.artifact.authority.serviceDatabaseWritesMade, 0);
  assert.equal(sealed.artifact.authority.modelCallsMade, 0);
  assert.equal(sealed.artifact.authority.originalArtifactsModified, false);
  assert.equal(sealed.artifact.authority.independentReviewPerformed, false);
  assert.equal(sealed.artifact.authority.promotionAuthorized, false);
  assert.equal(sealed.artifact.authority.launchAuthorized, false);
  assert.equal(sealed.artifact.authority.finalReleaseRequiresLiveCurrentEvidenceRecheck, true);
  assert.equal(sealed.artifact.historicalProjection.snapshot, null);
  assert.deepEqual(sealed.artifact.historicalProjection.inspection, {
    status: "unverified",
    issues: ["matching_projection_snapshot_missing"],
  });
  assert.deepEqual(sealed.artifact.historicalProjection.receiptBindingInspection, {
    status: "unverified",
    issues: ["matching_projection_receipt_binding_missing"],
  });
  assert.equal(
    sealed.artifact.currentProjection.inspection.status,
    "verified",
    "새 current projection이 성공해도 역사 snapshot 부재는 별도 unverified로 남아야 한다",
  );
  assert.deepEqual(sealed.artifact.currentEvidenceComparison, {
    exactRunBindingVerified: true,
    sourceRevision: "same",
  });
  assert.equal(
    sealed.path,
    currentMatchingProjectionRevalidationPath(sealed.artifactSha256, fixture.root),
  );
  assert.equal(sha256(await readFile(sealed.path)), sealed.artifactSha256);
  assert.deepEqual(await readFile(fixture.runPath), originalRunBytes);
  assert.deepEqual(await readFile(fixture.receiptPath), originalReceiptBytes);

  const idempotent = await sealCurrentMatchingProjectionRevalidation(fixture.request);
  assert.equal(idempotent.artifactSha256, sealed.artifactSha256);
  assert.equal(idempotent.path, sealed.path);

  const reobservedRequest = requestWithEvidence(fixture.request, {
    observedAt: "2026-09-09T01:00:00.000Z",
    sourceRevisionSha256: "5".repeat(64),
  });
  const reobserved = await sealCurrentMatchingProjectionRevalidation(reobservedRequest);
  assert.notEqual(
    reobserved.artifactSha256,
    sealed.artifactSha256,
    "새 current 관측은 원 run을 덮어쓰지 않고 별도 content-addressed artifact여야 한다",
  );
  assert.equal(
    reobserved.artifact.currentEvidenceComparison.sourceRevision,
    "changed",
    "current source revision drift는 input exact binding과 섞지 않고 명시적으로 보존한다",
  );

  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation(requestWithEvidence(fixture.request, {
      inputSha256: "6".repeat(64),
    })),
    /current evidence.*exact binding/,
  );
  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation(requestWithEvidence(fixture.request, {
      attachmentManifestSha256: "7".repeat(64),
    })),
    /current evidence.*exact binding/,
  );
  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation({
      ...fixture.request,
      runId: "wrong-run-id",
    }),
    /run\/manifest\/request exact binding/,
  );
  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation({
      ...fixture.request,
      grantId: "00000000-0000-4000-8000-0000000009b1",
    }),
    /target grantId.*exact binding/,
  );

  const alternativeReceipt = await writeAnalysisLaunchArtifact("receipts", {
    ...fixture.receipt,
    finishedAt: "2026-09-09T00:00:04.000Z",
  }, fixture.root);
  await assert.rejects(
    verifyCurrentMatchingProjectionRevalidation({
      ...fixture.request,
      launchReceiptSha256: alternativeReceipt.sha256,
      artifactSha256: sealed.artifactSha256,
    }),
    /sidecar.*original\/current evidence.*runtime/,
    "다른 valid receipt로 기존 sidecar를 대체할 수 없어야 한다",
  );

  const historicalDrift = await createFixture({ historicalRuntimeDrift: true });
  const historicalDriftSidecar = await sealCurrentMatchingProjectionRevalidation(
    historicalDrift.request,
  );
  assert.equal(historicalDriftSidecar.artifact.historicalProjection.inspection.status, "mismatch");
  assert.match(
    historicalDriftSidecar.artifact.historicalProjection.inspection.issues.join("+"),
    /runtime_binding_mismatch/,
  );
  assert.equal(historicalDriftSidecar.artifact.currentProjection.inspection.status, "verified");

  const runtimeChangedArtifact = structuredClone(sealed.artifact);
  runtimeChangedArtifact.currentProjection.snapshot.runtime.matcherRulesetVersion =
    "future-matcher-ruleset";
  const runtimeChangedBytes = encodeCanonical({
    ...runtimeChangedArtifact,
    currentProjection: {
      ...runtimeChangedArtifact.currentProjection,
      snapshotSha256: primaryMatchingProjectionSnapshotSha256(
        runtimeChangedArtifact.currentProjection.snapshot,
      ),
    },
  });
  const runtimeChangedSha256 = sha256(runtimeChangedBytes);
  const runtimeChangedPath = currentMatchingProjectionRevalidationPath(
    runtimeChangedSha256,
    fixture.root,
  );
  await mkdir(dirname(runtimeChangedPath), { recursive: true });
  await writeFile(runtimeChangedPath, runtimeChangedBytes, { flag: "wx" });
  await assert.rejects(
    verifyCurrentMatchingProjectionRevalidation({
      ...fixture.request,
      artifactSha256: runtimeChangedSha256,
    }),
    /sidecar.*현행 runtime/,
    "과거 runtime으로 봉인된 sidecar는 현재 runtime 재검증을 통과할 수 없어야 한다",
  );

  const mutatedRun = await createFixture();
  const mutatedRunSidecar = await sealCurrentMatchingProjectionRevalidation(mutatedRun.request);
  await writeFile(mutatedRun.runPath, encodeCanonical({ ...mutatedRun.run, title: "tampered" }));
  await assert.rejects(
    verifyCurrentMatchingProjectionRevalidation({
      ...mutatedRun.request,
      artifactSha256: mutatedRunSidecar.artifactSha256,
    }),
    /원 run artifact raw SHA/,
  );

  const tamperedBytes = Buffer.from(await readFile(sealed.path));
  tamperedBytes[tamperedBytes.length - 2] = tamperedBytes[tamperedBytes.length - 2] === 48 ? 49 : 48;
  await writeFile(sealed.path, tamperedBytes);
  await assert.rejects(
    verifyCurrentMatchingProjectionRevalidation({
      ...fixture.request,
      artifactSha256: sealed.artifactSha256,
    }),
    /sidecar raw SHA/,
  );

  const moduleSource = await readFile(fileURLToPath(new URL(
    "./current-matching-projection-revalidation.ts",
    import.meta.url,
  )), "utf8");
  assert.doesNotMatch(moduleSource, /getCunoteDb|createR2ObjectStorageFromEnv|claude-cli-transport/);
  assert.equal(fetchCalls, 0, "sidecar seal/verify는 network를 호출하지 않아야 한다");

  console.log("current matching projection revalidation tests: ok");
} finally {
  globalThis.fetch = originalFetch;
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
}

async function createFixture(options: {
  historicalRuntimeDrift?: boolean;
} = {}): Promise<{
  root: string;
  request: CurrentMatchingProjectionRevalidationRequest;
  runPath: string;
  receiptPath: string;
  run: LabRun;
  receipt: AnalysisLaunchReceipt;
}> {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-projection-sidecar-"));
  roots.push(root);
  const manifest: AnalysisLaunchManifest = {
    schema: "analysis-launch-manifest-v1",
    preparedAt: "2026-09-09T00:00:00.000Z",
    source: {
      kind: "formal_plan",
      seriesId: "current-projection-test",
      planSha256: "8".repeat(64),
      planArtifactSha256: "9".repeat(64),
      adoptionManifestSha256: null,
      sequenceFrom: 0,
      sequenceTo: 0,
    },
    execution: {
      transport: "claude-cli",
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      promptVersion: "lab-deep-v21",
      validatorVersion: "deep-analysis-validator-test",
      packageRuntimeSha256: "a".repeat(64),
      gitShaAtPreparation: "b".repeat(40),
      withApplicationRoundtrip: true,
      roundtripModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
      concurrency: 1,
      existingRunPolicy: "skip_existing",
    },
    targets: [{
      sequence: 0,
      grantId: GRANT_ID,
      stratum: "bizinfo/test",
      inputSha256: INPUT_SHA256,
      attachmentManifestSha256: ATTACHMENT_SHA256,
      inventoryInputSha256: INPUT_SHA256,
      inventoryAttachmentManifestSha256: ATTACHMENT_SHA256,
      changedSinceInventory: false,
    }],
  };
  const storedManifest = await writeAnalysisLaunchArtifact("manifests", manifest, root);
  const grant: AnalysisLaunchGrant = {
    schema: "analysis-launch-grant-v1",
    manifestSha256: storedManifest.sha256,
    approvedBy: "sidecar-test",
    approvedAt: "2026-09-09T00:00:01.000Z",
    scope: "launch-batch-live",
    stopAfter: "manifest-terminal",
    targetCount: 1,
  };
  const storedGrant = await writeAnalysisLaunchArtifact("grants", grant, root);
  const run = fixtureRun();
  if (options.historicalRuntimeDrift) {
    const source = primaryProjectionSource({
      runId: run.runId,
      grantId: run.grantId,
      source: run.source,
      sourceId: run.sourceId,
      inputSha256: run.inputSha256,
      attachmentManifestSha256: run.attachmentManifestSha256!,
      criteria: run.criteria,
    });
    const snapshot = buildPrimaryMatchingProjectionSnapshot({
      source,
      primaryExtractionAvailable: true,
    });
    snapshot.runtime.matcherRulesetVersion = "historical-matcher-ruleset";
    run.primaryMatchingProjection = snapshot;
  }
  const runPath = join(root, "spike-out", "analysis-lab", "test", `${RUN_ID}.json`);
  await mkdir(dirname(runPath), { recursive: true });
  const runBytes = encodeCanonical(run);
  await writeFile(runPath, runBytes);
  const runArtifactSha256 = sha256(runBytes);
  const receipt: AnalysisLaunchReceipt = {
    schema: "analysis-launch-receipt-v1",
    grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: "2026-09-09T00:00:02.000Z",
    finishedAt: "2026-09-09T00:00:03.000Z",
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: 1, held: 0, failed: 0, skipped: 0 },
    targets: [{
      sequence: 0,
      grantId: GRANT_ID,
      status: "publishable",
      runArtifactPath: relative(root, runPath).split(sep).join("/"),
      runArtifactSha256,
      applicationRoundtripStatus: null,
      applicationDocumentCount: null,
      fieldReadyDocumentCount: null,
      recognizedFieldCount: null,
      ...(run.primaryMatchingProjection
        ? { primaryMatchingProjection: buildAnalysisLaunchMatchingProjectionBinding(
            run.primaryMatchingProjection,
          ) }
        : {}),
      error: null,
    }],
  };
  const storedReceipt = await writeAnalysisLaunchArtifact("receipts", receipt, root);
  const currentEvidence: CurrentMatchingProjectionSourceEvidence = {
    schema: CURRENT_MATCHING_PROJECTION_SOURCE_EVIDENCE_SCHEMA,
    observedAt: "2026-09-09T00:30:00.000Z",
    grantId: GRANT_ID,
    runId: RUN_ID,
    source: "bizinfo",
    sourceId: "sidecar-source-1",
    sourceRevisionSha256: SOURCE_REVISION_SHA256,
    sourceRawSha256: SOURCE_RAW_SHA256,
    inputSha256: INPUT_SHA256,
    attachmentManifestSha256: ATTACHMENT_SHA256,
    status: "open",
    servingState: "visible",
    applicationOpen: true,
    hasDeepAnalysisRun: false,
    hasPromotionItem: false,
    confirmedDuplicate: false,
  };
  return {
    root,
    request: {
      repositoryRoot: root,
      launchReceiptSha256: storedReceipt.sha256,
      sequence: 0,
      grantId: GRANT_ID,
      runId: RUN_ID,
      currentEvidence,
    },
    runPath,
    receiptPath: storedReceipt.path,
    run,
    receipt,
  };
}

function fixtureRun(): LabRun {
  return {
    runId: RUN_ID,
    grantId: GRANT_ID,
    source: "bizinfo",
    sourceId: "sidecar-source-1",
    title: "current matching projection sidecar fixture",
    model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    transport: "claude-cli",
    promptVersion: "lab-deep-v21",
    startedAt: "2026-09-09T00:00:02.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: INPUT_SHA256,
    sourceRevisionSha256: SOURCE_REVISION_SHA256,
    attachmentManifestSha256: ATTACHMENT_SHA256,
    usage: null,
    costUsd: null,
    analysisMarkdown: "분석",
    programIntent: null,
    criteria: [{
      dimension: "other",
      kind: "required",
      operator: "text_only",
      value: { note: "서울 소재" },
      confidence: 0.9,
      sourceSpan: "서울 소재 기업",
      spanVerified: true,
      note: null,
    }],
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    primaryRepairCount: 0,
    primaryValidationOutcome: "publishable",
    matchingReadiness: "conditional",
    error: null,
  };
}

function requestWithEvidence(
  request: CurrentMatchingProjectionRevalidationRequest,
  evidence: Partial<CurrentMatchingProjectionSourceEvidence>,
): CurrentMatchingProjectionRevalidationRequest {
  return {
    ...request,
    currentEvidence: { ...request.currentEvidence, ...evidence },
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
