import assert from "node:assert/strict";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
  type RoundtripParsedDocument,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import {
  ANALYSIS_LAB_PROMPT_VERSION,
  type LabReview,
  type LabRun,
} from "@/features/dev/analysis-lab/contract";
import { evaluateAnalysisQuality } from "./quality-graph";

function runFixture(overrides: Partial<LabRun> = {}): LabRun {
  return {
    runId: "run-2026-08-09T000000.000Z-aaaaaa",
    grantId: "grant-1",
    source: "bizinfo",
    sourceId: "source-1",
    title: "품질 그래프 테스트 공고",
    model: "claude-opus-5",
    transport: "claude-cli",
    promptVersion: ANALYSIS_LAB_PROMPT_VERSION,
    startedAt: "2026-08-09T00:00:00.000Z",
    durationMs: 1,
    inputBlocks: [{ label: "공고", chars: 100, truncated: false }],
    inputTotalChars: 100,
    inputSha256: "a".repeat(64),
    usage: null,
    costUsd: null,
    analysisMarkdown: "분석",
    programIntent: null,
    criteria: [{
      dimension: "region",
      kind: "required",
      operator: "in",
      value: { regions: ["충남"] },
      confidence: 0.9,
      sourceSpan: "충청남도 소재 기업",
      spanVerified: true,
      note: null,
    }],
    axisAssessments: CRITERION_DIMENSIONS.map((dimension) => ({
      dimension,
      status: dimension === "region" ? "condition_found" : "inspected_no_condition",
      confidence: 0.9,
      comment: null,
    })),
    taxonomyProposals: [],
    dimensionDiffs: [],
    error: null,
    ...overrides,
  };
}

function reviewFixture(run: LabRun, verdict: "correct" | "wrong" = "correct"): LabReview {
  return {
    grantId: run.grantId,
    runId: run.runId,
    reviewerEmail: "owner@example.com",
    createdAt: "2026-08-09T00:00:00.000Z",
    updatedAt: "2026-08-09T00:00:00.000Z",
    criterionReviews: [{ criterionIndex: 0, verdict, note: verdict === "correct" ? null : "오류" }],
    axisReviews: CRITERION_DIMENSIONS.slice(1).map((dimension) => ({
      dimension,
      verdict: "confirmed_absent",
      note: null,
    })),
    overallNote: null,
  };
}

function documentFixture(input: { requiredUnresolved?: boolean; optionalUnresolved?: boolean } = {}): RoundtripParsedDocument {
  const fields = [{
    fieldInstanceId: "field-1",
    label: "사업자등록번호",
    displayLabel: "사업자등록번호",
    normalizedLabel: "사업자등록번호",
    originalValue: "",
    type: "idnum" as const,
    required: input.requiredUnresolved ?? false,
    empty: true,
    recommendedInput: !(input.requiredUnresolved || input.optionalUnresolved),
    inputLikelihood: 0.99,
    inputSignals: [],
    sampleValue: "000-00-00001",
    sampleReason: "테스트",
    source: "kordoc-form" as const,
    inputKind: "text" as const,
    writeOperation: "kordoc_field" as const,
    helperText: null,
    unit: null,
    options: [],
    analysisSource: "llm" as const,
    llmConfidence: 0.99,
    llmDecision: input.requiredUnresolved || input.optionalUnresolved
      ? "uncertain" as const
      : "input" as const,
    location: { blockIndex: 0, row: 0, col: 0, occurrence: 1, pageNumber: null },
  }];
  const unresolved = input.requiredUnresolved || input.optionalUnresolved
    ? [{ fieldInstanceId: "field-1", label: "사업자등록번호", reason: "판정 보류", location: fields[0]!.location }]
    : [];
  return {
    attachmentId: "attachment-1",
    filename: "신청서.hwp",
    declaredFormat: "hwp",
    detectedFormat: "hwp",
    sourceSha256: "b".repeat(64),
    byteLength: 100,
    parseDurationMs: 1,
    parsedChars: 100,
    blockCount: 1,
    tableCount: 1,
    formConfidence: 0.9,
    role: "application_form",
    roleConfidence: 0.9,
    roleScores: { applicationForm: 1, businessPlan: 0, announcement: 0, evidence: 0 },
    roleSignals: [],
    fields,
    choiceGroups: [],
    emptyFieldCount: 1,
    recommendedInputFieldCount: unresolved.length === 0 ? 1 : 0,
    recommendedChoiceGroupCount: 0,
    fieldPlanning: {
      status: "llm",
      model: "claude-opus-5",
      durationMs: 1,
      candidateCount: 1,
      acceptedCount: unresolved.length === 0 ? 1 : 0,
      rejectedCount: unresolved.length,
      warning: null,
      transport: "claude-cli",
      requestedModel: "claude-opus-5",
      processedCandidateCount: 1,
      unprocessedCandidateCount: 0,
      remainingUnresolvedCandidateCount: unresolved.length,
    },
    fieldCoverage: {
      status: unresolved.length === 0 ? "complete" : "review_required",
      rawEmptyCandidateCount: 1,
      acceptedInputCount: unresolved.length === 0 ? 1 : 0,
      unresolvedCandidateCount: unresolved.length,
      structuralWarningCount: 0,
      unresolvedCandidates: unresolved,
      structuralWarnings: [],
    },
    markdownPreview: "",
    warnings: [],
    error: null,
  };
}

