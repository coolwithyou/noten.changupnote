import assert from "node:assert/strict";
import type {
  ApplicationRoundtripRun,
  RoundtripParsedDocument,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import {
  buildApplicationRoundtripReference,
  classifyApplicationFieldAnalysis,
  runAnalysisPair,
} from "./application-precompute";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// await 전에 두 형제 작업이 모두 시작되고, sidecar 실패가 primary를 오염시키지 않는다.
{
  const primary = deferred<string>();
  const application = deferred<string>();
  const started: string[] = [];
  const pending = runAnalysisPair({
    primary: () => {
      started.push("primary");
      return primary.promise;
    },
    application: () => {
      started.push("application");
      return application.promise;
    },
  });
  assert.deepEqual(started, ["primary", "application"], "primary를 Kordoc보다 먼저 큐에 넣음");
  application.reject(new Error("Kordoc 실패"));
  primary.resolve("딥 분석 성공");
  const result = await pending;
  assert.equal(result.primary, "딥 분석 성공");
  assert.equal(result.application?.status, "rejected");
}

// 첨부 부재는 실패가 아니라 명시적 not_applicable 종결이다.
{
  const error = Object.assign(new Error("HWP 없음"), { code: "hwp_attachment_not_found" });
  const reference = buildApplicationRoundtripReference({
    result: { status: "rejected", reason: error },
    transport: "claude-cli",
    model: "claude-opus-5",
  });
  assert.equal(reference.status, "not_applicable");
  assert.equal(reference.error, null);
  assert.equal(reference.errorCode, "hwp_attachment_not_found");
  assert.equal(reference.recognizedFieldCount, 0);
  assert.equal(classifyApplicationFieldAnalysis(reference), "not_applicable");
}

// complete 문서가 있어도 review_required 문서가 섞이면 전체 target을 보류한다.
{
  const complete = document("complete", 2);
  complete.fieldPlanning = {
    status: "llm",
    model: "claude-opus-5",
    durationMs: 1,
    candidateCount: 2,
    acceptedCount: 2,
    rejectedCount: 0,
    warning: null,
    costUsd: 0.42,
  };
  const review = document("review_required", 0);
  review.fieldPlanning = {
    status: "llm",
    model: "claude-opus-5",
    durationMs: 1,
    candidateCount: 1,
    acceptedCount: 0,
    rejectedCount: 1,
    warning: null,
    costUsd: 0.08,
  };
  const run = {
    runId: "roundtrip-test",
    documents: [complete, review],
    recommendedAttachmentId: complete.attachmentId,
    error: null,
  } as unknown as ApplicationRoundtripRun;
  const reference = buildApplicationRoundtripReference({
    result: { status: "fulfilled", value: run },
    transport: "api",
    model: "claude-opus-5",
  });
  assert.equal(reference.status, "review_required");
  assert.equal(reference.documentCount, 2);
  assert.equal(reference.applicationDocumentCount, 2);
  assert.equal(reference.fieldReadyDocumentCount, 1);
  assert.equal(reference.recognizedFieldCount, 2);
  assert.equal(classifyApplicationFieldAnalysis(reference), "held");
  assert.equal(reference.costUsd, 0.5, "문서별 최초·재판정 합산 비용을 reference에 보존");
}

// review_required 문서는 일부 확정 필드가 있어도 대량분석 완료로 세지 않는다.
{
  const reviewWithSafeFields = document("review_required", 3);
  const run = {
    runId: "roundtrip-review-with-safe-fields",
    documents: [reviewWithSafeFields],
    recommendedAttachmentId: reviewWithSafeFields.attachmentId,
    error: null,
  } as unknown as ApplicationRoundtripRun;
  const reference = buildApplicationRoundtripReference({
    result: { status: "fulfilled", value: run },
    transport: "claude-cli",
    model: "claude-opus-5",
  });
  assert.equal(reference.status, "review_required");
  assert.equal(reference.recognizedFieldCount, 0);
  assert.equal(classifyApplicationFieldAnalysis(reference), "held");
}

// 구버전처럼 anchor coverage가 없으면 표시 가능한 필드가 있어도 v8 ready로 추정하지 않는다.
{
  const missingAnchorCoverage = document("complete", 2);
  delete missingAnchorCoverage.fieldCoverage.anchorReadyInputCount;
  delete missingAnchorCoverage.fieldCoverage.anchorUnreadyInputCount;
  const reference = buildApplicationRoundtripReference({
    result: {
      status: "fulfilled",
      value: {
        runId: "roundtrip-missing-anchor-coverage",
        documents: [missingAnchorCoverage],
        recommendedAttachmentId: missingAnchorCoverage.attachmentId,
        error: null,
      } as unknown as ApplicationRoundtripRun,
    },
    transport: "claude-cli",
    model: "claude-opus-5",
  });
  assert.equal(reference.fieldReadyDocumentCount, 0);
  assert.equal(reference.recognizedFieldCount, 0);
  assert.equal(classifyApplicationFieldAnalysis(reference), "held");
}

// 일부 문서 파싱 실패가 있으면 성공 문서에서 지원서를 찾지 못했어도 not_applicable로 숨기지 않는다.
{
  const unrelated = {
    ...document("complete", 0),
    attachmentId: "attachment-announcement",
    role: "announcement",
  } as RoundtripParsedDocument;
  const failed = {
    ...document("review_required", 0),
    attachmentId: "attachment-failed",
    role: "unknown",
    error: "Kordoc parse failed",
  } as RoundtripParsedDocument;
  const run = {
    runId: "roundtrip-partial-parse-failure",
    documents: [unrelated, failed],
    recommendedAttachmentId: null,
    failureCode: "document_analysis_failed",
    error: null,
  } as unknown as ApplicationRoundtripRun;
  const reference = buildApplicationRoundtripReference({
    result: { status: "fulfilled", value: run },
    transport: "claude-cli",
    model: "claude-opus-5",
  });
  assert.equal(reference.status, "review_required");
  assert.equal(reference.errorCode, "document_analysis_failed");
  assert.equal(classifyApplicationFieldAnalysis(reference), "held");
}

// bounded 문서 상한 밖 원본이 있으면 처리한 문서가 완전해도 전체 target을 보류한다.
{
  const complete = document("complete", 2);
  const run = {
    runId: "roundtrip-document-limit",
    documents: [complete],
    sourceCount: 11,
    skippedDocumentCount: 10,
    recommendedAttachmentId: complete.attachmentId,
    failureCode: "document_limit_exceeded",
    error: null,
  } as unknown as ApplicationRoundtripRun;
  const reference = buildApplicationRoundtripReference({
    result: { status: "fulfilled", value: run },
    transport: "claude-cli",
    model: "claude-opus-5",
  });
  assert.equal(reference.status, "review_required");
  assert.equal(reference.sourceCount, 11);
  assert.equal(reference.errorCode, "document_limit_exceeded");
  assert.equal(classifyApplicationFieldAnalysis(reference), "held");
}

// application 문서를 찾았지만 확정 필드가 0개면 publishable 대량분석 결과로 승격하지 않는다.
{
  const emptyApplication = document("complete", 0);
  const reference = buildApplicationRoundtripReference({
    result: {
      status: "fulfilled",
      value: {
        runId: "roundtrip-empty-application",
        documents: [emptyApplication],
        recommendedAttachmentId: emptyApplication.attachmentId,
        error: null,
      } as unknown as ApplicationRoundtripRun,
    },
    transport: "claude-cli",
    model: "claude-opus-5",
  });
  assert.equal(reference.applicationDocumentCount, 1);
  assert.equal(reference.recognizedFieldCount, 0);
  assert.equal(classifyApplicationFieldAnalysis(reference), "held");
}

console.log("application precompute tests: ok");

function document(
  status: RoundtripParsedDocument["fieldCoverage"]["status"],
  recommendedInputFieldCount: number,
): RoundtripParsedDocument {
  return {
    attachmentId: `attachment-${status}`,
    role: "application_form",
    error: null,
    recommendedInputFieldCount,
    recommendedChoiceGroupCount: 0,
    fieldCoverage: {
      status,
      rawEmptyCandidateCount: recommendedInputFieldCount,
      acceptedInputCount: recommendedInputFieldCount,
      unresolvedCandidateCount: status === "review_required" ? 1 : 0,
      structuralWarningCount: 0,
      unresolvedCandidates: [],
      structuralWarnings: [],
      structuralInputLabelCount: 0,
      anchorReadyInputCount: recommendedInputFieldCount,
      anchorUnreadyInputCount: 0,
    },
  } as unknown as RoundtripParsedDocument;
}
