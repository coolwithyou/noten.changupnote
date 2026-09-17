import assert from "node:assert/strict";
import "./terminal-repair-source.test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CURRENT_INVENTORY_SCHEMA, buildCurrentInventoryLaunchManifest,
  MISSING_WORKSPACE_FIELDS_POLICY,
  TERMINAL_REPAIR_POLICY,
  currentLaunchInventoryPath, readCurrentLaunchInventory, storeCurrentLaunchInventory,
  readAndVerifyCompletedCurrentInventoryLaunch,
  validateCurrentLaunchInventory, verifyCurrentInventoryLaunchBinding,
  type CurrentLaunchInventory,
} from "./current-inventory-launch";
import { assertCurrentInventoryHistoryEligibility, assertMissingWorkspaceFieldsState, verifyCurrentInventoryLaunchTarget } from "./current-inventory-launch-production";
import { parseCurrentInventoryLaunchArgs } from "./current-inventory-launch-cli";
import { partitionCohortEntries } from "./batch-plan";
import { readDeepRepairHistoricalGrantIds } from "./deep-repair-preparation-history";
import { deepRepairTargetCountForSeries } from "./deep-repair-formal-policy";
import {
  encodeCanonical,
  normalizeAnalysisLaunchManifest,
  normalizeCompletedCurrentInventorySourceManifest,
  createAnalysisLaunchGrant,
  writeAnalysisLaunchArtifact,
  type AnalysisLaunchCompletedCurrentInventoryBinding,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";
import {
  prepareCompletedCurrentInventoryLaunchManifest,
  shouldForceExactManifestReanalysis,
} from "./launch-batch-production";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "../deep-analysis/validator";
import { APPLICATION_ROUNDTRIP_VERSION } from "./application-roundtrip/contract";

const id = (n: number) => `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`;
const digest = (value: unknown) => createHash("sha256").update(encodeCanonical(value)).digest("hex");
function inventory(count = 47): CurrentLaunchInventory {
  return { schema: CURRENT_INVENTORY_SCHEMA, seriesId: "current-20260910",
    observedAt: "2026-09-09T19:45:00.000Z", model: "claude-opus-5",
    policy: "open-visible-current-period-unseen-v1", historicalGrantIdsSha256: "a".repeat(64),
    targets: Array.from({ length: count }, (_, sequence) => ({ sequence, grantId: id(sequence),
      stratum: "bizinfo/medium", inputSha256: "b".repeat(64),
      attachmentManifestSha256: "c".repeat(64), sourceRevisionSha256: "d".repeat(64) })),
  };
}
function manifest(value = inventory()) {
  return buildCurrentInventoryLaunchManifest({ inventory: value, inventorySha256: digest(value),
    concurrency: 2, now: new Date("2026-09-09T20:00:00.000Z"),
    provenance: { gitSha: "1".repeat(40), packageRuntimeSha256: "e".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION } });
}

async function completedLaunchFixture(
  root: string,
  value = inventory(2),
  contract: "v14" | "v19" | "matching" = "v14",
) {
  const storedInventory = await storeCurrentLaunchInventory(root, value);
  const sourceManifest = structuredClone(contract === "matching"
    ? buildCurrentInventoryLaunchManifest({
        inventory: value,
        inventorySha256: storedInventory.sha256,
        analysisMode: "matching_only",
        concurrency: 1,
        now: new Date("2026-09-17T00:00:00.000Z"),
        provenance: {
          gitSha: "1".repeat(40),
          packageRuntimeSha256: "e".repeat(64),
          validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
        },
      })
    : manifest(value)) as any;
  if (contract !== "matching") {
    sourceManifest.execution.promptVersion = contract === "v14" ? "lab-deep-v26" : "lab-deep-v28";
    sourceManifest.execution.validatorVersion = contract === "v14"
      ? "deep-analysis-validator-v19"
      : "deep-analysis-validator-v23";
    sourceManifest.execution.applicationFieldAnalysisVersion = contract === "v14"
      ? "kordoc-application-roundtrip-v14"
      : "kordoc-application-roundtrip-v19";
  }
  const storedManifest = await writeAnalysisLaunchArtifact("manifests", sourceManifest, root);
  const sourceGrant = createAnalysisLaunchGrant({
    manifestSha256: storedManifest.sha256,
    targetCount: sourceManifest.targets.length,
    approvedBy: "test-reviewer",
    now: new Date("2026-09-09T20:01:00.000Z"),
  });
  const storedGrant = await writeAnalysisLaunchArtifact("grants", sourceGrant, root);
  const runArtifacts: Array<{ path: string; sha256: string }> = [];
  await mkdir(join(root, "spike-out", "runs"), { recursive: true });
  for (const target of value.targets) {
    const run = {
      runId: `run-2026-09-09T2002${String(target.sequence).padStart(2, "0")}.000Z-a1b2c3`,
      grantId: target.grantId,
      source: "bizinfo",
      sourceId: `source-${target.sequence}`,
      title: `공고 ${target.sequence}`,
      model: "claude-opus-5",
      transport: "claude-cli",
      promptVersion: sourceManifest.execution.promptVersion,
      startedAt: "2026-09-09T20:02:00.000Z",
      durationMs: 1,
      inputBlocks: [], inputTotalChars: 1,
      inputSha256: target.inputSha256,
      attachmentManifestSha256: target.attachmentManifestSha256,
      usage: null, costUsd: null, analysisMarkdown: "# 분석",
      programIntent: null, criteria: [], axisAssessments: [], taxonomyProposals: [],
      dimensionDiffs: [], primaryRepairCount: 0,
      primaryRepairProvenance: {
        deterministicPrimaryRepairCount: 0, modelPrimaryRepairCount: 0,
        newIssueAfterRepairCount: 0, blockingNewIssueAfterRepairCount: 0,
        sourceIncompleteIssueAfterRepairCount: 0, terminationReason: "publishable",
      },
      primaryValidationOutcome: "publishable",
      matchingReadiness: "conditional",
      primaryMatchingProjection: { verification: "verified" },
      error: null,
    };
    const bytes = Buffer.from(`${JSON.stringify(run)}\n`);
    const path = `spike-out/runs/${target.sequence}.json`;
    await writeFile(join(root, path), bytes);
    runArtifacts.push({ path, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const receipt: AnalysisLaunchReceipt = {
    schema: "analysis-launch-receipt-v1",
    grantSha256: storedGrant.sha256,
    manifestSha256: storedManifest.sha256,
    startedAt: "2026-09-09T20:02:00.000Z",
    finishedAt: "2026-09-09T20:03:00.000Z",
    lifecycle: "finished",
    stopReason: "completed",
    systemicFailure: null,
    summary: { publishable: value.targets.length, held: 0, failed: 0, skipped: 0 },
    targets: value.targets.map((target) => ({
      sequence: target.sequence,
      grantId: target.grantId,
      status: "publishable" as const,
      runArtifactPath: runArtifacts[target.sequence]!.path,
      runArtifactSha256: runArtifacts[target.sequence]!.sha256,
      applicationRoundtripStatus: contract === "matching" ? null : "complete",
      applicationDocumentCount: contract === "matching" ? null : 1,
      fieldReadyDocumentCount: contract === "matching" ? null : 1,
      recognizedFieldCount: contract === "matching" ? null : 1,
      error: null,
    })),
  };
  const storedReceipt = await writeAnalysisLaunchArtifact("receipts", receipt, root);
  const binding: AnalysisLaunchCompletedCurrentInventoryBinding = {
    schema: "analysis-launch-completed-current-inventory-v1",
    inventorySha256: storedInventory.sha256,
    sourceManifestSha256: storedManifest.sha256,
    sourceGrantSha256: storedGrant.sha256,
    terminalReceiptSha256: storedReceipt.sha256,
  };
  return { value, sourceManifest, sourceGrant, receipt, binding };
}

test("완료된 v14 current inventory ancestry만 현행 v17 exact 재실행으로 재봉인한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-"));
  try {
    const fixture = await completedLaunchFixture(root);
    assert.throws(
      () => normalizeAnalysisLaunchManifest(fixture.sourceManifest),
      /source\/existing run 정책 결속/,
      "역사 v14 manifest는 live normalizer에서 계속 거부",
    );
    assert.equal(
      normalizeCompletedCurrentInventorySourceManifest(fixture.sourceManifest)
        .execution.applicationFieldAnalysisVersion,
      "kordoc-application-roundtrip-v14",
    );
    assert.deepEqual(
      await readAndVerifyCompletedCurrentInventoryLaunch(root, fixture.binding),
      fixture.value,
    );
    const resealed = buildCurrentInventoryLaunchManifest({
      inventory: fixture.value,
      inventorySha256: fixture.binding.inventorySha256,
      completedLaunch: fixture.binding,
      concurrency: 1,
      now: new Date("2026-09-09T20:04:00.000Z"),
      provenance: {
        gitSha: "2".repeat(40),
        packageRuntimeSha256: "f".repeat(64),
        validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      },
    });
    assert.equal(resealed.execution.applicationFieldAnalysisVersion, APPLICATION_ROUNDTRIP_VERSION);
    assert.equal(resealed.execution.existingRunPolicy, "rerun_exact_targets");
    assert.deepEqual(resealed.source.completedLaunch, fixture.binding);
    assert.deepEqual(normalizeAnalysisLaunchManifest(resealed), resealed);
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, resealed), fixture.value);
    assert.equal(shouldForceExactManifestReanalysis({
      existingRunPolicy: resealed.execution.existingRunPolicy,
      retryErrors: false,
    }), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("재봉인 ancestry의 4SHA·inventory 전체 범위·terminal receipt 결속을 fail-closed한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-tamper-"));
  try {
    const fixture = await completedLaunchFixture(root);
    const writeSource = async (change: (source: any) => void) => {
      const source = structuredClone(fixture.sourceManifest) as any;
      change(source);
      const storedManifest = await writeAnalysisLaunchArtifact("manifests", source, root);
      const grant = createAnalysisLaunchGrant({
        manifestSha256: storedManifest.sha256,
        targetCount: source.targets.length,
        approvedBy: "test-reviewer",
        now: new Date("2026-09-09T20:06:00.000Z"),
      });
      const storedGrant = await writeAnalysisLaunchArtifact("grants", grant, root);
      const receipt: AnalysisLaunchReceipt = {
        ...fixture.receipt,
        manifestSha256: storedManifest.sha256,
        grantSha256: storedGrant.sha256,
        summary: { publishable: source.targets.length, held: 0, failed: 0, skipped: 0 },
        targets: source.targets.map((target: any) => ({
          ...fixture.receipt.targets[0]!,
          sequence: target.sequence,
          grantId: target.grantId,
          runArtifactPath: `spike-out/runs/${target.sequence}.json`,
          runArtifactSha256: digest({ changedRun: target.sequence }),
        })),
      };
      const storedReceipt = await writeAnalysisLaunchArtifact("receipts", receipt, root);
      return {
        source,
        binding: {
          ...fixture.binding,
          sourceManifestSha256: storedManifest.sha256,
          sourceGrantSha256: storedGrant.sha256,
          terminalReceiptSha256: storedReceipt.sha256,
        },
      };
    };
    const changedSeries = await writeSource((source) => { source.source.seriesId = "current-20260911"; });
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, changedSeries.binding), /범위/);
    const changedModel = await writeSource((source) => { source.execution.model = "claude-sonnet-5"; });
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, changedModel.binding), /범위/);
    const changedRange = await writeSource((source) => {
      source.source.sequenceTo = 2;
      source.targets.push({ ...source.targets[1], sequence: 2, grantId: id(20) });
    });
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, changedRange.binding), /범위/);
    const v9 = await writeSource((source) => {
      source.execution.applicationFieldAnalysisVersion = "kordoc-application-roundtrip-v9";
    });
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, {
      ...v9.binding,
    }), /exact v14/);
    const swappedReceipt: AnalysisLaunchReceipt = {
      ...fixture.receipt,
      targets: [
        { ...fixture.receipt.targets[1]!, sequence: 0 },
        { ...fixture.receipt.targets[0]!, sequence: 1 },
      ],
    };
    const storedSwappedReceipt = await writeAnalysisLaunchArtifact("receipts", swappedReceipt, root);
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, {
      ...fixture.binding, terminalReceiptSha256: storedSwappedReceipt.sha256,
    }), /receipt target/);
    const abortedReceipt: AnalysisLaunchReceipt = {
      ...fixture.receipt, stopReason: "aborted",
    };
    const storedAbortedReceipt = await writeAnalysisLaunchArtifact("receipts", abortedReceipt, root);
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, {
      ...fixture.binding, terminalReceiptSha256: storedAbortedReceipt.sha256,
    }), /ancestry 결속/);
    await assert.rejects(() => readAndVerifyCompletedCurrentInventoryLaunch(root, {
      ...fixture.binding, sourceGrantSha256: "f".repeat(64),
    }), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("재봉인 production prepare는 current input/source/provenance를 봉인 직전 재검증한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-production-"));
  try {
    const fixture = await completedLaunchFixture(root);
    const provenance = {
      gitSha: "2".repeat(40),
      packageRuntimeSha256: "f".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    };
    let provenanceReads = 0;
    let verifyReads = 0;
    let prepareReads = 0;
    const result = await prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      concurrency: 1,
    }, {
      repositoryRoot: root,
      now: () => new Date("2026-09-09T20:05:00.000Z"),
      readProvenance: async () => { provenanceReads += 1; return provenance; },
      verifyTarget: async (current, grantId) => {
        verifyReads += 1;
        assert.ok(current.targets.some((target) => target.grantId === grantId));
      },
      prepareTarget: async (grantId) => {
        prepareReads += 1;
        const target = fixture.value.targets.find((item) => item.grantId === grantId)!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
    });
    assert.equal(result.manifest.execution.existingRunPolicy, "rerun_exact_targets");
    assert.equal(provenanceReads, 2);
    assert.equal(prepareReads, fixture.value.targets.length * 2);
    assert.equal(verifyReads, fixture.value.targets.length * 3);
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, result.manifest), fixture.value);

    let writes = 0;
    let driftVerifyReads = 0;
    await assert.rejects(() => prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      concurrency: 1,
    }, {
      repositoryRoot: root,
      readProvenance: async () => provenance,
      verifyTarget: async () => {
        driftVerifyReads += 1;
        if (driftVerifyReads > fixture.value.targets.length * 2) throw new Error("공고 원천 drift");
      },
      prepareTarget: async (grantId) => {
        const target = fixture.value.targets.find((item) => item.grantId === grantId)!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
      writeManifest: async () => { writes += 1; throw new Error("write must not run"); },
    }), /공고 원천 drift/);
    assert.equal(writes, 0, "마지막 prepare 뒤 source drift면 manifest를 저장하지 않음");

    let provenanceCall = 0;
    await assert.rejects(() => prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      concurrency: 1,
    }, {
      repositoryRoot: root,
      readProvenance: async () => ({
        ...provenance,
        packageRuntimeSha256: (++provenanceCall === 1 ? "f" : "e").repeat(64),
      }),
      verifyTarget: async () => {},
      prepareTarget: async (grantId) => {
        const target = fixture.value.targets.find((item) => item.grantId === grantId)!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
      writeManifest: async () => { writes += 1; throw new Error("write must not run"); },
    }), /실행 코드가 변경/);
    assert.equal(writes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("완료된 v19 launch의 명시 sequence 부분집합만 v2 ancestry로 재봉인한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-subset-"));
  try {
    const fixture = await completedLaunchFixture(root, inventory(4), "v19");
    const provenance = {
      gitSha: "2".repeat(40),
      packageRuntimeSha256: "f".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    };
    const verifiedGrantIds: string[] = [];
    const preparedGrantIds: string[] = [];
    const result = await prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      selectedOriginalSequences: [1, 3],
      concurrency: 1,
    }, {
      repositoryRoot: root,
      now: () => new Date("2026-09-16T12:00:00.000Z"),
      readProvenance: async () => provenance,
      verifyTarget: async (current, grantId) => {
        verifiedGrantIds.push(grantId);
        assert.ok(current.targets.some((target) => target.grantId === grantId));
      },
      prepareTarget: async (grantId) => {
        preparedGrantIds.push(grantId);
        const target = fixture.value.targets.find((item) => item.grantId === grantId)!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
    });
    assert.deepEqual(result.manifest.targets.map((target) => ({
      sequence: target.sequence,
      grantId: target.grantId,
    })), [
      { sequence: 0, grantId: id(1) },
      { sequence: 1, grantId: id(3) },
    ]);
    assert.deepEqual(result.manifest.source.completedLaunch, {
      ...fixture.binding,
      schema: "analysis-launch-completed-current-inventory-v2",
      selectedOriginalSequences: [1, 3],
    });
    assert.deepEqual(preparedGrantIds, [id(1), id(3), id(1), id(3)]);
    assert.deepEqual(verifiedGrantIds, [id(1), id(3), id(1), id(3), id(1), id(3)]);
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, result.manifest), fixture.value);

    const substituted = structuredClone(result.manifest) as any;
    substituted.targets[0].grantId = id(0);
    await assert.rejects(
      () => verifyCurrentInventoryLaunchBinding(root, substituted),
      /launch target이 current inventory와 다릅니다/,
    );
    assert.throws(() => normalizeAnalysisLaunchManifest({
      ...result.manifest,
      source: {
        ...result.manifest.source,
        completedLaunch: {
          ...result.manifest.source.completedLaunch,
          selectedOriginalSequences: [1, 1],
        },
      },
    }), /중복/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("application-only 재봉인은 완료 receipt의 publishable primary bytes를 exact 결속한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-application-only-"));
  try {
    const fixture = await completedLaunchFixture(root, inventory(2), "v19");
    const provenance = {
      gitSha: "2".repeat(40),
      packageRuntimeSha256: "f".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    };
    const result = await prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      selectedOriginalSequences: [1],
      applicationOnly: true,
      concurrency: 1,
    }, {
      repositoryRoot: root,
      now: () => new Date("2026-09-16T15:00:00.000Z"),
      readProvenance: async () => provenance,
      verifyTarget: async () => {},
      prepareTarget: async (grantId) => {
        const target = fixture.value.targets[1]!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
    });
    assert.equal(result.manifest.execution.analysisMode, "application_only");
    assert.equal(result.manifest.targets.length, 1);
    assert.deepEqual(result.manifest.targets[0]?.primaryReuse, {
      schema: "analysis-launch-primary-reuse-v1",
      sourceSequence: 1,
      sourceLabRunId: "run-2026-09-09T200201.000Z-a1b2c3",
      sourceLabRunArtifactPath: "spike-out/runs/1.json",
      sourceLabRunArtifactSha256: fixture.receipt.targets[1]!.runArtifactSha256,
      sourceLaunchReceiptSha256: fixture.binding.terminalReceiptSha256,
    });
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, result.manifest), fixture.value);

    const malformed = structuredClone(result.manifest) as any;
    malformed.targets[0].primaryReuse.sourceLaunchReceiptSha256 = "0".repeat(64);
    assert.throws(() => normalizeAnalysisLaunchManifest(malformed), /receipt/);

    const wrongSequence = structuredClone(result.manifest) as any;
    wrongSequence.targets[0].primaryReuse.sourceSequence = 0;
    await assert.rejects(
      verifyCurrentInventoryLaunchBinding(root, normalizeAnalysisLaunchManifest(wrongSequence)),
      /완료 receipt/,
    );
    const wrongRunId = structuredClone(result.manifest) as any;
    wrongRunId.targets[0].primaryReuse.sourceLabRunId = "run-wrong";
    await assert.rejects(
      verifyCurrentInventoryLaunchBinding(root, normalizeAnalysisLaunchManifest(wrongRunId)),
      /run 계약/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("application-only는 새 matching-only v2 부모의 primary를 재호출 없이 exact 재사용한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-matching-parent-"));
  try {
    const fixture = await completedLaunchFixture(root, inventory(2), "matching");
    assert.equal(fixture.sourceManifest.execution.analysisMode, "matching_only");
    assert.equal(fixture.sourceManifest.execution.withApplicationRoundtrip, false);
    assert.equal(fixture.receipt.targets[1]?.applicationRoundtripStatus, null);
    const result = await prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      selectedOriginalSequences: [1],
      analysisMode: "application_only",
      concurrency: 1,
    }, {
      repositoryRoot: root,
      now: () => new Date("2026-09-17T01:00:00.000Z"),
      readProvenance: async () => ({
        gitSha: "2".repeat(40),
        packageRuntimeSha256: "f".repeat(64),
        validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
      }),
      verifyTarget: async () => {},
      prepareTarget: async (grantId) => ({
        grantId,
        inputSha256: fixture.value.targets[1]!.inputSha256,
        attachmentManifestSha256: fixture.value.targets[1]!.attachmentManifestSha256,
      }),
    });
    assert.equal(result.manifest.execution.analysisMode, "application_only");
    assert.equal(result.manifest.execution.withApplicationRoundtrip, true);
    assert.equal(result.manifest.source.completedLaunch?.schema, "analysis-launch-completed-current-inventory-v2");
    assert.equal(result.manifest.targets[0]?.primaryReuse?.sourceLabRunId,
      "run-2026-09-09T200201.000Z-a1b2c3");
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, result.manifest), fixture.value);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("부분 재봉인은 범위 밖·중복 sequence를 쓰기 전에 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-subset-invalid-"));
  try {
    const fixture = await completedLaunchFixture(root, inventory(2), "v19");
    const provenance = { gitSha: "2".repeat(40), packageRuntimeSha256: "f".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION };
    let writes = 0;
    const overrides = {
      repositoryRoot: root,
      readProvenance: async () => provenance,
      verifyTarget: async () => {},
      prepareTarget: async () => { throw new Error("prepare must not run"); },
      writeManifest: async () => { writes += 1; throw new Error("write must not run"); },
    };
    const base = {
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      concurrency: 1,
    };
    await assert.rejects(() => prepareCompletedCurrentInventoryLaunchManifest({
      ...base, selectedOriginalSequences: [2],
    }, overrides), /원 completed manifest와 terminal receipt에서 exact 실행/);
    await assert.rejects(() => prepareCompletedCurrentInventoryLaunchManifest({
      ...base, selectedOriginalSequences: [1, 1],
    }, overrides), /중복 없는/);
    assert.equal(writes, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("v2 source가 이미 줄인 범위 밖의 원 inventory target을 후속 재봉인으로 확대하지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-no-expansion-"));
  try {
    const fixture = await completedLaunchFixture(root, inventory(3), "v19");
    const provenance = { gitSha: "2".repeat(40), packageRuntimeSha256: "f".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION };
    const first = await prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      selectedOriginalSequences: [0],
      concurrency: 1,
    }, {
      repositoryRoot: root,
      readProvenance: async () => provenance,
      verifyTarget: async () => {},
      prepareTarget: async (grantId) => ({ grantId, inputSha256: "b".repeat(64),
        attachmentManifestSha256: "c".repeat(64) }),
    });
    const firstGrant = await writeAnalysisLaunchArtifact("grants", createAnalysisLaunchGrant({
      manifestSha256: first.manifestSha256,
      targetCount: 1,
      approvedBy: "test-reviewer",
      now: new Date("2026-09-16T12:01:00.000Z"),
    }), root);
    const firstReceipt: AnalysisLaunchReceipt = {
      schema: "analysis-launch-receipt-v1",
      grantSha256: firstGrant.sha256,
      manifestSha256: first.manifestSha256,
      startedAt: "2026-09-16T12:02:00.000Z",
      finishedAt: "2026-09-16T12:03:00.000Z",
      lifecycle: "finished",
      stopReason: "completed",
      systemicFailure: null,
      summary: { publishable: 1, held: 0, failed: 0, skipped: 0 },
      targets: [{
        sequence: 0,
        grantId: id(0),
        status: "publishable",
        runArtifactPath: "spike-out/runs/subset-0.json",
        runArtifactSha256: digest({ subset: 0 }),
        applicationRoundtripStatus: "complete",
        applicationDocumentCount: 1,
        fieldReadyDocumentCount: 1,
        recognizedFieldCount: 1,
        error: null,
      }],
    };
    const firstReceiptStored = await writeAnalysisLaunchArtifact("receipts", firstReceipt, root);
    const successorBinding: AnalysisLaunchCompletedCurrentInventoryBinding = {
      schema: "analysis-launch-completed-current-inventory-v2",
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: first.manifestSha256,
      sourceGrantSha256: firstGrant.sha256,
      terminalReceiptSha256: firstReceiptStored.sha256,
      selectedOriginalSequences: [1],
    };
    await assert.rejects(
      () => readAndVerifyCompletedCurrentInventoryLaunch(root, successorBinding),
      /원 completed manifest와 terminal receipt에서 exact 실행/,
    );
    const skippedReceiptStored = await writeAnalysisLaunchArtifact("receipts", {
      ...firstReceipt,
      summary: { publishable: 0, held: 0, failed: 0, skipped: 1 },
      targets: [{
        ...firstReceipt.targets[0]!,
        status: "skipped",
        runArtifactPath: null,
        runArtifactSha256: null,
        applicationRoundtripStatus: null,
        applicationDocumentCount: null,
        fieldReadyDocumentCount: null,
        recognizedFieldCount: null,
      }],
    }, root);
    await assert.rejects(
      () => readAndVerifyCompletedCurrentInventoryLaunch(root, {
        ...successorBinding,
        terminalReceiptSha256: skippedReceiptStored.sha256,
        selectedOriginalSequences: [0],
      }),
      /원 completed manifest와 terminal receipt에서 exact 실행/,
    );
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("부분 재봉인의 현재조건 확인은 과거 missing-fields 0개 gate를 승계하지 않는다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-field-policy-"));
  try {
    const value: CurrentLaunchInventory = {
      ...inventory(2),
      seriesId: "current-field-repair-20260916",
      policy: MISSING_WORKSPACE_FIELDS_POLICY,
    };
    const fixture = await completedLaunchFixture(root, value, "v19");
    const provenance = { gitSha: "2".repeat(40), packageRuntimeSha256: "f".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION };
    const seenPolicies: string[] = [];
    await prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: fixture.binding.inventorySha256,
      sourceManifestSha256: fixture.binding.sourceManifestSha256,
      sourceGrantSha256: fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: fixture.binding.terminalReceiptSha256,
      selectedOriginalSequences: [1],
      concurrency: 1,
    }, {
      repositoryRoot: root,
      readProvenance: async () => provenance,
      verifyTarget: async (current) => { seenPolicies.push(current.policy); },
      prepareTarget: async (grantId) => {
        const target = value.targets[1]!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
    });
    assert.deepEqual(seenPolicies, Array(3).fill("open-visible-current-period-unseen-v1"));

    const v1Fixture = await completedLaunchFixture(root, value, "v14");
    const v1Policies: string[] = [];
    await prepareCompletedCurrentInventoryLaunchManifest({
      inventorySha256: v1Fixture.binding.inventorySha256,
      sourceManifestSha256: v1Fixture.binding.sourceManifestSha256,
      sourceGrantSha256: v1Fixture.binding.sourceGrantSha256,
      terminalReceiptSha256: v1Fixture.binding.terminalReceiptSha256,
      concurrency: 1,
    }, {
      repositoryRoot: root,
      readProvenance: async () => provenance,
      verifyTarget: async (current) => { v1Policies.push(current.policy); },
      prepareTarget: async (grantId) => {
        const target = value.targets.find((item) => item.grantId === grantId)!;
        return { grantId, inputSha256: target.inputSha256,
          attachmentManifestSha256: target.attachmentManifestSha256 };
      },
    });
    assert.deepEqual(v1Policies, Array(6).fill(MISSING_WORKSPACE_FIELDS_POLICY));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("terminal-repair completed source는 v2에서만 전체 ancestry와 선택 subset을 함께 결속한다", () => {
  const value: CurrentLaunchInventory = {
    ...inventory(3),
    seriesId: "current-terminal-repair-20260916",
    policy: TERMINAL_REPAIR_POLICY,
  };
  const terminalRepair = {
    schema: "analysis-launch-terminal-repair-v1" as const,
    sourceManifestSha256: "1".repeat(64),
    sourceGrantSha256: "2".repeat(64),
    receiptSha256s: ["3".repeat(64)],
    originalSequences: [4, 6, 9],
  };
  const completedV2: AnalysisLaunchCompletedCurrentInventoryBinding = {
    schema: "analysis-launch-completed-current-inventory-v2",
    inventorySha256: digest(value),
    sourceManifestSha256: "4".repeat(64),
    sourceGrantSha256: "5".repeat(64),
    terminalReceiptSha256: "6".repeat(64),
    selectedOriginalSequences: [1],
  };
  const args = {
    inventory: value,
    inventorySha256: digest(value),
    completedLaunch: completedV2,
    terminalRepair,
    preparedTargets: [{ grantId: id(1), inputSha256: "b".repeat(64),
      attachmentManifestSha256: "c".repeat(64) }],
    concurrency: 1,
    now: new Date(),
    provenance: { gitSha: "2".repeat(40), packageRuntimeSha256: "e".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION },
  };
  const result = buildCurrentInventoryLaunchManifest(args);
  assert.equal(result.targets.length, 1);
  assert.deepEqual(result.source.terminalRepair, terminalRepair);
  const primaryReuse = {
    schema: "analysis-launch-primary-reuse-v1" as const,
    sourceSequence: 1,
    sourceLabRunId: "run-2026-09-16T120000.000Z-a1b2c3",
    sourceLabRunArtifactPath: "spike-out/runs/1.json",
    sourceLabRunArtifactSha256: "7".repeat(64),
    sourceLaunchReceiptSha256: completedV2.terminalReceiptSha256,
  };
  const applicationOnly = buildCurrentInventoryLaunchManifest({
    ...args,
    analysisMode: "application_only",
    primaryReuse: [primaryReuse],
  });
  assert.equal(applicationOnly.execution.analysisMode, "application_only");
  assert.deepEqual(applicationOnly.source.terminalRepair, terminalRepair);
  assert.deepEqual(applicationOnly.targets[0]?.primaryReuse, primaryReuse);
  const missingCompletedLaunch = structuredClone(applicationOnly) as any;
  delete missingCompletedLaunch.source.completedLaunch;
  assert.throws(
    () => normalizeAnalysisLaunchManifest(missingCompletedLaunch),
    /terminal repair source 범위/,
  );
  assert.throws(() => buildCurrentInventoryLaunchManifest({
    ...args,
    completedLaunch: {
      schema: "analysis-launch-completed-current-inventory-v1",
      inventorySha256: completedV2.inventorySha256,
      sourceManifestSha256: completedV2.sourceManifestSha256,
      sourceGrantSha256: completedV2.sourceGrantSha256,
      terminalReceiptSha256: completedV2.terminalReceiptSha256,
    },
    preparedTargets: value.targets,
  }), /terminal repair source 범위/);
});

