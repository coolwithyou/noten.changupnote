import assert from "node:assert/strict";
import type {
  ApplicationRoundtripRun,
  RoundtripParsedDocument,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import {
  buildApplicationRoundtripReference,
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
  assert.deepEqual(started.sort(), ["application", "primary"]);
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
}

// 사용할 수 있는 complete 문서와 review_required 문서가 섞이면 부분 준비로 남긴다.
{
  const complete = document("complete", 2);
  const review = document("review_required", 0);
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
  assert.equal(reference.status, "partial");
  assert.equal(reference.documentCount, 2);
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
}

// bounded 문서 상한 밖 원본이 있으면 처리한 문서가 완전해도 전체 선분석은 partial이다.
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
  assert.equal(reference.status, "partial");
  assert.equal(reference.sourceCount, 11);
  assert.equal(reference.errorCode, "document_limit_exceeded");
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
    },
  } as unknown as RoundtripParsedDocument;
}
