import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import type { LabRun } from "@/features/dev/analysis-lab/contract";
import {
  buildPromotionApplicationPrecomputeReceipt,
  bundlePromotionApplicationPrecompute,
  readBundledPromotionApplicationPrecompute,
  verifyPromotionApplicationPrecomputeReceipt,
} from "./application-precompute-release";
import { analysisLabDir } from "./run-store";

const grantId = "00000000-0000-4000-8000-000000000777";
const parentLabRunId = "run-2026-08-09T000000.000Z-a1b2c3";
const roundtripRunId = "roundtrip-2026-08-09T000001.000Z-d4e5f6";
const releaseId = "deep-kordoc-portable-test-r1";
const sourceGroup = "test__kordoc-portable";
const roundtripDir = join(analysisLabDir(), "application-roundtrip", sourceGroup, roundtripRunId);
const releaseDir = join(analysisLabDir(), "releases", releaseId);

await Promise.all([
  rm(roundtripDir, { recursive: true, force: true }),
  rm(releaseDir, { recursive: true, force: true }),
]);

try {
  const run = roundtripRun();
  const manifest = {
    version: 1 as const,
    runId: roundtripRunId,
    grantId,
    source: "test",
    sourceId: "kordoc-portable",
    attachments: [{
      attachmentId: "attachment-1",
      filename: "신청서.hwp",
      storageKey: "grant-archive/test/application.hwp",
      sourceSha256: "a".repeat(64),
      detectedFormat: "hwp" as const,
    }],
  };
  await mkdir(roundtripDir, { recursive: true });
  await Promise.all([
    writeFile(join(roundtripDir, "analysis.json"), `${JSON.stringify(run, null, 2)}\n`),
    writeFile(join(roundtripDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
  ]);

  await assert.rejects(
    () => bundlePromotionApplicationPrecompute({
      releaseId,
      labRun: { ...labRun(), primaryValidationOutcome: "held", error: null },
    }),
    /provenance가 release 기준을 충족하지 않습니다/,
    "held 런의 Kordoc 결과는 별도로 완료됐어도 release 번들로 승격할 수 없다",
  );

  const evidence = await bundlePromotionApplicationPrecompute({
    releaseId,
    labRun: labRun(),
  });
  assert.ok(evidence);
  assert.equal(evidence.status, "ready");
  assert.equal(evidence.materializableDocumentCount, 1);
  assert.equal(evidence.transport, "claude-cli");
  assert.equal(evidence.model, APPLICATION_ROUNDTRIP_ADOPTED_MODEL);

  const bundled = await readBundledPromotionApplicationPrecompute(evidence);
  assert.equal(bundled.run.runId, roundtripRunId);
  assert.equal(bundled.manifest.attachments[0]?.sourceSha256, "a".repeat(64));

  const receipt = buildPromotionApplicationPrecomputeReceipt({
    evidence,
    applied: { materialized: 1, reused: 0, protected: 0, terminalOnly: 0, fields: 1 },
    completedAt: new Date("2026-08-09T00:00:02.000Z"),
  });
  assert.deepEqual(verifyPromotionApplicationPrecomputeReceipt({
    receipt,
    evidence,
    observedFieldCount: 1,
    observedFieldsReadySurfaceCount: 1,
    observedArtifactCount: 1,
  }), []);
  assert.deepEqual(verifyPromotionApplicationPrecomputeReceipt({
    receipt,
    evidence,
    observedFieldCount: 0,
    observedFieldsReadySurfaceCount: 0,
    observedArtifactCount: 0,
  }), ["no_materialized_fields", "no_fields_ready_surface", "no_field_candidate_artifact"]);
  assert.throws(
    () => buildPromotionApplicationPrecomputeReceipt({
      evidence,
      applied: { materialized: 0, reused: 0, protected: 0, terminalOnly: 1, fields: 0 },
    }),
    /반영된 지원 양식이 없습니다/,
  );

  await writeFile(
    join(releaseDir, "application-precompute", grantId, "analysis.json"),
    "{}\n",
  );
  await assert.rejects(
    () => readBundledPromotionApplicationPrecompute(evidence),
    /artifact hash/,
    "release에 봉인된 Kordoc artifact가 바뀌면 승격 전에 차단해야 한다",
  );
} finally {
  await Promise.all([
    rm(roundtripDir, { recursive: true, force: true }),
    rm(releaseDir, { recursive: true, force: true }),
  ]);
}

console.log("application precompute release bundle tests: ok");

function labRun(): LabRun {
  return {
    runId: parentLabRunId,
    grantId,
    source: "test",
    sourceId: "kordoc-portable",
    title: "Kordoc release 테스트",
    model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    transport: "claude-cli",
    promptVersion: "lab-deep-test",
    startedAt: "2026-08-09T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [],
    inputTotalChars: 1,
    inputSha256: "b".repeat(64),
    usage: null,
    costUsd: null,
    analysisMarkdown: "test",
    programIntent: null,
    criteria: [],
    axisAssessments: [],
    taxonomyProposals: [],
    dimensionDiffs: [],
    applicationRoundtrip: {
      status: "complete",
      runId: roundtripRunId,
      transport: "claude-cli",
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      documentCount: 1,
      sourceCount: 1,
      errorCode: null,
      error: null,
    },
    error: null,
  };
}

function roundtripRun(): ApplicationRoundtripRun {
  return {
    version: APPLICATION_ROUNDTRIP_VERSION,
    runId: roundtripRunId,
    grantId,
    source: "test",
    sourceId: "kordoc-portable",
    title: "Kordoc release 테스트",
    engine: "kordoc",
    engineVersion: "test",
    parentLabRunId,
    transport: "claude-cli",
    requestedModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    timeoutMs: 900_000,
    candidateLimit: 180,
    candidateConcurrency: 1,
    failureCode: null,
    startedAt: "2026-08-09T00:00:01.000Z",
    durationMs: 1,
    sourceCount: 1,
    skippedDocumentCount: 0,
    documents: [{
      attachmentId: "attachment-1",
      filename: "신청서.hwp",
      declaredFormat: "hwp",
      detectedFormat: "hwp",
      sourceSha256: "a".repeat(64),
      byteLength: 100,
      parseDurationMs: 1,
      parsedChars: 10,
      blockCount: 1,
      tableCount: 1,
      formConfidence: 1,
      role: "application_form",
      roleConfidence: 1,
      roleScores: { applicationForm: 1, businessPlan: 0, announcement: 0, evidence: 0 },
      roleSignals: ["신청서"],
      fields: [{
        fieldInstanceId: "field-1",
        label: "기업명",
        displayLabel: "기업명",
        normalizedLabel: "기업명",
        originalValue: "",
        type: "text",
        required: true,
        empty: true,
        recommendedInput: true,
        inputLikelihood: 0.99,
        inputSignals: ["empty-cell"],
        sampleValue: "테스트기업",
        sampleReason: "회사 기본정보",
        source: "kordoc-form",
        inputKind: "text",
        writeOperation: "kordoc_field",
        helperText: null,
        unit: null,
        options: [],
        analysisSource: "llm",
        llmConfidence: 0.99,
        location: { blockIndex: 0, row: 0, col: 1, occurrence: 0, pageNumber: 1 },
      }],
      choiceGroups: [],
      emptyFieldCount: 1,
      recommendedInputFieldCount: 1,
      recommendedChoiceGroupCount: 0,
      fieldPlanning: {
        status: "llm",
        model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
        durationMs: 1,
        candidateCount: 1,
        acceptedCount: 1,
        rejectedCount: 0,
        warning: null,
        transport: "claude-cli",
        requestedModel: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
        timeoutMs: 900_000,
        candidateLimit: 180,
        candidateConcurrency: 1,
        parentLabRunId,
        failureCode: null,
      },
      fieldCoverage: {
        status: "complete",
        rawEmptyCandidateCount: 1,
        acceptedInputCount: 1,
        unresolvedCandidateCount: 0,
        structuralWarningCount: 0,
        unresolvedCandidates: [],
        structuralWarnings: [],
      },
      markdownPreview: "기업명",
      warnings: [],
      error: null,
    }],
    recommendedAttachmentId: "attachment-1",
    recommendationReason: "신청서",
    error: null,
  };
}
