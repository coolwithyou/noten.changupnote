import assert from "node:assert/strict";
import {
  applyApplicationRepairAuthoringOverlays,
  resolveApplicationRepairAuthoringOverlays,
  type PromotionServingItemWithIdentity,
  type VerifiedApplicationRepairAuthoringOverlay,
} from "./applicationRepairReadinessOverlay";
import type { PromotionServingRequestSnapshot } from "./promotionServing";
import {
  createApplicationFieldRepairReleaseManifest,
  type ApplicationFieldRepairServingRow,
} from "./applicationFieldRepairContract";
import {
  applicationFieldRepairServingStateSha256,
  applicationFieldRepairSnapshotSha256,
  type ApplicationFieldRepairSnapshot,
} from "./applicationFieldRepairSnapshot";

function snapshot(
  promotionItemId = "item-1",
): PromotionServingRequestSnapshot<PromotionServingItemWithIdentity> {
  return {
    items: [{
      item: {
        promotionItemId,
        releaseDbId: "release-1",
        grantId: "grant-1",
        runId: "run-1",
        planSha256: "a".repeat(64),
        deepAnalysisRunId: "deep-run-1",
        releaseManifestSha256: "b".repeat(64),
      },
      evidence: {
        kind: "production_deep_run",
        deepAnalysisRunId: "deep-run-1",
        authoringReadiness: { status: "held", sourceDisposition: "held" },
      },
    }],
    metrics: {
      itemBindingRows: 1,
      releaseDocumentRows: 0,
      releaseManifestBytes: 0,
      releaseManifestValidations: 0,
    },
  };
}

{
  const invalid = {
    repairId: "repair-1",
    releaseDbId: "release-db-1",
    releaseId: "release-1",
    releaseStatus: "active",
    releaseManifestSha256: "a".repeat(64),
    releaseManifest: {},
    grantId: "grant-1",
    parentPromotionItemId: "item-1",
    roundtripRunId: "roundtrip-1",
    applicationFieldAnalysisVersion: "v11",
    planSha256: "b".repeat(64),
    status: "applied",
    applicationPrecomputeReceipt: {},
    servingStateSha256: "c".repeat(64),
    currentServingStateSha256: "c".repeat(64),
    appliedAt: new Date(),
  };
  assert.deepEqual(
    resolveApplicationRepairAuthoringOverlays([invalid]),
    [],
    "exact manifest/receipt를 검증하지 못한 applied row는 overlay가 아니다",
  );
  assert.deepEqual(
    resolveApplicationRepairAuthoringOverlays([invalid, { ...invalid, repairId: "repair-2" }]),
    [],
    "같은 parent의 raw row가 중복되면 validation 결과와 무관하게 닫는다",
  );
}

function overlay(parentPromotionItemId = "item-1"): VerifiedApplicationRepairAuthoringOverlay {
  return {
    parentPromotionItemId,
    authoringReadiness: { status: "ready", sourceDisposition: "ready" },
  };
}

