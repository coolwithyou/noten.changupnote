import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
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
const proposalRoot = join(analysisLabDir(), "application-roundtrip", "proposals");
const receiptRoot = join(analysisLabDir(), "application-roundtrip", "canary-receipts");
const deepReceiptSha256 = "d".repeat(64);
let proposalFixturePath = join(proposalRoot, "missing.json");
let receiptFixturePath = join(receiptRoot, "missing.json");

await Promise.all([
  rm(roundtripDir, { recursive: true, force: true }),
  rm(releaseDir, { recursive: true, force: true }),
]);

try {
  const run = roundtripRun();
  const analysisBody = Buffer.from(`${JSON.stringify(run, null, 2)}\n`);
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
  const proposalBody = {
    schema: "application-roundtrip-candidate-proposal-v1" as const,
    preparedAt: "2026-08-09T00:00:00.000Z",
    provenance: {
      gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      packageRuntimeSha256: "b".repeat(64),
      validatorVersion: "analysis-lab-validator-v1",
    },
    deepExperiment: {
      planSha256: "c".repeat(64),
      terminalReceiptSha256: deepReceiptSha256,
      observationsSha256: "e".repeat(64),
      observedCount: 1,
    },
    policy: {
      transport: "claude-cli" as const,
      model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
      candidateSelection: "publishable-ready-or-conditional-v1" as const,
      fieldTriage: "ambiguous-only-v1" as const,
      maxCandidates: 10 as const,
    },
    candidates: [],
    executionTargets: [{
      sequence: 0,
      grantId,
      deepReceiptSha256,
      sourceSha256s: ["a".repeat(64)],
      fieldCandidateCount: 1,
      llmCandidateCount: 1,
      deterministicDecisionCount: 0,
    }],
    liveExecutionAuthorized: false as const,
  };
  const proposal = { ...proposalBody, proposalSha256: canonicalSha256(proposalBody) };
  const receiptBody = {
    schema: "application-roundtrip-canary-receipt-v3" as const,
    proposalSha256: proposal.proposalSha256,
    sequence: 0,
    grantId,
    sourceSha256s: ["a".repeat(64)],
    model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    transport: "claude-cli" as const,
    status: "complete" as const,
    targetDisposition: "ready" as const,
    cohortVerdict: "CONTINUE" as const,
    reasonCodes: ["ready"] as const,
    failureCode: null,
    runId: roundtripRunId,
    runArtifactPath: `spike-out/analysis-lab/application-roundtrip/${sourceGroup}/${roundtripRunId}/analysis.json`,
    runArtifactSha256: createHash("sha256").update(analysisBody).digest("hex"),
    completedAt: "2026-08-09T00:00:02.000Z",
  };
  const canaryReceipt = { ...receiptBody, receiptSha256: canonicalSha256(receiptBody) };
  proposalFixturePath = join(proposalRoot, `${proposal.proposalSha256}.json`);
  receiptFixturePath = join(receiptRoot, `${canaryReceipt.receiptSha256}.json`);
  await Promise.all([mkdir(proposalRoot, { recursive: true }), mkdir(receiptRoot, { recursive: true })]);
  await Promise.all([
    writeFile(join(roundtripDir, "analysis.json"), analysisBody),
    writeFile(join(roundtripDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`),
    writeFile(proposalFixturePath, `${JSON.stringify(proposal, null, 2)}\n`, { flag: "wx" }),
    writeFile(receiptFixturePath, `${JSON.stringify(canaryReceipt, null, 2)}\n`, { flag: "wx" }),
  ]);

  await assert.rejects(
    () => bundlePromotionApplicationPrecompute({
      releaseId,
      labRun: { ...labRun(), primaryValidationOutcome: "held", error: null },
      deepReceiptSha256,
    }),
    /publishable이 아닌 LabRun/,
    "held 런의 Kordoc 결과는 별도로 완료됐어도 release 번들로 승격할 수 없다",
  );

  const evidence = await bundlePromotionApplicationPrecompute({
    releaseId,
    labRun: labRun(),
    deepReceiptSha256,
  });
  assert.ok(evidence);
  assert.equal(evidence.status, "ready");
  assert.equal(evidence.materializableDocumentCount, 1);
  assert.equal(evidence.transport, "claude-cli");
  assert.equal(evidence.model, APPLICATION_ROUNDTRIP_ADOPTED_MODEL);
  assert.equal(evidence.schema, "promotion-application-precompute-v2");
  assert.equal(evidence.canaryAdmission?.admissionReceiptSha256, canaryReceipt.receiptSha256);
  assert.equal(evidence.canaryAdmission?.deepReceiptSha256, deepReceiptSha256);

  const bundled = await readBundledPromotionApplicationPrecompute(evidence);
  assert.equal(bundled.run.runId, roundtripRunId);
  assert.equal(bundled.manifest.attachments[0]?.sourceSha256, "a".repeat(64));

  const precomputeReceipt = buildPromotionApplicationPrecomputeReceipt({
    evidence,
    applied: { materialized: 1, reused: 0, protected: 0, terminalOnly: 0, fields: 1 },
    completedAt: new Date("2026-08-09T00:00:02.000Z"),
  });
  assert.deepEqual(verifyPromotionApplicationPrecomputeReceipt({
    receipt: precomputeReceipt,
    evidence,
    observedFieldCount: 1,
    observedFieldsReadySurfaceCount: 1,
    observedArtifactCount: 1,
  }), []);
  assert.deepEqual(verifyPromotionApplicationPrecomputeReceipt({
    receipt: precomputeReceipt,
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
    rm(proposalFixturePath, { force: true }),
    rm(receiptFixturePath, { force: true }),
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
    parentLabRunId: null,
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

function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}
