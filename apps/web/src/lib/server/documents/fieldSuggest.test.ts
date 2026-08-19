import assert from "node:assert/strict";
import { normalizeWs } from "../knowledge/extraction";
import { buildSuggestInstruction, verifySuggestion } from "./fieldSuggest";

const sourceText = "저희는 소상공인의 반복적인 정산 업무를 줄이는 서비스를 운영하고 있습니다.";

const instruction = buildSuggestInstruction({
  labels: ["회사소개"],
  mode: "generate",
  sourceText,
  alternativesPerLabel: 2,
});

assert.ok(instruction.includes("[사용자가 작성한 원문 — 보강 대상이자 사실의 기준]"));
assert.ok(instruction.includes(sourceText));
assert.ok(instruction.includes("사실·수치·고유명사·의미를 유지"));
assert.ok(instruction.includes("원문에 없는 회사 사실을 추가하지 마세요"));
assert.ok(instruction.includes("표현 방향이 분명히 다른 대안을 최대 2개"));
assert.ok(instruction.includes("억지로 두 개를 만들지 않습니다"));

const verified = verifySuggestion(
  {
    label: "회사소개",
    value: "당사는 소상공인의 반복적인 정산 업무를 효율화하는 서비스를 운영합니다.",
    basis: "사용자가 작성한 회사소개",
    basisKind: "user",
    evidenceQuote: "소상공인의 반복적인 정산 업무를 줄이는 서비스",
  },
  "",
  normalizeWs(sourceText),
);
assert.ok(verified, "사용자 원문에 실제로 존재하는 근거 인용은 통과해야 합니다.");
assert.equal(verified?.basisKind, "user");

const inventedEvidence = verifySuggestion(
  {
    label: "회사소개",
    value: "누적 고객 1만 명을 보유한 기업입니다.",
    basis: "사용자 입력",
    basisKind: "user",
    evidenceQuote: "누적 고객 1만 명",
  },
  "",
  normalizeWs(sourceText),
);
assert.equal(inventedEvidence, null, "사용자 원문에 없는 근거를 인용한 보강안은 폐기해야 합니다.");

console.log("field suggestion source-text contract tests passed");