function validRepairRow(): ApplicationFieldRepairServingRow {
  const grantId = "00000000-0000-4000-8000-000000000001";
  const parentPromotionItemId = "00000000-0000-4000-8000-000000000002";
  const parentReleaseDbId = "00000000-0000-4000-8000-000000000003";
  const repairReleaseDbId = "00000000-0000-4000-8000-000000000004";
  const roundtripRunId = "roundtrip-v11-test";
  const runId = "run-v11-test";
  const sourceRevisionSha256 = "1".repeat(64);
  const inputSha256 = "2".repeat(64);
  const attachmentManifestSha256 = "3".repeat(64);
  const launchReceiptSha256 = "4".repeat(64);
  const launchManifestSha256 = "5".repeat(64);
  const launchGrantSha256 = "6".repeat(64);
  const independentReviewManifestSha256 = "7".repeat(64);
  const independentReviewAggregateSha256 = "8".repeat(64);
  const runSha256 = "9".repeat(64);
  const analysisSha256 = "a".repeat(64);
  const applicationManifestSha256 = "b".repeat(64);
  const applicationFieldAnalysisVersion = "kordoc-application-roundtrip-v11";
  const readiness = {
    schema: "analysis-launch-promotion-readiness-v1" as const,
    disposition: "conditional" as const,
    reasons: [],
    unresolvedAxes: [],
    sourceRevisionSha256,
    inputSha256,
    attachmentManifestSha256,
    launchReceiptSha256,
    independentReviewAggregateSha256,
    applicationRoundtripStatus: "partial" as const,
    applicationRoundtripRunId: roundtripRunId,
    applicationDocumentCount: 1,
    fieldReadyDocumentCount: 1,
    recognizedFieldCount: 16,
    runFeatureReadiness: {
      schema: "analysis-feature-readiness-v1" as const,
      matching: { status: "ready" as const, sourceDisposition: "conditional" as const, reasons: [] },
      authoring: { status: "ready" as const, sourceDisposition: "ready" as const, reasons: [] },
    },
    runFeatureReadinessVerification: "verified" as const,
    authoringEvidenceStatus: "verified" as const,
    authoringEvidenceReasons: [],
  };
  const applicationPrecompute = {
    schema: "promotion-application-precompute-v3" as const,
    releaseId: "repair-release-test",
    grantId,
    parentLabRunId: runId,
    roundtripRunId,
    status: "conditional" as const,
    transport: "claude-cli" as const,
    model: "claude-opus-5" as const,
    analysisSha256,
    manifestSha256: applicationManifestSha256,
    sourceCount: 1,
    documentCount: 1,
    materializableDocumentCount: 1,
    reviewRequiredDocumentCount: 0,
    launchAdmission: {
      launchReceiptSha256,
      launchManifestSha256,
      launchGrantSha256,
      launchSequence: 0,
      independentReviewManifestSha256,
      independentReviewAggregateSha256,
      runArtifactSha256: runSha256,
      applicationFieldAnalysisVersion,
    },
  };
  const manifest = createApplicationFieldRepairReleaseManifest({
    releaseId: "repair-release-test",
    revision: 1,
    createdAt: "2026-09-11T00:00:00.000Z",
    gitCommit: "c".repeat(40),
    buildDigest: "d".repeat(64),
    cohortLabel: "test-repair",
    repair: {
      grantId,
      parent: {
        releaseDbId: parentReleaseDbId,
        releaseId: "parent-release-test",
        releaseManifestSha256: "e".repeat(64),
        releasePlanSha256: "f".repeat(64),
        promotionItemId: parentPromotionItemId,
        runId,
        planSha256: "0".repeat(64),
        afterSha256: "1".repeat(64),
        appliedAt: "2026-09-11T00:00:00.000Z",
      },
      inventory: {
        policy: "open-visible-current-period-missing-fields-v1",
        seriesId: "current-field-repair-test",
        inventorySha256: "2".repeat(64),
        launchManifestSha256,
        launchReceiptSha256,
      },
      sourceArtifact: {
        grantId,
        runId,
        runSha256,
        aiReviewSha256: "3".repeat(64),
        auditSha256: "4".repeat(64),
        overlaySha256: null,
        confirmationsSha256: null,
        sourceRevisionSha256,
        localLabEvidence: {
          schema: "verified-local-lab-source-v1",
          transport: "claude-cli",
          model: "claude-opus-5",
          promptVersion: "launch-v1",
          inputSha256,
          reviewMethod: "analysis_launch_independent_review",
          analysisLaunch: {
            schema: "verified-analysis-launch-source-v1",
            launchReceiptSha256,
            launchManifestSha256,
            launchGrantSha256,
            launchSequence: 0,
            independentReviewManifestSha256,
            independentReviewAggregateSha256,
            attachmentManifestSha256,
            sourceRevisionSha256,
            executionGitSha: "5".repeat(40),
            packageRuntimeSha256: "6".repeat(64),
            validatorVersion: "validator-v1",
            applicationFieldAnalysisVersion,
          },
        },
        applicationPrecompute,
      },
      readiness,
      beforeApplicationSnapshotSha256: "7".repeat(64),
      fieldCountBefore: 0,
      expectedFieldCount: 16,
      expectedMaterializableSurfaceCount: 1,
      materializationPlanSha256: "8".repeat(64),
    },
  });
  const currentServingStateSha256 = "9".repeat(64);
  return {
    repairId: "00000000-0000-4000-8000-000000000005",
    releaseDbId: repairReleaseDbId,
    releaseId: manifest.releaseId,
    releaseStatus: "active",
    releaseManifestSha256: manifest.manifestSha256,
    releaseManifest: manifest,
    grantId,
    parentPromotionItemId,
    roundtripRunId,
    applicationFieldAnalysisVersion,
    planSha256: manifest.repair.planSha256,
    status: "applied",
    applicationPrecomputeReceipt: {
      schema: "analysis-lab-application-precompute-receipt-v1",
      status: applicationPrecompute.status,
      roundtripRunId,
      transport: applicationPrecompute.transport,
      model: applicationPrecompute.model,
      analysisSha256,
      manifestSha256: applicationManifestSha256,
      materialized: 1,
      reused: 0,
      protected: 0,
      terminalOnly: 0,
      fields: 16,
      completedAt: "2026-09-11T00:01:00.000Z",
    },
    servingStateSha256: currentServingStateSha256,
    currentServingStateSha256,
    appliedAt: new Date("2026-09-11T00:01:00.000Z"),
  };
}