function roundtripFixture(run: LabRun, document = documentFixture()): ApplicationRoundtripRun {
  return {
    version: APPLICATION_ROUNDTRIP_VERSION,
    runId: "roundtrip-2026-08-09T000000.000Z-bbbbbb",
    grantId: run.grantId,
    source: run.source,
    sourceId: run.sourceId,
    title: run.title,
    engine: "kordoc",
    engineVersion: "4.2.3",
    parentLabRunId: run.runId,
    transport: "claude-cli",
    requestedModel: "claude-opus-5",
    startedAt: run.startedAt,
    durationMs: 1,
    sourceCount: 1,
    skippedDocumentCount: 0,
    documents: [document],
    recommendedAttachmentId: document.attachmentId,
    recommendationReason: "신청서",
    error: null,
  };
}

{
  const baseRun = runFixture();
  const roundtrip = roundtripFixture(baseRun);
  const run = runFixture({
    primaryRepairCount: 1,
    applicationRoundtrip: {
      status: "complete",
      runId: roundtrip.runId,
      transport: "claude-cli",
      model: "claude-opus-5",
      documentCount: 1,
      sourceCount: 1,
      errorCode: null,
      error: null,
    },
  });
  roundtrip.parentLabRunId = run.runId;
  const graph = evaluateAnalysisQuality({
    run,
    review: { source: "ai_audit", review: reviewFixture(run), complete: true, currentPolicy: true },
    roundtrip,
  });
  assert.equal(graph.analysisReadiness, "passed");
  assert.equal(graph.productReadiness, "not_evaluated", "승격·카나리 증거를 성공으로 추정하지 않음");
  assert.equal(graph.metrics.requiredUnresolvedFields, 0);
  assert.equal(
    graph.nodes.find((node) => node.id === "deep_contract")?.evidence.includes("validator 자동 교정 1회"),
    true,
    "품질 그래프에 자동 교정 횟수 보존",
  );
  console.log("✅ 품질 그래프 — 분석 완료와 제품 미검증을 분리");
}

{
  const run = runFixture();
  const graph = evaluateAnalysisQuality({
    run,
    review: { source: "human", review: reviewFixture(run, "wrong"), complete: true, currentPolicy: true },
    roundtrip: null,
  });
  assert.equal(graph.lanes.deep_analysis, "held", "hard criterion 오판정은 승격 보류");
  assert.equal(graph.lanes.application, "not_evaluated", "Kordoc 미실행을 실패로 왜곡하지 않음");
  console.log("✅ 딥분석 — 신청자격 검수 차단과 Kordoc 미실행 구분");
}

{
  const baseRun = runFixture();
  const roundtrip = roundtripFixture(baseRun, documentFixture({ optionalUnresolved: true }));
  const run = runFixture({
    applicationRoundtrip: {
      status: "partial",
      runId: roundtrip.runId,
      transport: "claude-cli",
      model: "claude-opus-5",
      documentCount: 1,
      sourceCount: 1,
      errorCode: null,
      error: null,
      remainingUnresolvedCandidateCount: 1,
    },
  });
  roundtrip.parentLabRunId = run.runId;
  const graph = evaluateAnalysisQuality({
    run,
    review: { source: "human", review: reviewFixture(run), complete: true, currentPolicy: true },
    roundtrip,
  });
  assert.equal(graph.lanes.application, "partial", "비필수 미해결은 안전한 부분 완료");
  assert.equal(graph.analysisReadiness, "partial");
  console.log("✅ Kordoc — 비필수 미해결은 실패가 아닌 부분 완료");
}

{
  const baseRun = runFixture();
  const roundtrip = roundtripFixture(baseRun, documentFixture({ requiredUnresolved: true }));
  const run = runFixture({
    applicationRoundtrip: {
      status: "review_required",
      runId: roundtrip.runId,
      transport: "claude-cli",
      model: "claude-opus-5",
      documentCount: 1,
      sourceCount: 1,
      errorCode: null,
      error: null,
      remainingUnresolvedCandidateCount: 1,
    },
  });
  roundtrip.parentLabRunId = run.runId;
  const graph = evaluateAnalysisQuality({
    run,
    review: { source: "human", review: reviewFixture(run), complete: true, currentPolicy: true },
    roundtrip,
  });
  assert.equal(graph.lanes.application, "held", "필수 입력 미해결은 보류");
  assert.equal(graph.metrics.requiredUnresolvedFields, 1);
  console.log("✅ Kordoc — 필수 입력 미해결은 자동 통과 금지");
}

{
  const run = runFixture({ inputSha256: "broken", error: "model failed" });
  const graph = evaluateAnalysisQuality({ run, review: null, roundtrip: null });
  assert.equal(graph.lanes.deep_analysis, "failed");
  assert.equal(graph.nodes.find((node) => node.id === "input_sealed")?.status, "failed");
  console.log("✅ 계약 파손 — 실패를 부분 완료로 완화하지 않음");
}

{
  const run = runFixture({ inputBlocks: [{ label: "변환 불가 ZIP", chars: 0, truncated: true }] });
  const graph = evaluateAnalysisQuality({
    run,
    review: { source: "human", review: reviewFixture(run), complete: true, currentPolicy: true },
    roundtrip: null,
  });
  assert.equal(graph.nodes.find((node) => node.id === "input_sealed")?.status, "partial");
  assert.notEqual(graph.lanes.deep_analysis, "failed", "변환 불가 첨부를 계약 파손으로 과장하지 않음");
  console.log("✅ 입력 범위 — 변환 불가 첨부는 명시적 부분 완료");
}
