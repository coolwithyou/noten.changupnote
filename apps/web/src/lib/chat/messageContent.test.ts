import assert from "node:assert/strict";
import { parseFieldAssistOutcome, uiMessagePartsToContent } from "./messageContent";

const proposal = parseFieldAssistOutcome({
  status: "proposal",
  fieldId: "field-1",
  label: "사업 개요",
  guidance: "한 문단으로 작성하세요.",
  proposal: { value: "제안 값", basis: "사업자 정보", basisKind: "profile" },
});
assert.equal(proposal?.status, "proposal");
assert.equal(proposal?.label, "사업 개요");

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
      questions: ["직전 회계연도 매출액은 얼마인가요?"],
    },
  },
]);
assert.equal(content.text, "답변");
assert.equal(content.citations?.length, 1);
assert.equal(content.fieldAssist?.status, "needs_input");
assert.equal(content.generalNotice, undefined);

console.log("chat message content field-assist tests passed");
