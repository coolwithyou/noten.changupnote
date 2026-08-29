import assert from "node:assert/strict";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
  type RoundtripParsedDocument,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import type { LabRun } from "@/lib/server/analysis-lab/lab-contract";
import type { RoundtripRunManifest } from "../analysis-lab/application-roundtrip/store";
import {
  applicationPrecomputeAnalysisVersion,
  buildApplicationPrecomputeMaterializationPlan,
  buildApplicationPrecomputeSurfacePlan,
} from "./applicationPrecomputeMaterialization";
import { mergeLegacyLocalPreviewStructure } from "./localApplicationPrecomputePreview";

const GRANT_ID = "00000000-0000-4000-8000-000000000001";
const LAB_RUN_ID = "run-2026-08-04T000000.000Z-abcdef";
const ROUNDTRIP_RUN_ID = "roundtrip-2026-08-04T000000.000Z-abcdef";
const SOURCE_SHA = "a".repeat(64);
const STORAGE_KEY = "grant-attachments/bizinfo/test/application.hwp";

const document = roundtripDocument();
const run = roundtripRun(document);
const labRun = {
  runId: LAB_RUN_ID,
  grantId: GRANT_ID,
  applicationRoundtrip: {
    status: "complete",
    runId: ROUNDTRIP_RUN_ID,
    transport: "claude-cli",
    model: "claude-opus-5",
    documentCount: 1,
    sourceCount: 1,
    errorCode: null,
    error: null,
  },
} as unknown as LabRun;
const manifest: RoundtripRunManifest = {
  version: 1,
  runId: ROUNDTRIP_RUN_ID,
  grantId: GRANT_ID,
  source: "bizinfo",
  sourceId: "test-source",
  attachments: [{
    attachmentId: document.attachmentId,
    filename: document.filename,
    storageKey: STORAGE_KEY,
    sourceSha256: SOURCE_SHA,
    detectedFormat: "hwp",
  }],
};

// 같은 LabRun·원본 SHA에 봉인된 완전 분석만 workspace field projection 계획으로 낮춘다.
{
  const [planned] = buildApplicationPrecomputeMaterializationPlan({
    labRun,
    roundtripRun: run,
    manifest,
    surfaces: [surface(STORAGE_KEY, SOURCE_SHA)],
  });
  assert.ok(planned);
  assert.equal(planned.status, "complete");
  assert.equal(planned.fields.length, 1);
  assert.equal(planned.fields[0]?.label, "회사소개");
  assert.equal(planned.metadata.sourceSha256, SOURCE_SHA);
  assert.equal(planned.metadata.roundtripRunId, ROUNDTRIP_RUN_ID);
  assert.equal(planned.candidateSet.candidates.length, 1);
  assert.ok(planned.analysisVersion.startsWith("kordoc-rhwp-application-precompute-v1:"));
  assert.equal(planned.analysisVersion, applicationPrecomputeAnalysisVersion(run));
}

// deep receipt가 독립 Kordoc canary를 결속한 release는 LabRun 내부 참조 없이도 같은 seam을 쓴다.
{
  const { applicationRoundtrip: _embeddedRoundtrip, ...independentLabRun } = labRun;
  const independentRun = { ...run, parentLabRunId: null };
  const [planned] = buildApplicationPrecomputeMaterializationPlan({
    labRun: independentLabRun,
    roundtripRun: independentRun,
    manifest,
    surfaces: [surface(STORAGE_KEY, SOURCE_SHA)],
    receiptBoundRoundtrip: {
      parentLabRunId: LAB_RUN_ID,
      roundtripRunId: ROUNDTRIP_RUN_ID,
    },
  });
  assert.equal(planned?.status, "complete");
  assert.throws(
    () => buildApplicationPrecomputeMaterializationPlan({
      labRun: independentLabRun,
      roundtripRun: independentRun,
      manifest,
      surfaces: [surface(STORAGE_KEY, SOURCE_SHA)],
      receiptBoundRoundtrip: {
        parentLabRunId: "run-2026-08-04T000001.000Z-badbad",
        roundtripRunId: ROUNDTRIP_RUN_ID,
      },
    }),
    /LabRun의 Kordoc 참조와 roundtrip runId가 일치하지 않습니다/,
  );
}

// surface가 가리키는 원본이 바뀌면 과거 분석 결과를 절대 materialize하지 않는다.
assert.throws(
  () => buildApplicationPrecomputeMaterializationPlan({
    labRun,
    roundtripRun: run,
    manifest,
    surfaces: [surface(STORAGE_KEY, "b".repeat(64))],
  }),
  /surface 원본 SHA와 roundtrip manifest가 일치하지 않습니다/,
);

