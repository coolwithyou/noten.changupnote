import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VERSION } from "kordoc";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { buildApplicationRoundtripReference } from "../application-precompute";
import { assertReusableApplicationRoundtrip, prepareApplicationRoundtripReuse } from "./reuse";
import {
  readRoundtripRunArtifacts,
  saveRoundtripRun,
  type RoundtripRunManifest,
} from "./store";

const originalCwd = process.cwd();
// effort env는 재사용 계약 판정에 개입하므로 셸 환경과 무관하게 테스트가 결정적이도록 통제한다.
const originalEffortEnv = process.env.APPLICATION_ROUNDTRIP_EFFORT;
delete process.env.APPLICATION_ROUNDTRIP_EFFORT;
const temporaryRoot = await mkdtemp(join(tmpdir(), "cunote-roundtrip-reuse-"));
const sourceRunId = "roundtrip-2026-08-11T000000.000Z-a1b2c3";
const sourceSha256 = "a".repeat(64);
const filename = "[별첨] 신청서.hwp";
const storageKey = "archives/application.hwp";
const attachmentId = "attachment-1";

try {
  await writeFile(join(temporaryRoot, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  process.chdir(temporaryRoot);
  await saveRoundtripRun({
    run: sourceRun(),
    manifest: sourceManifest(),
    markdownByAttachmentId: new Map([[attachmentId, "# 신청서\n회사명: ____"]]),
  });

  const prepared = await prepareApplicationRoundtripReuse({
    grantId: "grant-1",
    sourceRunId,
    transport: "claude-cli",
    model: "claude-opus-5",
    currentSources: [{ filename, storageKey, sha256: sourceSha256 }],
  });
  const rebound = await prepared.materialize("run-2026-08-11T010000.000Z-c3d4e5");

  assert.notEqual(rebound.runId, sourceRunId, "기존 불변 artifact를 덮어쓰지 않고 새 링크 artifact 생성");
  assert.equal(rebound.parentLabRunId, "run-2026-08-11T010000.000Z-c3d4e5");
  assert.equal(rebound.reusedFromRunId, sourceRunId);
  assert.equal(rebound.durationMs < 1_000, true, "재결속은 모델 호출 없이 로컬 I/O만 수행");
  assert.equal(rebound.documents[0]?.fieldPlanning.parentLabRunId, rebound.parentLabRunId);

  const persisted = await readRoundtripRunArtifacts("grant-1", rebound.runId);
  assert.ok(persisted, "재결속 artifact 불변 저장");
  assert.equal(persisted.manifest.runId, rebound.runId);
  assert.equal(
    await readFile(join(persisted.dir, `${attachmentId}.parsed.md`), "utf8"),
    "# 신청서\n회사명: ____",
    "파싱 원문도 새 artifact에 복제",
  );

  const reference = buildApplicationRoundtripReference({
    result: { status: "fulfilled", value: rebound },
    transport: "claude-cli",
    model: "claude-opus-5",
  });
  assert.equal(reference.status, "complete");
  assert.equal(reference.reusedFromRunId, sourceRunId);
  assert.equal(reference.costUsd, 0, "재사용 런은 과거 명목 비용을 새 배치 비용으로 중복 계상하지 않음");

  await assert.rejects(
    prepareApplicationRoundtripReuse({
      grantId: "grant-1",
      sourceRunId,
      transport: "claude-cli",
      model: "claude-opus-5",
      currentSources: [{ filename, storageKey, sha256: "b".repeat(64) }],
    }),
    (error: unknown) => hasReuseCode(error, "source_changed"),
    "현재 원본 SHA가 달라지면 재사용하지 않음",
  );
  await assert.rejects(
    prepareApplicationRoundtripReuse({
      grantId: "grant-1",
      sourceRunId,
      transport: "claude-cli",
      model: "claude-sonnet-5",
      currentSources: [{ filename, storageKey, sha256: sourceSha256 }],
    }),
    (error: unknown) => hasReuseCode(error, "contract_mismatch"),
    "모델 계약이 달라지면 재사용하지 않음",
  );
  await assert.rejects(
    prepareApplicationRoundtripReuse({
      grantId: "other-grant",
      sourceRunId,
      transport: "claude-cli",
      model: "claude-opus-5",
      currentSources: [{ filename, storageKey, sha256: sourceSha256 }],
    }),
    (error: unknown) => hasReuseCode(error, "artifact_not_found"),
    "다른 공고 디렉터리의 산출물을 교차 재사용하지 않음",
  );
  assert.throws(
    () => assertReusableApplicationRoundtrip({
      grantId: "other-grant",
      run: sourceRun(),
      manifest: sourceManifest(),
      transport: "claude-cli",
      model: "claude-opus-5",
      currentSources: [{ filename, storageKey, sha256: sourceSha256 }],
    }),
    (error: unknown) => hasReuseCode(error, "source_changed"),
    "산출물 내부 grantId가 요청 공고와 달라도 교차 재사용하지 않음",
  );

  // 2단 effort 배선: 현재 env effort와 산출물 requestedEffort가 다르면 계약 불일치로 차단하되,
  // 과거 산출물(필드 없음)은 null 동치라 env 미설정 조합에서는 통과해야 한다.
  assert.doesNotThrow(
    () => assertReusableApplicationRoundtrip({
      grantId: "grant-1",
      run: sourceRun(),
      manifest: sourceManifest(),
      transport: "claude-cli",
      model: "claude-opus-5",
      currentSources: [{ filename, storageKey, sha256: sourceSha256 }],
    }),
    "과거 산출물(requestedEffort 부재) + env 미설정은 null 동치로 통과",
  );
  process.env.APPLICATION_ROUNDTRIP_EFFORT = "medium";
  assert.throws(
    () => assertReusableApplicationRoundtrip({
      grantId: "grant-1",
      run: sourceRun(),
      manifest: sourceManifest(),
      transport: "claude-cli",
      model: "claude-opus-5",
      currentSources: [{ filename, storageKey, sha256: sourceSha256 }],
    }),
    (error: unknown) => hasReuseCode(error, "contract_mismatch"),
    "env effort가 지정됐는데 산출물은 effort 미지정이면 재사용하지 않음",
  );
  assert.doesNotThrow(
    () => assertReusableApplicationRoundtrip({
      grantId: "grant-1",
      run: { ...sourceRun(), requestedEffort: "medium" },
      manifest: sourceManifest(),
      transport: "claude-cli",
      model: "claude-opus-5",
      currentSources: [{ filename, storageKey, sha256: sourceSha256 }],
    }),
    "산출물 effort와 env effort가 일치하면 통과",
  );
  delete process.env.APPLICATION_ROUNDTRIP_EFFORT;
  assert.throws(
    () => assertReusableApplicationRoundtrip({
      grantId: "grant-1",
      run: { ...sourceRun(), requestedEffort: "medium" },
      manifest: sourceManifest(),
      transport: "claude-cli",
      model: "claude-opus-5",
      currentSources: [{ filename, storageKey, sha256: sourceSha256 }],
    }),
    (error: unknown) => hasReuseCode(error, "contract_mismatch"),
    "산출물에 effort가 있는데 env 미설정이면 재사용하지 않음",
  );
} finally {
  process.chdir(originalCwd);
  if (originalEffortEnv === undefined) delete process.env.APPLICATION_ROUNDTRIP_EFFORT;
  else process.env.APPLICATION_ROUNDTRIP_EFFORT = originalEffortEnv;
  await rm(temporaryRoot, { recursive: true, force: true });
}

console.log("application roundtrip reuse tests: ok");

function hasReuseCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function sourceRun(): ApplicationRoundtripRun {
  return {
    version: APPLICATION_ROUNDTRIP_VERSION,
    runId: sourceRunId,
    grantId: "grant-1",
    source: "bizinfo",
    sourceId: "source-1",
    title: "재사용 테스트",
    engine: "kordoc",
    engineVersion: VERSION,
    parentLabRunId: "run-2026-08-10T000000.000Z-111111",
    transport: "claude-cli",
    requestedModel: "claude-opus-5",
    timeoutMs: 900_000,
    candidateLimit: null,
    candidateConcurrency: 1,
    failureCode: null,
    startedAt: "2026-08-11T00:00:00.000Z",
    durationMs: 120_000,
    sourceCount: 1,
    skippedDocumentCount: 0,
    documents: [{
      attachmentId,
      filename,
      declaredFormat: "hwp",
      detectedFormat: "hwp",
      sourceSha256,
      byteLength: 1_024,
      parseDurationMs: 100,
      parsedChars: 20,
      blockCount: 1,
      tableCount: 1,
      formConfidence: 0.9,
      role: "application_form",
      roleConfidence: 0.95,
      roleScores: { applicationForm: 10, businessPlan: 0, announcement: 0, evidence: 0 },
      roleSignals: ["신청서"],
      fields: [],
      choiceGroups: [{
        groupId: "group-1",
        label: "신청 유형",
        normalizedLabel: "신청 유형",
        selectionMode: "single",
        source: "hwp-form-control",
        options: [{ optionId: "option-1", label: "신규", selected: false }],
        location: { sectionIndex: 0, tableIndex: 0, row: 0, col: 0, pageNumber: null },
      }],
      emptyFieldCount: 0,
      recommendedInputFieldCount: 0,
      recommendedChoiceGroupCount: 1,
      fieldPlanning: {
        status: "llm",
        model: "claude-opus-5",
        durationMs: 100_000,
        candidateCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        warning: null,
        transport: "claude-cli",
        requestedModel: "claude-opus-5",
        candidateLimit: null,
        candidateConcurrency: 1,
        parentLabRunId: "run-2026-08-10T000000.000Z-111111",
        failureCode: null,
        processedCandidateCount: 0,
        unprocessedCandidateCount: 0,
        adjudicationStatus: "not_needed",
        adjudicationRounds: 0,
        adjudicatedCandidateCount: 0,
        remainingUnresolvedCandidateCount: 0,
        requestCount: 1,
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        costUsd: 1.25,
      },
      fieldCoverage: {
        status: "complete",
        rawEmptyCandidateCount: 0,
        acceptedInputCount: 0,
        unresolvedCandidateCount: 0,
        structuralWarningCount: 0,
        unresolvedCandidates: [],
        structuralWarnings: [],
        structuralInputLabelCount: 0,
        anchorReadyInputCount: 0,
        anchorUnreadyInputCount: 0,
      },
      markdownPreview: "# 신청서",
      warnings: [],
      error: null,
    }],
    recommendedAttachmentId: attachmentId,
    recommendationReason: "신청 양식",
    error: null,
  };
}

function sourceManifest(): RoundtripRunManifest {
  return {
    version: 1,
    runId: sourceRunId,
    grantId: "grant-1",
    source: "bizinfo",
    sourceId: "source-1",
    attachments: [{
      attachmentId,
      filename,
      storageKey,
      sourceSha256,
      detectedFormat: "hwp",
    }],
  };
}
