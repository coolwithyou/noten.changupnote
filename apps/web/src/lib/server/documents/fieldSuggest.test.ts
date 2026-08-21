import assert from "node:assert/strict";
import { normalizeWs } from "../knowledge/extraction";
import {
  buildSuggestInstruction,
  finalizeFieldSuggestReadiness,
  resolveRequestedSuggestionLabel,
  verifySuggestion,
} from "./fieldSuggest";

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
assert.ok(instruction.includes("요청받은 모든 항목을 assessments에 한 번씩 포함"));
assert.ok(instruction.includes("85% 미만인 항목은 suggestions에 포함하지 않습니다"));
assert.ok(instruction.includes("성명·주소처럼 단순 사실을 묻는 항목에 경험·성과를 요구하지 않습니다"));

assert.deepEqual(
  finalizeFieldSuggestReadiness({
    score: 92,
    missingInformation: [],
    hasVerifiedSuggestion: true,
  }),
  { score: 90, threshold: 85, canApply: true, missingInformation: [] },
);
assert.deepEqual(
  finalizeFieldSuggestReadiness({
    score: 95,
    missingInformation: ["확인할 수 있는 매출 근거가 있나요?"],
    hasVerifiedSuggestion: false,
  }),
  {
    score: 80,
    threshold: 85,
    canApply: false,
    missingInformation: ["확인할 수 있는 매출 근거가 있나요?"],
  },
  "검증된 초안이 없으면 모델 점수가 높아도 문서 반영 게이트를 열면 안 됩니다.",
);

const choiceInstruction = buildSuggestInstruction({
  labels: ["창업자 유형"],
  mode: "generate",
  alternativesPerLabel: 2,
  allowedValuesByLabel: {
    "창업자 유형": ["예비창업자", "폐업 후 재창업자"],
  },
});
assert.ok(choiceInstruction.includes("[허용 선택지]"));
assert.ok(choiceInstruction.includes("예비창업자 | 폐업 후 재창업자"));
assert.ok(choiceInstruction.includes("글자 단위로 정확히"));

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

assert.equal(
  resolveRequestedSuggestionLabel(["주 고객\n및\n이용 대상"], "주 고객 및 이용 대상"),
  "주 고객\n및\n이용 대상",
  "문서 줄바꿈 라벨과 모델의 한 줄 라벨을 같은 exact 요청으로 귀속해야 합니다.",
);
assert.equal(
  resolveRequestedSuggestionLabel(["주 고객 및 이용 대상", "주 고객\n및\n이용 대상"], "주 고객  및 이용 대상"),
  null,
  "공백 정규화 후 후보가 둘이면 임의 귀속하면 안 됩니다.",
);

console.log("field suggestion source-text contract tests passed");
