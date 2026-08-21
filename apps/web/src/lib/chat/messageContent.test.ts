import assert from "node:assert/strict";
import { parseFieldAssistOutcome, uiMessagePartsToContent } from "./messageContent";

const proposal = parseFieldAssistOutcome({
  status: "proposal",
  fieldId: "field-1",
  label: "사업 개요",
  guidance: "한 문단으로 작성하세요.",
  readiness: { score: 90, threshold: 85, canApply: true },
  proposal: {
    value: "제안 값",
    basis: "사업자 정보",
    basisKind: "profile",
    runId: "run-1",
    suggestionId: "suggestion-1",
  },
});
assert.equal(proposal?.status, "proposal");
assert.equal(proposal?.label, "사업 개요");
assert.equal(proposal?.status === "proposal" ? proposal.proposal.runId : null, "run-1");
assert.equal(proposal?.readiness.score, 90);
assert.equal(proposal?.readiness.canApply, true);

assert.equal(parseFieldAssistOutcome({
  status: "proposal",
  fieldId: "field-1",
  label: "사업 개요",
  guidance: "안내",
  proposal: { value: "", basis: "", basisKind: "unknown" },
}), null);

const content = uiMessagePartsToContent([
  { type: "text", text: "답변" },
  {
    type: "source-document",
    providerMetadata: { anthropic: { citedText: "공고 근거" } },
  },
  {
    type: "data-fieldAssist",
    data: {
      status: "needs_input",
      fieldId: "field-1",
      label: "최근 연 매출",
      guidance: "직전 회계연도 기준입니다.",
      readiness: { score: 70, threshold: 85, canApply: false },
      questions: ["직전 회계연도 매출액은 얼마인가요?"],
    },
  },
]);
assert.equal(content.text, "답변");
assert.equal(content.citations?.length, 1);
assert.equal(content.fieldAssist?.status, "needs_input");
assert.equal(content.fieldAssist?.readiness.score, 70);
assert.equal(content.generalNotice, undefined);

const serverCannotOpenApplyBelowThreshold = parseFieldAssistOutcome({
  status: "proposal",
  fieldId: "field-2",
  label: "사업 소개",
  guidance: "초안을 만들었습니다.",
  readiness: { score: 80, threshold: 10, canApply: true },
  proposal: { value: "초안", basis: "사용자 입력", basisKind: "user" },
});
assert.equal(serverCannotOpenApplyBelowThreshold?.readiness.threshold, 85);
assert.equal(serverCannotOpenApplyBelowThreshold?.readiness.canApply, false);

const legacyProposal = parseFieldAssistOutcome({
  status: "proposal",
  fieldId: "legacy-field",
  label: "사업 소개",
  guidance: "기존 저장 메시지",
  proposal: { value: "기존 초안", basis: "회사 정보", basisKind: "profile" },
});
assert.equal(legacyProposal?.readiness.score, 90, "기존 저장 메시지는 호환 가능한 준비도로 읽어야 합니다.");

const deduplicatedCitations = uiMessagePartsToContent([
  {
    type: "source-document",
    providerMetadata: { anthropic: { citedText: "창업아이템 소개 및 시장조사 결과" } },
  },
  {
    type: "source-document",
    providerMetadata: { anthropic: { citedText: "창업아이템  소개 및\n시장조사 결과" } },
  },
]);
assert.equal(deduplicatedCitations.citations?.length, 1);
assert.equal(deduplicatedCitations.generalNotice, undefined);

console.log("chat message content field-assist tests passed");
