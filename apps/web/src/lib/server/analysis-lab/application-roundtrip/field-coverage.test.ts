import assert from "node:assert/strict";
import type { RoundtripFieldCandidate } from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { finalizeRoundtripFieldCoverage } from "./field-coverage";

const accepted = field({ id: "company-intro", label: "회사소개*", required: true, recommendedInput: true });
const complete = finalizeRoundtripFieldCoverage([accepted]);
assert.equal(complete.status, "complete");
assert.equal(complete.acceptedInputCount, 1);
assert.equal(complete.unresolvedCandidateCount, 0);
assert.equal(complete.anchorReadyInputCount, 1);
assert.equal(complete.anchorUnreadyInputCount, 0);

const unknownBlank = field({ id: "unknown", label: "추가 설명", recommendedInput: false });
const unresolved = finalizeRoundtripFieldCoverage([unknownBlank]);
assert.equal(unresolved.status, "review_required");
assert.equal(unresolved.unresolvedCandidateCount, 1);
assert.equal(unresolved.unresolvedCandidates[0]?.label, "추가 설명");

const header = field({
  id: "header",
  label: "구분",
  empty: true,
  recommendedInput: false,
  signals: ["표 머리글·단위 가능성이 높은 라벨"],
});
assert.equal(finalizeRoundtripFieldCoverage([header]).status, "complete");

const collapsed = field({
  id: "collapsed-choice",
  label: "선택 항목 1",
  source: "contextual-region",
  empty: false,
  recommendedInput: true,
  inputLikelihood: 0.97,
  writeOperation: "toggle_text_choice",
  targetText: `신청서 전체 내용 ${"□ 선택지 ".repeat(60)}`,
});
const partial = finalizeRoundtripFieldCoverage([accepted, collapsed]);
assert.equal(partial.status, "partial");
assert.equal(partial.structuralWarningCount, 1);
assert.equal(collapsed.recommendedInput, false, "문서 전체가 접힌 거대 선택 후보는 빠른 작성에서 제외해야 한다");
assert.equal(collapsed.inputLikelihood, 0.1);

const structural = field({
  id: "representative-name",
  label: "대표자 성명",
  source: "rhwp-structural",
  recommendedInput: true,
  writeOperation: "rhwp_field",
});
const structuralCoverage = finalizeRoundtripFieldCoverage([structural]);
assert.equal(structuralCoverage.status, "complete");
assert.equal(structuralCoverage.structuralInputLabelCount, 1);
assert.equal(structuralCoverage.anchorReadyInputCount, 1);

const wholeBlock = field({
  id: "whole-block",
  label: "사업 계획",
  source: "contextual-region",
  recommendedInput: true,
  writeOperation: "replace_instruction",
  targetText: "사업 계획을 작성하세요.",
  targetKind: "block_text",
});
const anchorIncomplete = finalizeRoundtripFieldCoverage([wholeBlock]);
assert.equal(anchorIncomplete.status, "review_required");
assert.equal(anchorIncomplete.anchorReadyInputCount, 0);
assert.equal(anchorIncomplete.anchorUnreadyInputCount, 1);
assert.match(anchorIncomplete.unresolvedCandidates[0]?.reason ?? "", /RHWP 구조 위치/);

const paragraphField = field({
  id: "open-company-name",
  label: "기업체명",
  source: "contextual-region",
  recommendedInput: true,
  writeOperation: "replace_span",
  targetText: "",
  targetKind: "paragraph_text",
});
paragraphField.location.row = -1;
paragraphField.location.col = -1;
paragraphField.location.target = {
  kind: "paragraph_text",
  row: null,
  col: null,
  textStart: "가. 기업체명 :".length,
  textEnd: "가. 기업체명 :".length,
  expectedText: "",
  expectedSha256: "a".repeat(64),
  paragraphPrefix: "가. 기업체명 :",
  paragraphSuffix: "",
  paragraphOccurrence: 0,
};
const paragraphCoverage = finalizeRoundtripFieldCoverage([paragraphField]);
assert.equal(paragraphCoverage.status, "complete");
assert.equal(paragraphCoverage.anchorReadyInputCount, 1);
assert.equal(paragraphCoverage.anchorUnreadyInputCount, 0);

console.log("application-roundtrip field coverage tests: ok");

function field(input: {
  id: string;
  label: string;
  required?: boolean;
  empty?: boolean;
  recommendedInput: boolean;
  source?: RoundtripFieldCandidate["source"];
  inputLikelihood?: number;
  writeOperation?: RoundtripFieldCandidate["writeOperation"];
  signals?: string[];
  targetText?: string;
  targetKind?: "table_cell" | "block_text" | "paragraph_text";
}): RoundtripFieldCandidate {
  const targetText = input.targetText;
  return {
    fieldInstanceId: input.id,
    label: input.label,
    displayLabel: input.label,
    normalizedLabel: input.label.normalize("NFKC").replace(/[※*★\s]/g, "").toLowerCase(),
    originalValue: input.empty === false ? targetText ?? "기존값" : "",
    type: "text",
    required: input.required ?? false,
    empty: input.empty ?? true,
    recommendedInput: input.recommendedInput,
    inputLikelihood: input.inputLikelihood ?? 0.59,
    inputSignals: [...(input.signals ?? [])],
    sampleValue: "샘플",
    sampleReason: "테스트",
    source: input.source ?? "kordoc-form",
    inputKind: input.writeOperation === "toggle_text_choice" ? "multiple_choice" : "textarea",
    writeOperation: input.writeOperation ?? "kordoc_field",
    helperText: null,
    unit: null,
    options: [],
    analysisSource: "heuristic",
    llmConfidence: null,
    location: {
      blockIndex: 1,
      row: 1,
      col: 0,
      occurrence: 0,
      pageNumber: 1,
      ...(targetText
        ? {
            target: {
              kind: input.targetKind ?? "table_cell",
              row: 1,
              col: 0,
              textStart: 0,
              textEnd: targetText.length,
              expectedText: targetText,
              expectedSha256: "a".repeat(64),
            },
          }
        : {}),
    },
  };
}