// bounded 상한 밖 문서는 누락 성공이 아니라 사람 확인이 필요한 종결 상태로 남긴다.
{
  const limitedRun = { ...run, sourceCount: 2, skippedDocumentCount: 1 };
  const [planned] = buildApplicationPrecomputeMaterializationPlan({
    labRun,
    roundtripRun: limitedRun,
    manifest,
    surfaces: [surface("grant-attachments/bizinfo/test/second.hwp", "c".repeat(64))],
  });
  assert.equal(planned?.status, "review_required");
  assert.equal(planned?.errorCode, "document_limit_exceeded");
  assert.equal(planned?.fields.length, 0);
}

// 신규 v8 구조 검수가 review_required면 일부 확정 필드도 운영 projection하지 않는다.
{
  const reviewDocument = {
    ...document,
    fieldCoverage: { ...document.fieldCoverage, status: "review_required" as const },
  };
  const reviewRun = roundtripRun(reviewDocument);
  const [planned] = buildApplicationPrecomputeMaterializationPlan({
    labRun,
    roundtripRun: reviewRun,
    manifest,
    surfaces: [surface(STORAGE_KEY, SOURCE_SHA)],
  });
  assert.equal(planned?.status, "review_required");
  assert.equal(planned?.fields.length, 0);
  assert.equal(planned?.candidateSet.candidates.length, 1);
}

// 이미 봉인된 v7은 관리자 로컬 preview에서만 확정 필드를 호환 투영한다.
{
  const reviewDocument = {
    ...document,
    fieldCoverage: { ...document.fieldCoverage, status: "review_required" as const },
  };
  const legacyRun = { ...roundtripRun(reviewDocument), version: "kordoc-application-roundtrip-v7" };
  const planned = buildApplicationPrecomputeSurfacePlan({
    surface: surface(STORAGE_KEY, SOURCE_SHA),
    run: legacyRun as ApplicationRoundtripRun,
    analysisVersion: "local-preview:kordoc-application-roundtrip-v7",
    sourceSha256: SOURCE_SHA,
    document: reviewDocument,
  });
  assert.equal(planned.status, "partial");
  assert.equal(planned.fields.length, 1);
}

// v7 관리자 preview는 current-SHA 구조 보강으로 안내문 앵커를 교체하고 누락 라벨을 추가한다.
{
  const basePlan = buildApplicationPrecomputeSurfacePlan({
    surface: surface(STORAGE_KEY, SOURCE_SHA),
    run,
    analysisVersion: "local-preview:kordoc-application-roundtrip-v7",
    sourceSha256: SOURCE_SHA,
    document,
  });
  const legacyPlan = {
    ...basePlan,
    fields: [
      ...basePlan.fields,
      {
        ...basePlan.fields[0]!,
        fieldKey: "legacy_amount_placeholder",
        label: "융자 신청금액(백만원)",
        position: {
          ...basePlan.fields[0]!.position,
          page: basePlan.fields[0]!.position?.page ?? null,
          bbox: basePlan.fields[0]!.position?.bbox ?? null,
          anchorLabel: "금: 백만원",
          normalizedLabel: "금백만원",
        },
      },
    ],
  };
  const freshFields = [
    {
      ...document.fields[0]!,
      fieldInstanceId: "field-representative",
      label: "대표자 성명",
      displayLabel: "대표자 성명",
      normalizedLabel: "대표자성명",
      source: "rhwp-structural" as const,
      writeOperation: "rhwp_field" as const,
      location: { blockIndex: 0, row: 1, col: 6, occurrence: 0, pageNumber: 1 },
    },
    {
      ...document.fields[0]!,
      fieldInstanceId: "field-amount",
      label: "신청금액",
      displayLabel: "신청금액",
      normalizedLabel: "신청금액",
      originalValue: "금: 백만원",
      type: "amount" as const,
      source: "kordoc-form" as const,
      inputKind: "number" as const,
      inputSignals: ["입력 셀에 남아 있는 고정 양식 placeholder"],
      location: { blockIndex: 0, row: 8, col: 4, occurrence: 0, pageNumber: 1 },
    },
    {
      ...document.fields[0]!,
      fieldInstanceId: "field-open-company-name",
      label: "기업체명",
      displayLabel: "기업체명",
      normalizedLabel: "기업체명",
      originalValue: "",
      source: "contextual-region" as const,
      writeOperation: "replace_span" as const,
      inputSignals: ["표 밖 단일 라벨 문단", "고정 prefix/value/suffix exact binding"],
      location: {
        blockIndex: 3,
        row: -1,
        col: -1,
        occurrence: 0,
        pageNumber: 2,
        target: {
          kind: "paragraph_text" as const,
          row: null,
          col: null,
          textStart: 9,
          textEnd: 9,
          expectedText: "",
          expectedSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          paragraphPrefix: "가. 기업체명 :",
          paragraphSuffix: "",
          paragraphOccurrence: 0,
        },
      },
    },
  ];
  const merged = mergeLegacyLocalPreviewStructure(legacyPlan, document, freshFields);
  assert.equal(merged.fields.some((field) => field.fieldKey === "legacy_amount_placeholder"), false);
  assert.ok(merged.fields.some((field) => field.position?.anchorLabel === "대표자 성명"));
  assert.ok(merged.fields.some((field) => field.position?.anchorLabel === "신청금액"));
  assert.ok(merged.fields.some((field) => field.position
    && "targetKind" in field.position
    && field.position.targetKind === "body_paragraph_text"));
  assert.equal(merged.fields.length, 4);
}

