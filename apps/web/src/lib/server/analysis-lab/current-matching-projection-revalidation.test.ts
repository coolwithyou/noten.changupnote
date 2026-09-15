import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ANALYSIS_LAB_PROMPT_VERSION, type LabRun } from "./lab-contract";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "../deep-analysis/validator";
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
  normalizeAnalysisLaunchManifest,
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
const OTHER_GRANT_ID = "00000000-0000-4000-8000-0000000009b1";
interface FixtureManifestContract {
  readonly sourceKind: "formal_plan" | "current_inventory" | "independent_review_repair" | "authoring_guide_adoption" | null;
  readonly existingRunPolicy: "skip_existing" | "rerun_exact_targets" | null;
  readonly promptVersion: string;
  readonly validatorVersion: string;
  readonly applicationFieldAnalysisVersion: string | null;
  readonly withApplicationRoundtrip?: boolean;
  readonly liveNormalizerAccepted?: boolean;
}
const HISTORICAL_CONTRACTS: readonly FixtureManifestContract[] = [
  { sourceKind: "formal_plan", existingRunPolicy: "skip_existing", promptVersion: "lab-deep-v21", validatorVersion: "deep-analysis-validator-v14", applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v9" },
  { sourceKind: "current_inventory", existingRunPolicy: "skip_existing", promptVersion: "lab-deep-v22", validatorVersion: "deep-analysis-validator-v15", applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v9" },
  { sourceKind: "independent_review_repair", existingRunPolicy: "rerun_exact_targets", promptVersion: "lab-deep-v21", validatorVersion: "deep-analysis-validator-v14", applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v9" },
  { sourceKind: null, existingRunPolicy: null, promptVersion: "lab-deep-v17", validatorVersion: "deep-analysis-validator-v10", applicationFieldAnalysisVersion: null },
  { sourceKind: "formal_plan", existingRunPolicy: "skip_existing", promptVersion: "lab-deep-v17", validatorVersion: "deep-analysis-validator-v10", applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v9" },
  { sourceKind: "current_inventory", existingRunPolicy: "skip_existing", promptVersion: "lab-deep-v22", validatorVersion: "deep-analysis-validator-v16", applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v11" },
  { sourceKind: "independent_review_repair", existingRunPolicy: "rerun_exact_targets", promptVersion: "lab-deep-v18", validatorVersion: "deep-analysis-validator-v11", applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v9" },
  { sourceKind: "authoring_guide_adoption", existingRunPolicy: "rerun_exact_targets", promptVersion: "lab-deep-v17", validatorVersion: "deep-analysis-validator-v10", applicationFieldAnalysisVersion: null, withApplicationRoundtrip: false, liveNormalizerAccepted: true },
];
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
  assert.doesNotThrow(() => normalizeAnalysisLaunchManifest(fixture.manifest));

  for (const contract of HISTORICAL_CONTRACTS) {
    const historical = await createFixture({ manifestContract: contract });
    const historicalSeal = await sealCurrentMatchingProjectionRevalidation(historical.request)
      .catch((cause: unknown) => {
        throw new Error(`역사 manifest offline 소비 실패: ${JSON.stringify(contract)}`, { cause });
      });
    assert.equal(historicalSeal.artifact.original.runId, RUN_ID);
    if (contract.liveNormalizerAccepted) {
      assert.doesNotThrow(
        () => normalizeAnalysisLaunchManifest(historical.manifest),
        "primary-only authoring guide manifest의 기존 live normalizer 수용을 바꾸지 않는다",
      );
    } else {
      assert.throws(
        () => normalizeAnalysisLaunchManifest(historical.manifest),
        /launch source\/existing run 정책 결속/,
        `역사 manifest를 live admission으로 열면 안 된다: ${JSON.stringify(contract)}`,
      );
    }
  }

  const unknownHistorical = await createFixture({
    manifestContract: {
      sourceKind: "formal_plan",
      existingRunPolicy: "skip_existing",
      promptVersion: "lab-deep-v20",
      validatorVersion: "deep-analysis-validator-v13",
      applicationFieldAnalysisVersion: "kordoc-application-roundtrip-v8",
    },
  });
  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation(unknownHistorical.request),
    /launch source\/existing run 정책 결속/,
  );

  const unknownSchema = await createFixture({ manifestSchema: "analysis-launch-manifest-v2" });
  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation(unknownSchema.request),
    /launch manifest schema/,
  );

  const nonterminal = await createFixture({ receiptLifecycle: "running" });
  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation(nonterminal.request),
    /launch receipt 계약/,
  );

  const targetMismatch = await createFixture({ receiptTargetGrantId: OTHER_GRANT_ID });
  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation(targetMismatch.request),
    /receipt target.*manifest exact target/,
  );

  const incompleteReceipt = await createFixture({ omitRunArtifactBinding: true });
  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation(incompleteReceipt.request),
    /원 run artifact 결속/,
  );

  const tamperedManifest = await createFixture({ manifestContract: HISTORICAL_CONTRACTS[0]! });
  await writeFile(tamperedManifest.manifestPath, encodeCanonical({
    ...tamperedManifest.manifest,
    preparedAt: "2026-09-09T00:00:01.000Z",
  }));
  await assert.rejects(
    sealCurrentMatchingProjectionRevalidation(tamperedManifest.request),
    /launch manifests artifact SHA/,
  );

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
  manifestContract?: FixtureManifestContract;
  manifestSchema?: string;
  receiptLifecycle?: string;
  receiptTargetGrantId?: string;
  omitRunArtifactBinding?: boolean;
} = {}): Promise<{
  root: string;
  request: CurrentMatchingProjectionRevalidationRequest;
  runPath: string;
  receiptPath: string;
  manifestPath: string;
  manifest: AnalysisLaunchManifest;
  run: LabRun;
  receipt: AnalysisLaunchReceipt;
}> {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-projection-sidecar-"));
  roots.push(root);
  const contract = options.manifestContract;
  const sourceKind = contract ? contract.sourceKind : "formal_plan";
  const promptVersion = contract?.promptVersion ?? ANALYSIS_LAB_PROMPT_VERSION;
  const planSha256 = "8".repeat(64);
  const withApplicationRoundtrip = contract?.withApplicationRoundtrip ?? true;
  const manifest = {
    schema: options.manifestSchema ?? "analysis-launch-manifest-v1",
    preparedAt: "2026-09-09T00:00:00.000Z",
    source: {
      ...(sourceKind === null ? {} : { kind: sourceKind }),
      seriesId: "current-projection-test",
      planSha256,
      planArtifactSha256: sourceKind === "current_inventory"
        || sourceKind === "independent_review_repair"
        || sourceKind === "authoring_guide_adoption"
        ? planSha256
        : "9".repeat(64),
      ...(sourceKind === null
        ? {}
        : { adoptionManifestSha256: sourceKind === "authoring_guide_adoption" ? planSha256 : null }),
      sequenceFrom: 0,
      sequenceTo: 0,
    },
    execution: {
      transport: "claude-cli",
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      promptVersion,
      validatorVersion: contract?.validatorVersion ?? DEEP_ANALYSIS_VALIDATOR_VERSION,
      packageRuntimeSha256: "a".repeat(64),
      gitShaAtPreparation: "b".repeat(40),
      withApplicationRoundtrip,
      roundtripModel: withApplicationRoundtrip ? APPLICATION_ROUNDTRIP_ADOPTED_MODEL : null,
      ...(contract?.applicationFieldAnalysisVersion === null
        ? {}
        : { applicationFieldAnalysisVersion:
          contract?.applicationFieldAnalysisVersion ?? APPLICATION_ROUNDTRIP_VERSION }),
      concurrency: 1,
      ...(contract?.existingRunPolicy === null
        ? {}
        : { existingRunPolicy: contract?.existingRunPolicy ?? "skip_existing" }),
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
  } as AnalysisLaunchManifest;
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
  const run = fixtureRun(promptVersion);
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
  const receipt = {
    schema: "analysis-launch-receipt-v1",
    grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: "2026-09-09T00:00:02.000Z",
    finishedAt: "2026-09-09T00:00:03.000Z",
    lifecycle: options.receiptLifecycle ?? "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: 1, held: 0, failed: 0, skipped: 0 },
    targets: [{
      sequence: 0,
      grantId: options.receiptTargetGrantId ?? GRANT_ID,
      status: "publishable",
      runArtifactPath: options.omitRunArtifactBinding
        ? null
        : relative(root, runPath).split(sep).join("/"),
      runArtifactSha256: options.omitRunArtifactBinding ? null : runArtifactSha256,
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
  } as AnalysisLaunchReceipt;
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
    manifestPath: storedManifest.path,
    manifest,
    run,
    receipt,
  };
}

function fixtureRun(promptVersion = ANALYSIS_LAB_PROMPT_VERSION): LabRun {
  return {
    runId: RUN_ID,
    grantId: GRANT_ID,
    source: "bizinfo",
    sourceId: "sidecar-source-1",
    title: "current matching projection sidecar fixture",
    model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    transport: "claude-cli",
    promptVersion,
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