{
  const row = validRepairRow();
  assert.deepEqual(resolveApplicationRepairAuthoringOverlays([row]), [{
    parentPromotionItemId: row.parentPromotionItemId,
    authoringReadiness: { status: "ready", sourceDisposition: "ready" },
  }]);
  assert.deepEqual(
    resolveApplicationRepairAuthoringOverlays([{ ...row, currentServingStateSha256: "0".repeat(64) }]),
    [],
    "current surface/source/canonical field snapshot drift는 기존 readiness로 닫는다",
  );
  assert.deepEqual(
    resolveApplicationRepairAuthoringOverlays([{ ...row, releaseStatus: "canary_passed" }]),
    [],
    "canary 검증만 끝난 repair는 active 전까지 기존 readiness를 유지한다",
  );
  for (const status of ["prepared", "failed", "rolled_back"]) {
    assert.deepEqual(
      resolveApplicationRepairAuthoringOverlays([{ ...row, status }]),
      [],
      `${status} repair는 작성 ready를 열지 않는다`,
    );
  }
  assert.deepEqual(
    resolveApplicationRepairAuthoringOverlays([row, { ...row, repairId: crypto.randomUUID() }]),
    [],
    "같은 parent의 복수 returned row는 valid여도 fail-closed한다",
  );
}

function applicationSnapshot(): ApplicationFieldRepairSnapshot {
  return {
    schema: "analysis-lab-application-field-repair-snapshot-v1",
    grantId: "00000000-0000-4000-8000-000000000001",
    surfaces: [{
      id: "surface-1",
      grantId: "00000000-0000-4000-8000-000000000001",
      templateId: null,
      source: "bizinfo",
      sourceId: "source-1",
      type: "file_template",
      title: "application.hwp",
      format: "hwp",
      sourceUrl: null,
      sourceAttachment: "application.hwp",
      archiveSha256: "1".repeat(64),
      extractionStatus: "complete",
      extractionVersion: "kordoc-application-roundtrip-v11",
      confidence: 0.99,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    }],
    fields: [{
      id: "field-1",
      grantId: "00000000-0000-4000-8000-000000000001",
      source: "bizinfo",
      sourceId: "source-1",
      documentCategory: "application",
      documentName: "application.hwp",
      sourceAttachment: "application.hwp",
      fieldKey: "company_name",
      label: "기업명",
      section: "기본정보",
      fieldType: "text",
      required: true,
      sourceSpan: null,
      mappedCompanyField: "companyName",
      fillStrategy: "profile",
      confidence: 0.99,
      parserVersion: "kordoc-application-roundtrip-v11",
      surfaceId: "surface-1",
      position: { targetKind: "table_cell_text", row: 1, col: 1 },
      visualEvidence: null,
      textEvidence: null,
      reviewRequired: false,
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:00:00.000Z",
    }],
    drafts: [{
      id: "draft-1",
      surfaceId: "surface-1",
      updatedAt: "2026-09-11T00:00:00.000Z",
      stateSha256: "2".repeat(64),
    }],
  };
}