// LLM 일반 실패 뒤 구조 후보가 안전하면 heuristic 필드를 partial로 보존한다.
{
  const heuristicDocument = {
    ...document,
    fields: document.fields.map((field) => ({
      ...field,
      analysisSource: "heuristic" as const,
      llmConfidence: null,
    })),
    fieldPlanning: {
      ...document.fieldPlanning,
      status: "heuristic_fallback" as const,
      failureCode: "request_timeout" as const,
      warning: "LLM 필드 판정 실패: timed out",
      model: "claude-sonnet-5",
    },
  };
  const heuristicRun = roundtripRun(heuristicDocument);
  const [planned] = buildApplicationPrecomputeMaterializationPlan({
    labRun,
    roundtripRun: heuristicRun,
    manifest,
    surfaces: [surface(STORAGE_KEY, SOURCE_SHA)],
  });
  assert.equal(planned?.status, "partial");
  assert.equal(planned?.errorCode, "request_timeout");
  assert.equal(planned?.fields.length, 1);
}

console.log("application precompute materialization tests: ok");

function surface(sourceAttachment: string, sourceSha256: string) {
  return {
    id: "00000000-0000-4000-8000-000000000010",
    title: "지원 신청서",
    type: "file_template",
    format: "hwp",
    sourceAttachment,
    sourceSha256,
  };
}

function roundtripRun(parsed: RoundtripParsedDocument): ApplicationRoundtripRun {
  return {
    version: APPLICATION_ROUNDTRIP_VERSION,
    runId: ROUNDTRIP_RUN_ID,
    grantId: GRANT_ID,
    source: "bizinfo",
    sourceId: "test-source",
    title: "테스트 공고",
    engine: "kordoc",
    engineVersion: "4.2.3",
    parentLabRunId: LAB_RUN_ID,
    transport: "claude-cli",
    requestedModel: "claude-opus-5",
    timeoutMs: 900_000,
    candidateLimit: 180,
    candidateConcurrency: 1,
    failureCode: null,
    startedAt: "2026-08-04T00:00:00.000Z",
    durationMs: 100,
    sourceCount: 1,
    skippedDocumentCount: 0,
    documents: [parsed],
    recommendedAttachmentId: parsed.attachmentId,
    recommendationReason: "지원서",
    error: null,
  };
}

function roundtripDocument(): RoundtripParsedDocument {
  return {
    attachmentId: "attachment-1",
    filename: "지원 신청서.hwp",
    declaredFormat: "hwp",
    detectedFormat: "hwp",
    sourceSha256: SOURCE_SHA,
    byteLength: 1_024,
    parseDurationMs: 10,
    parsedChars: 100,
    blockCount: 1,
    tableCount: 1,
    formConfidence: 0.99,
    role: "application_form",
    roleConfidence: 0.99,
    roleScores: { applicationForm: 10, businessPlan: 0, announcement: 0, evidence: 0 },
    roleSignals: [],
    fields: [{
      fieldInstanceId: "field-1",
      label: "회사소개",
      displayLabel: "회사소개",
      normalizedLabel: "회사소개",
      originalValue: "",
      type: "text",
      empty: true,
      source: "contextual-region",
      inputLikelihood: 0.95,
      recommendedInput: true,
      inputKind: "textarea",
      writeOperation: "replace_instruction",
      required: true,
      sampleValue: "",
      sampleReason: "",
      helperText: null,
      unit: null,
      options: [],
      analysisSource: "llm",
      inputSignals: ["blank_cell"],
      llmConfidence: 0.93,
      location: {
        blockIndex: 0,
        row: 1,
        col: 1,
        occurrence: 0,
        pageNumber: 1,
      },
    }],
    choiceGroups: [],
    emptyFieldCount: 1,
    recommendedInputFieldCount: 1,
    recommendedChoiceGroupCount: 0,
    fieldPlanning: {
      status: "llm",
      model: "claude-opus-5",
      requestedModel: "claude-opus-5",
      transport: "claude-cli",
      timeoutMs: 900_000,
      candidateLimit: 180,
      failureCode: null,
      candidateCount: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      durationMs: 10,
      warning: null,
    },
    fieldCoverage: {
      status: "complete",
      rawEmptyCandidateCount: 1,
      acceptedInputCount: 1,
      unresolvedCandidateCount: 0,
      structuralWarningCount: 0,
      unresolvedCandidates: [],
      structuralWarnings: [],
      structuralInputLabelCount: 0,
      anchorReadyInputCount: 1,
      anchorUnreadyInputCount: 0,
    },
    markdownPreview: "회사소개",
    warnings: [],
    error: null,
  };
}
