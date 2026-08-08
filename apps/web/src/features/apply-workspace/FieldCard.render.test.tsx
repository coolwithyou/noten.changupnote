import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import { AiEnhancementStatus } from "./AiEnhancementStatus";
import { FieldCard } from "./FieldCard";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const field: ConnectedDocumentField = {
  fieldId: "field-company-introduction",
  fieldKey: "company.introduction",
  label: "회사소개*",
  section: "신청서",
  fieldType: "textarea",
  required: true,
  sourceSpan: null,
  mappedCompanyField: null,
  fillStrategy: "generate",
  position: { page: 1, bbox: [0.1, 0.1, 0.8, 0.3] },
  visualEvidence: null,
};

const noop = () => undefined;

const emptyHtml = renderToStaticMarkup(
  <FieldCard
    field={field}
    answer={undefined}
    reviewPosition={1}
    reviewTotal={5}
    isDuplicate={false}
    isSelected
    isPending={false}
    isSuggestable
    isSuggesting={false}
    tips={[]}
    onAccept={noop}
    onSave={noop}
    onDismiss={noop}
    onUndo={noop}
    onAsk={noop}
    onNext={noop}
    onRequestSuggestion={noop}
    onKeepOriginal={noop}
    canAsk
    canLocateInDocument={false}
    isLocatingInDocument={false}
    onStartLocate={noop}
  />,
);

assert.ok(emptyHtml.includes("입력한 내용 보강하기"));
assert.ok(emptyHtml.includes("메모처럼 짧게 적어도 괜찮아요"));
assert.ok(emptyHtml.includes("어떤 제품을 누구에게 제공하는지"));
assert.equal(emptyHtml.includes("초안 제안 받기"), false);
const enhancementLabelIndex = emptyHtml.indexOf("입력한 내용 보강하기");
const enhancementButtonStart = emptyHtml.lastIndexOf("<button", enhancementLabelIndex);
const enhancementButtonOpenEnd = emptyHtml.indexOf(">", enhancementButtonStart);
assert.ok(
  emptyHtml.slice(enhancementButtonStart, enhancementButtonOpenEnd).includes("disabled"),
  "원문이 비어 있을 때 보강 요청은 비활성화돼야 합니다.",
);

const sourceText = "산업 현장의 문서 업무를 줄이는 서비스를 만들고 있습니다.";
const suggestedValue = "당사는 산업 현장의 반복적인 문서 업무를 효율화하는 서비스를 개발·운영합니다.";
const suggestionHtml = renderToStaticMarkup(
  <FieldCard
    field={field}
    answer={{
      value: suggestedValue,
      status: "suggested",
      source: "llm",
      suggestedValue,
      suggestionInput: sourceText,
      basis: "사용자가 작성한 회사소개",
      updatedAt: "2026-08-05T00:00:00.000Z",
    }}
    reviewPosition={1}
    reviewTotal={5}
    isDuplicate={false}
    isSelected
    isPending={false}
    isSuggestable
    isSuggesting={false}
    tips={[]}
    onAccept={noop}
    onSave={noop}
    onDismiss={noop}
    onUndo={noop}
    onAsk={noop}
    onNext={noop}
    onRequestSuggestion={noop}
    onKeepOriginal={noop}
    canAsk
    canLocateInDocument={false}
    isLocatingInDocument={false}
    onStartLocate={noop}
  />,
);

assert.ok(suggestionHtml.includes("내가 입력한 내용"));
assert.ok(suggestionHtml.includes(sourceText));
assert.ok(suggestionHtml.includes("보강 제안"));
assert.ok(suggestionHtml.includes(suggestedValue));
assert.ok(suggestionHtml.includes("이 제안 사용하기"));
assert.ok(suggestionHtml.includes("원문 유지"));

const workingHtml = renderToStaticMarkup(
  <AiEnhancementStatus id="field-company-introduction-suggestion-status" />,
);
assert.ok(workingHtml.includes('role="status"'));
assert.ok(workingHtml.includes('aria-live="polite"'));
assert.ok(workingHtml.includes("AI 보강 중"));
assert.ok(workingHtml.includes("입력한 사실을 읽고 문장을 다듬고 있어요"));
assert.ok(workingHtml.includes("공고 기준에 맞춰 구조와 표현을 정리하는 중입니다."));

console.log("FieldCard input-enhancement render tests passed");