{
  const base = applicationSnapshot();
  const servingSha = applicationFieldRepairServingStateSha256(base);
  const draftChanged = {
    ...base,
    drafts: [{
      ...base.drafts[0]!,
      updatedAt: "2026-09-11T01:00:00.000Z",
      stateSha256: "3".repeat(64),
    }, {
      id: "draft-2",
      surfaceId: "surface-1",
      updatedAt: "2026-09-11T01:00:00.000Z",
      stateSha256: "4".repeat(64),
    }],
  } satisfies ApplicationFieldRepairSnapshot;
  assert.equal(
    applicationFieldRepairServingStateSha256(draftChanged),
    servingSha,
    "정상 draft 변경과 새 draft는 application repair readiness를 닫지 않는다",
  );
  assert.notEqual(
    applicationFieldRepairSnapshotSha256(draftChanged),
    applicationFieldRepairSnapshotSha256(base),
    "rollback용 전체 snapshot은 draft 변경을 계속 감지한다",
  );

  const sourceDrift = {
    ...base,
    surfaces: [{ ...base.surfaces[0]!, archiveSha256: "5".repeat(64) }],
  } satisfies ApplicationFieldRepairSnapshot;
  const fieldDrift = {
    ...base,
    fields: [{ ...base.fields[0]!, label: "변경된 기업명" }],
  } satisfies ApplicationFieldRepairSnapshot;
  for (const current of [sourceDrift, fieldDrift]) {
    const row = {
      ...validRepairRow(),
      servingStateSha256: servingSha,
      currentServingStateSha256: applicationFieldRepairServingStateSha256(current),
    };
    assert.deepEqual(
      resolveApplicationRepairAuthoringOverlays([row]),
      [],
      "source archive 또는 canonical field drift는 기존 readiness로 닫는다",
    );
  }
}

{
  const original = snapshot();
  const item = original.items[0]!.item;
  const resolved = applyApplicationRepairAuthoringOverlays(original, [overlay()]);
  assert.deepEqual(resolved.items[0]!.evidence.authoringReadiness, {
    status: "ready",
    sourceDisposition: "ready",
  });
  assert.equal(resolved.items[0]!.item, item, "ordinary promotion item binding은 교체하지 않는다");
  assert.equal(resolved.items[0]!.evidence.kind, "production_deep_run");
  assert.equal(
    resolved.items[0]!.evidence.kind === "production_deep_run"
      ? resolved.items[0]!.evidence.deepAnalysisRunId
      : null,
    "deep-run-1",
    "matching provenance는 application repair로 바꾸지 않는다",
  );
  assert.equal(resolved.metrics, original.metrics, "기존 promotion snapshot 계측도 보존한다");
}

{
  const original = snapshot();
  assert.equal(
    applyApplicationRepairAuthoringOverlays(original, []),
    original,
    "repair가 없으면 기존 snapshot 객체와 readiness를 그대로 쓴다",
  );
  assert.deepEqual(
    applyApplicationRepairAuthoringOverlays(original, [overlay("other-item")]),
    original,
    "다른 promotion item repair는 현재 item에 영향을 주지 않는다",
  );
}

{
  const original = snapshot();
  assert.deepEqual(
    applyApplicationRepairAuthoringOverlays(original, [overlay(), overlay()]),
    original,
    "같은 parent의 verified repair가 중복되면 임의 선택하지 않는다",
  );
}

console.log("application repair authoring readiness overlay: ok");