test("재봉인 target의 input/attachment drift와 수동 rerun policy 삽입을 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-reseal-input-drift-"));
  try {
    const fixture = await completedLaunchFixture(root, inventory(1));
    assert.throws(() => buildCurrentInventoryLaunchManifest({
      inventory: fixture.value,
      inventorySha256: fixture.binding.inventorySha256,
      completedLaunch: fixture.binding,
      preparedTargets: [{ grantId: id(0), inputSha256: "f".repeat(64),
        attachmentManifestSha256: fixture.value.targets[0]!.attachmentManifestSha256 }],
      concurrency: 1,
      now: new Date(),
      provenance: { gitSha: "2".repeat(40), packageRuntimeSha256: "e".repeat(64),
        validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION },
    }), /현재 입력\/첨부/);
    const ordinary = manifest(fixture.value);
    assert.throws(() => normalizeAnalysisLaunchManifest({
      ...ordinary,
      execution: { ...ordinary.execution, existingRunPolicy: "rerun_exact_targets" },
    }), /source\/existing run 정책/);
    assert.throws(() => normalizeAnalysisLaunchManifest({
      ...ordinary,
      source: { ...ordinary.source, completedLaunch: {
        ...fixture.binding, inventorySha256: "e".repeat(64),
      } },
      execution: { ...ordinary.execution, existingRunPolicy: "rerun_exact_targets" },
    }), /source\/existing run 정책/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("현재 재고 47건은 독립 source로 봉인하며 deep-v35 100건 계약을 보존한다", () => {
  const result = manifest();
  assert.equal(result.source.kind, "current_inventory");
  assert.equal(result.targets.length, 47);
  assert.equal(result.execution.withApplicationRoundtrip, true);
  assert.equal(result.execution.roundtripModel, "claude-opus-5");
  assert.equal(result.execution.transport, "claude-cli");
  assert.equal(result.execution.concurrency, 2);
  assert.equal(result.execution.existingRunPolicy, "skip_existing");
  assert.deepEqual(normalizeAnalysisLaunchManifest(JSON.parse(encodeCanonical(result).toString())), result);
  assert.equal(deepRepairTargetCountForSeries("deep-v35"), 100);
  assert.equal(deepRepairTargetCountForSeries("deep-v31"), 50);
  assert.equal(manifest(inventory(1)).targets.length, 1);
  assert.equal(manifest(inventory(100)).targets.length, 100);
});

test("matching-only current inventory는 신청서 버전 없이 봉인하고 모드 모순을 거부한다", () => {
  const value = inventory(1);
  const matching = buildCurrentInventoryLaunchManifest({
    inventory: value,
    inventorySha256: digest(value),
    analysisMode: "matching_only",
    concurrency: 1,
    now: new Date("2026-09-17T00:00:00.000Z"),
    provenance: {
      gitSha: "1".repeat(40),
      packageRuntimeSha256: "e".repeat(64),
      validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
    },
  });
  assert.equal(matching.execution.analysisMode, "matching_only");
  assert.equal(matching.execution.withApplicationRoundtrip, false);
  assert.equal(matching.execution.roundtripModel, null);
  assert.equal(matching.execution.applicationFieldAnalysisVersion, null);
  assert.deepEqual(normalizeAnalysisLaunchManifest(matching), matching);
  assert.throws(() => normalizeAnalysisLaunchManifest({
    ...matching,
    execution: {
      ...matching.execution,
      applicationFieldAnalysisVersion: APPLICATION_ROUNDTRIP_VERSION,
    },
  }), /필드 분석 버전/);
});

test("빈 재고·상한 초과·중복·잘못된 sequence·결속 SHA를 거부한다", () => {
  for (const count of [0, 101]) assert.throws(() => validateCurrentLaunchInventory(inventory(count)));
  const value = inventory(2);
  for (const changed of [
    { ...value, targets: [value.targets[0], value.targets[0]] },
    { ...value, targets: [{ ...value.targets[0], sequence: 1 }] },
    { ...value, targets: [{ ...value.targets[0], sourceRevisionSha256: "bad" }] },
    { ...value, targets: [{ ...value.targets[0], stratum: "unknown/thin" }] },
    { ...value, policy: "include_history" }, { ...value, seriesId: "deep-v35" },
    { ...value, observedAt: "invalid" },
  ]) assert.throws(() => validateCurrentLaunchInventory(changed));
  assert.throws(() => buildCurrentInventoryLaunchManifest({ inventory: value, inventorySha256: "f".repeat(64),
    concurrency: 2, now: new Date(), provenance: { gitSha: "1".repeat(40), packageRuntimeSha256: "e".repeat(64), validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION } }));
});

test("필드 분석 생략·API 전환·강제 재분석·repair 지시 삽입을 거부한다", () => {
  const value = manifest(inventory(1));
  for (const execution of [
    { ...value.execution, withApplicationRoundtrip: false, roundtripModel: null },
    { ...value.execution, transport: "api" },
    { ...value.execution, existingRunPolicy: "force_reanalysis" },
    { ...value.execution, roundtripModel: "other" },
  ]) assert.throws(() => normalizeAnalysisLaunchManifest({ ...value, execution }));
  assert.throws(() => normalizeAnalysisLaunchManifest({ ...value,
    targets: [{ ...value.targets[0], reviewRepair: { sourceRunId: "run-a", reviewModel: "model-a", blockingCount: 1, taskInstruction: "injected" } }] }));
  assert.throws(() => normalizeAnalysisLaunchManifest({ ...value,
    source: { ...value.source, planSha256: "f".repeat(64) } }));
});

test("봉인된 전체 대상만 허용하며 subset·대체·drift를 grant 전에 거부한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-inventory-"));
  try {
    const source = inventory(2); await storeCurrentLaunchInventory(root, source);
    const value = manifest(source); await verifyCurrentInventoryLaunchBinding(root, value);
    for (const changed of [
      { ...value, targets: value.targets.slice(0, 1) },
      { ...value, targets: [{ ...value.targets[0]!, grantId: id(10) }, value.targets[1]!] },
      { ...value, targets: [{ ...value.targets[0]!, inputSha256: "f".repeat(64) }, value.targets[1]!] },
      { ...value, targets: [{ ...value.targets[0]!, changedSinceInventory: true }, value.targets[1]!] },
    ]) await assert.rejects(() => verifyCurrentInventoryLaunchBinding(root, changed));
    // 재승인 없이도 grant 전체가 같은 exact inventory와 결속되도록 읽기 검증만 수행한다.
    const grant = createAnalysisLaunchGrant({ targetCount: value.targets.length, manifestSha256: digest(value), approvedBy: "test-reviewer", now: new Date() });
    assert.equal(grant.targetCount, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("미실행 inventory도 전체 과거 이력에서 제외하되 formal-baseline은 보존한다", async () => {
  const root = await mkdtemp(join(tmpdir(), "cunote-current-history-"));
  try {
    const value = inventory(2); const stored = await storeCurrentLaunchInventory(root, value);
    assert.deepEqual(await readCurrentLaunchInventory(root, stored.sha256), value);
    const rootDir = join(root, "spike-out", "analysis-lab");
    assert.deepEqual(await readDeepRepairHistoricalGrantIds({ rootDir, scope: "all" }), [id(0), id(1)]);
    assert.deepEqual(await readDeepRepairHistoricalGrantIds({ rootDir, scope: "formal-baseline" }), []);
    await writeFile(stored.path, "{}");
    await assert.rejects(() => readCurrentLaunchInventory(root, stored.sha256), /content address/);
    await assert.rejects(() => readDeepRepairHistoricalGrantIds({ rootDir, scope: "all" }), /SHA mismatch/);
    assert.throws(() => currentLaunchInventoryPath(root, "../../escape"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("명시된 exact IDs와 동시성만 CLI에서 허용한다", () => {
  assert.deepEqual(parseCurrentInventoryLaunchArgs(["--", `--grant-ids=${id(0)},${id(1)}`, "--concurrency=2"]), {
    grantIds: [id(0), id(1)], concurrency: 2, analysisMode: "primary_and_application",
  });
  assert.deepEqual(parseCurrentInventoryLaunchArgs([
    `--grant-ids=${id(0)}`,
    "--concurrency=1",
    "--analysis-mode=matching_only",
  ]), { grantIds: [id(0)], concurrency: 1, analysisMode: "matching_only" });
  for (const args of [[], [`--grant-ids=${id(0)},${id(0)}`, "--concurrency=2"],
    [`--grant-ids=${id(0)}`, "--concurrency=5"], [`--grant-ids=${id(0)}`, "--execute=true"],
    [`--grant-ids=${id(0)}`, "--grant-ids=other"], [`--grant-ids=${id(0)}`, "--concurrency=2", "--force=true"],
    [`--grant-ids=${id(0)}`, "--concurrency=2", "--analysis-mode=application_only"],
  ]) assert.throws(() => parseCurrentInventoryLaunchArgs(args));
});


test("대상 착수에서 범위 밖 ID·현재 지원 조건 실패·원천 변경을 거부한다", async () => {
  const value = inventory(1);
  let reads = 0;
  const read = async (ids: readonly string[]) => {
    reads++; assert.deepEqual(ids, [id(0)]);
    return [{ grantId: id(0), sourceRevisionSha256: "d".repeat(64) }];
  };
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(value, id(1), read));
  assert.equal(reads, 0);
  await verifyCurrentInventoryLaunchTarget(value, id(0), read);
  assert.equal(reads, 1);
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(value, id(0), async () => []));
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(value, id(0), async () => [{ grantId: id(0), sourceRevisionSha256: "e".repeat(64) }]));
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(value, id(0), async () => { throw new Error("공고 마감"); }), /공고 마감/);
});

test("과거 공고의 누락 필드 보완은 별도 정책으로 봉인하며 신규 모집단의 이력 제외를 보존한다", async () => {
  const unseen = inventory(1);
  assert.throws(() => assertCurrentInventoryHistoryEligibility([id(0)], [id(0)], unseen.policy), /과거 이력/);
  const repair: CurrentLaunchInventory = { ...unseen,
    policy: MISSING_WORKSPACE_FIELDS_POLICY, seriesId: "current-field-repair-20260910" };
  assertCurrentInventoryHistoryEligibility([id(0)], [id(0)], repair.policy);
  assert.throws(() => validateCurrentLaunchInventory({ ...repair, seriesId: unseen.seriesId }), /독립된/);
  assert.throws(() => validateCurrentLaunchInventory({ ...unseen, seriesId: repair.seriesId }), /독립된/);
  const launch = manifest(repair);
  assert.equal(launch.execution.withApplicationRoundtrip, true);
  assert.equal(launch.execution.transport, "claude-cli");
  assert.equal(launch.execution.existingRunPolicy, "skip_existing");
  assert.equal(launch.targets.length, 1);
  const historicalPrimaryWithoutRoundtrip = new Map([[
    id(0),
    {
      okCurrent: true,
      okOutdated: false,
      heldCurrent: false,
      errorCurrent: false,
      applicationFieldAnalysisReadyCurrent: false,
    },
  ]]);
  const scheduled = partitionCohortEntries(
    [{ grantId: id(0) }],
    historicalPrimaryWithoutRoundtrip,
    {
      retryErrors: false,
      reanalyzeOutdated: false,
      exactManifestReanalysis: shouldForceExactManifestReanalysis({
        existingRunPolicy: launch.execution.existingRunPolicy,
        retryErrors: false,
      }),
      requireApplicationFieldAnalysis: launch.execution.withApplicationRoundtrip,
    },
  );
  assert.deepEqual(scheduled.pending, [{ grantId: id(0) }]);
  assert.deepEqual(scheduled.skippedOk, []);
  const root = await mkdtemp(join(tmpdir(), "cunote-field-repair-"));
  try {
    await storeCurrentLaunchInventory(root, repair);
    assert.deepEqual(await verifyCurrentInventoryLaunchBinding(root, launch), repair);
    await assert.rejects(() => verifyCurrentInventoryLaunchBinding(root,
      { ...launch, source: { ...launch.source, seriesId: unseen.seriesId } }), /범위/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("누락 필드 보완은 필드 0개와 보관된 편집 양식이 필요하며 모델 착수 전 다시 확인한다", async () => {
  assertMissingWorkspaceFieldsState({ fieldCount: 0, editableSurfaceCount: 2 });
  for (const state of [
    { fieldCount: 1, editableSurfaceCount: 2 },
    { fieldCount: 0, editableSurfaceCount: 0 },
    { fieldCount: -1, editableSurfaceCount: 1 },
  ]) assert.throws(() => assertMissingWorkspaceFieldsState(state), /필드 0개/);
  const repair: CurrentLaunchInventory = { ...inventory(1),
    policy: MISSING_WORKSPACE_FIELDS_POLICY, seriesId: "current-field-repair-20260910" };
  let currentFieldCount = 0;
  const read = async (ids: readonly string[], policy: CurrentLaunchInventory["policy"]) => {
    assert.deepEqual(ids, [id(0)]);
    assert.equal(policy, MISSING_WORKSPACE_FIELDS_POLICY);
    assertMissingWorkspaceFieldsState({ fieldCount: currentFieldCount, editableSurfaceCount: 2 });
    return [{ grantId: id(0), sourceRevisionSha256: "d".repeat(64) }];
  };
  await verifyCurrentInventoryLaunchTarget(repair, id(0), read);
  currentFieldCount = 1;
  await assert.rejects(() => verifyCurrentInventoryLaunchTarget(repair, id(0), read), /필드 0개/);
});
