import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FieldAssistOutcome } from "@/lib/chat/messageContent";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { FieldAssistCard, collectFieldEvidence } = await import("./ChatPanel");

assert.deepEqual(
  collectFieldEvidence([], "'성 명' 항목은 어떤 내용을 어떻게 작성해야 하나요? 공고 기준으로 알려주세요.", "성 명"),
  [],
  "시스템의 최초 필드 질문은 사용자 근거로 수집하면 안 됩니다.",
);
assert.deepEqual(
  collectFieldEvidence(["대표자는 홍길동입니다."], "2025년 1월부터 대표를 맡았습니다.", "성 명"),
  ["대표자는 홍길동입니다.", "2025년 1월부터 대표를 맡았습니다."],
  "사용자가 직접 답한 사실은 필드별 누적 근거로 전달해야 합니다.",
);

const needsInput: FieldAssistOutcome = {
  status: "needs_input",
  fieldId: "field-name",
  label: "성 명",
  guidance: "AI가 현재 근거를 검토한 결과, 문서 반영 기준에 아직 도달하지 않았습니다.",
  readiness: { score: 40, threshold: 85, canApply: false },
  questions: ["신청자 또는 대표자의 정확한 성명을 알려주세요."],
};

const needsInputHtml = renderToStaticMarkup(
  <FieldAssistCard outcome={needsInput} onRequestAnswer={() => {}} />,
);
assert.ok(needsInputHtml.includes("성 명 문서 반영 준비도"));
assert.ok(needsInputHtml.includes("현재 준비도"));
assert.ok(needsInputHtml.includes("40%"));
assert.ok(needsInputHtml.includes("85% 이상이 되면"));
assert.ok(needsInputHtml.includes("신청자 또는 대표자의 정확한 성명을 알려주세요."));
assert.ok(needsInputHtml.includes("답변 입력하기"));
assert.equal(
  needsInputHtml.includes(">신청자 또는 대표자의 정확한 성명을 알려주세요.</button>"),
  false,
  "시스템 질문 자체가 전송 버튼으로 렌더되면 안 됩니다.",
);

const blockedProposal: FieldAssistOutcome = {
  status: "proposal",
  fieldId: "field-intro",
  label: "사업 소개",
  guidance: "아직 확인할 정보가 있습니다.",
  readiness: { score: 80, threshold: 85, canApply: false },
  proposal: { value: "검토 중인 초안", basis: "사용자 입력", basisKind: "user" },
};
const blockedHtml = renderToStaticMarkup(
  <FieldAssistCard outcome={blockedProposal} onApply={() => {}} />,
);
assert.equal(blockedHtml.includes("사업 소개에 적용하기"), false, "85% 미만에서는 문서 반영 버튼을 열면 안 됩니다.");

console.log("chat field assist readiness render tests passed");
