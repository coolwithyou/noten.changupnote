import assert from "node:assert/strict";
import type { RoundtripFieldCandidate } from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { extractLocatedRoundtripFields } from "./core";
import { detectUnsupportedNativeInputGaps, finalizeRoundtripFieldCoverage } from "./field-coverage";

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

const suspectedPlaceholder = field({
  id: "suspected-placeholder",
  label: "책임자",
  recommendedInput: false,
  signals: ["앞 라벨 “대표”의 값 placeholder 가능성"],
});
const suspectedPlaceholderCoverage = finalizeRoundtripFieldCoverage([suspectedPlaceholder]);
assert.equal(
  suspectedPlaceholderCoverage.status,
  "review_required",
  "가능성 신호만으로 빈 후보를 확정 거절 처리하면 안 된다",
);
assert.equal(suspectedPlaceholderCoverage.unresolvedCandidateCount, 1);
assert.equal(suspectedPlaceholderCoverage.unresolvedCandidates[0]?.label, "책임자");

const alternatingMetadataFields = extractLocatedRoundtripFields([{
  type: "table",
  table: {
    rows: 1,
    cols: 5,
    hasHeader: false,
    cells: [[
      { text: "기본\n정보", colSpan: 1, rowSpan: 1 },
      { text: "기업명", colSpan: 1, rowSpan: 1 },
      { text: "", colSpan: 1, rowSpan: 1 },
      { text: "대표자", colSpan: 1, rowSpan: 1 },
      { text: "", colSpan: 1, rowSpan: 1 },
    ]],
  },
}], "3".repeat(64)).fields;
const alternatingMetadataCoverage = finalizeRoundtripFieldCoverage(alternatingMetadataFields);
assert.equal(alternatingMetadataCoverage.status, "complete");
assert.equal(alternatingMetadataCoverage.acceptedInputCount, 2);
assert.equal(alternatingMetadataCoverage.anchorReadyInputCount, 2);
assert.equal(
  alternatingMetadataFields.find((candidate) => candidate.label === "기업명")?.recommendedInput,
  true,
  "독립 기업명 입력은 추출부터 coverage까지 유지해야 한다",
);

const unboundHighConfidenceNegative = field({
  id: "unbound-high-confidence-negative",
  label: "공동대표",
  recommendedInput: false,
  analysisSource: "llm",
  llmConfidence: 0.95,
});
unboundHighConfidenceNegative.llmDecision = "not_input";
unboundHighConfidenceNegative.inputSignals.push("LLM 맥락 판정: 입력 대상 아님");
assert.equal(
  finalizeRoundtripFieldCoverage([unboundHighConfidenceNegative]).status,
  "review_required",
  "confidence만 높고 해당 구조 위치의 근거가 없으면 complete로 닫지 않음",
);

const boundHighConfidenceNegative = field({
  id: "bound-high-confidence-negative",
  label: "구획 제목",
  recommendedInput: false,
  analysisSource: "llm",
  llmConfidence: 0.95,
});
boundHighConfidenceNegative.llmDecision = "not_input";
boundHighConfidenceNegative.inputSignals.push(
  "LLM 맥락 판정: 입력 대상 아님",
  "LLM 비입력 근거의 구조 위치 결속 확인",
);
assert.equal(
  finalizeRoundtripFieldCoverage([boundHighConfidenceNegative]).status,
  "complete",
  "해당 구조 위치와 결속된 고신뢰 negative는 전역 hold 없이 종결",
);

const recoveredBoundNegative = field({
  id: "recovered-bound-negative",
  label: "담당 업무",
  recommendedInput: false,
  analysisSource: "llm",
  llmConfidence: 0.93,
});
recoveredBoundNegative.llmDecision = "not_input";
recoveredBoundNegative.inputSignals.push(
  "LLM 비입력 근거 위치 불일치 또는 누락",
  "LLM 비입력 근거의 구조 위치 결속 확인",
);
assert.equal(
  finalizeRoundtripFieldCoverage([recoveredBoundNegative]).status,
  "complete",
  "현재 최종 구조 결속 negative는 앞 라운드의 mismatch 진단 뒤에도 coverage를 회복",
);

const staleBoundNegative = field({
  id: "stale-bound-negative",
  label: "참 고",
  recommendedInput: false,
  analysisSource: "llm",
  llmConfidence: 0.93,
});
staleBoundNegative.llmDecision = "uncertain";
staleBoundNegative.inputSignals.push(
  "LLM 비입력 근거의 구조 위치 결속 확인",
  "LLM 비입력 근거 위치 불일치 또는 누락",
);
assert.equal(
  finalizeRoundtripFieldCoverage([staleBoundNegative]).status,
  "review_required",
  "현재 uncertain은 과거 구조 결속 marker를 재사용해 complete로 닫지 않음",
);

const mismatchedFixedMarker = field({
  id: "mismatched-fixed-marker",
  label: "고정 기호 입력 대상 아님",
  originalValue: "-",
  recommendedInput: false,
  analysisSource: "llm",
  llmConfidence: 0.95,
});
mismatchedFixedMarker.llmDecision = "uncertain";
mismatchedFixedMarker.inputSignals.push("LLM 비입력 근거 위치 불일치 또는 누락");
assert.equal(
  finalizeRoundtripFieldCoverage([mismatchedFixedMarker]).status,
  "review_required",
  "고정 마커 설명이 있어도 현재 LLM 위치 근거 불일치를 우회하지 않음",
);

const header = field({
  id: "header",
  label: "구분",
  empty: true,
  recommendedInput: false,
  signals: ["표 머리글·단위 가능성이 높은 라벨"],
});
assert.equal(finalizeRoundtripFieldCoverage([header]).status, "complete");

const fixedMarker = field({
  id: "fixed-marker",
  label: "자체 지표",
  displayLabel: "자체 지표 (고정 표기 '-')",
  originalValue: "-",
  helperText: "문서에 고정된 기호이며 입력 영역이 아닙니다.",
  empty: true,
  recommendedInput: false,
  analysisSource: "llm",
  llmConfidence: 0.72,
});
assert.equal(
  finalizeRoundtripFieldCoverage([fixedMarker]).status,
  "complete",
  "고정 대시와 비입력 설명이 함께 있으면 저신뢰 LLM 후보도 안전하게 제외해야 한다",
);

const titleCell = field({
  id: "title-cell",
  label: "상생형 창업벤처기업 지원사업 지원기업 사업계획서",
  empty: true,
  recommendedInput: false,
  signals: ["사업계획 서술 라벨", "표 첫 행의 긴 제목 가능성", "표 첫 행의 머리글 가능성"],
});
assert.equal(
  finalizeRoundtripFieldCoverage([titleCell]).status,
  "complete",
  "표 첫 행 제목을 미해결 입력 후보로 남기면 안 된다",
);

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

const compactCollapsed = field({
  id: "compact-collapsed-choice",
  label: "선택 항목 1",
  source: "contextual-region",
  empty: false,
  recommendedInput: true,
  inputLikelihood: 0.97,
  writeOperation: "toggle_text_choice",
  targetText: `${"□ 정산 항목 ".repeat(20)}후속 안내`,
});
const compactPartial = finalizeRoundtripFieldCoverage([accepted, compactCollapsed]);
assert.equal(compactPartial.status, "partial");
assert.equal(compactCollapsed.recommendedInput, false, "120자 이상 접힌 선택 묶음도 안전 제외해야 한다");

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

const unsupportedBlocks = [{
  type: "table" as const,
  table: {
    rows: 2,
    cols: 2,
    hasHeader: false,
    cells: [
      [
        { text: "남성 :    명 / 여성 :     명", colSpan: 1, rowSpan: 1 },
        { text: "정규직:    명 / 비정규직:   명", colSpan: 1, rowSpan: 1 },
      ],
      [
        { text: "□ 노무관리진단", colSpan: 1, rowSpan: 1 },
        { text: "□ 임금명세서 발급지원", colSpan: 1, rowSpan: 1 },
      ],
    ],
  },
}];
const unsupportedGaps = detectUnsupportedNativeInputGaps({
  blocks: unsupportedBlocks,
  fields: [],
  role: "application_form",
});
assert.equal(unsupportedGaps.length, 4, "미결속 복수 숫자 입력과 텍스트 체크박스를 모두 경고해야 한다");
const unsupportedCoverage = finalizeRoundtripFieldCoverage([], unsupportedGaps);
assert.equal(unsupportedCoverage.status, "partial");
assert.equal(unsupportedCoverage.structuralWarningCount, 4);
assert.equal(unsupportedCoverage.acceptedInputCount, 0, "미지원 gap을 쓰기 후보로 승격하면 안 된다");

assert.deepEqual(
  detectUnsupportedNativeInputGaps({ blocks: unsupportedBlocks, fields: [], role: "evidence" }),
  [],
  "동의·증빙 문서의 고정 표기를 신청서 field coverage로 확대하면 안 된다",
);

const boundInline = field({
  id: "bound-inline-counts",
  label: "성별 인원",
  recommendedInput: true,
  source: "contextual-region",
  writeOperation: "replace_span",
  targetText: "남성 :    명 / 여성 :     명",
});
boundInline.location.blockIndex = 0;
boundInline.location.row = 0;
boundInline.location.col = 0;
boundInline.location.target!.row = 0;
boundInline.location.target!.col = 0;
const boundCheckbox = field({
  id: "bound-checkbox",
  label: "노무관리진단",
  recommendedInput: true,
  source: "contextual-region",
  writeOperation: "toggle_text_choice",
  targetText: "□ 노무관리진단",
});
boundCheckbox.location.blockIndex = 0;
boundCheckbox.location.row = 1;
boundCheckbox.location.col = 0;
boundCheckbox.location.target!.row = 1;
boundCheckbox.location.target!.col = 0;
const remainingGaps = detectUnsupportedNativeInputGaps({
  blocks: unsupportedBlocks,
  fields: [boundInline, boundCheckbox],
  role: "application_form",
});
assert.equal(remainingGaps.length, 2, "이미 exact 결속된 셀을 미지원 gap으로 중복 경고하면 안 된다");
assert.deepEqual(remainingGaps.map((gap) => [gap.location.row, gap.location.col]), [[0, 1], [1, 1]]);

{
  const mediaBlocks = [{
    type: "table" as const,
    table: {
      rows: 1,
      cols: 3,
      hasHeader: false,
      cells: [[
        { text: "이미지", colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        {
          text: "※ 참고사진(이미지)·설계도 등 삽입(해당 시)",
          colSpan: 1,
          rowSpan: 1,
          blocks: [{ type: "paragraph" as const, text: "※ 참고사진(이미지)·설계도 등 삽입(해당 시)" }],
        },
      ]],
    },
  }];
  const mediaFields = extractLocatedRoundtripFields(mediaBlocks, "7".repeat(64)).fields;
  const mediaGaps = detectUnsupportedNativeInputGaps({
    blocks: mediaBlocks,
    fields: mediaFields,
    role: "application_form",
  });
  assert.equal(mediaGaps.length, 1);
  assert.match(mediaGaps[0]?.reason ?? "", /텍스트 writer/);
  const mediaCoverage = finalizeRoundtripFieldCoverage(mediaFields, mediaGaps);
  assert.equal(mediaCoverage.status, "partial", "지원하지 않는 media 입력을 complete로 가장하지 않음");
  assert.equal(mediaCoverage.acceptedInputCount, 0);
  assert.equal(mediaCoverage.unresolvedCandidateCount, 0, "알려진 unsupported와 의미 불명을 중복 집계하지 않음");
  assert.equal(mediaCoverage.structuralWarningCount, 1);
}

{
  const mergedConditionalBlocks = [{
    type: "table" as const,
    table: {
      rows: 1,
      cols: 8,
      hasHeader: false,
      cells: [[
        { text: "법인등록번호", colSpan: 4, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "해당 시", colSpan: 3, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ]],
    },
  }];
  const mergedFields = extractLocatedRoundtripFields(mergedConditionalBlocks, "6".repeat(64)).fields;
  const mergedCoverage = finalizeRoundtripFieldCoverage(mergedFields);
  assert.equal(mergedCoverage.status, "complete");
  assert.equal(mergedCoverage.acceptedInputCount, 1, "canonical 법인등록번호만 입력으로 admission");
  assert.equal(mergedCoverage.unresolvedCandidateCount, 0, "소비된 placeholder 후보가 review hold로 남지 않음");
}

{
  const fixedAggregateBlocks = [{
    type: "table" as const,
    table: {
      rows: 3,
      cols: 5,
      hasHeader: true,
      cells: [
        ["구분", "단가", "수량", "금액", "비고"].map((text) => ({ text, colSpan: 1, rowSpan: 1 })),
        ["장비", "10", "1", "10", ""].map((text) => ({ text, colSpan: 1, rowSpan: 1 })),
        ["계", "", "", "", ""].map((text) => ({ text, colSpan: 1, rowSpan: 1 })),
      ],
    },
  }];
  const fixedAggregateFields = extractLocatedRoundtripFields(
    fixedAggregateBlocks,
    "8".repeat(64),
  ).fields;
  const fixedAggregate = fixedAggregateFields.find((candidate) => (
    candidate.location.row === 2 && candidate.location.col === 0
  ));
  assert.ok(fixedAggregate);
  assert.equal(fixedAggregate.recommendedInput, false, "고정 집계 라벨을 값 후보로 쓰지 않음");
  const aggregateGaps = detectUnsupportedNativeInputGaps({
    blocks: fixedAggregateBlocks,
    fields: fixedAggregateFields,
    role: "application_form",
  });
  assert.equal(aggregateGaps.length, 1);
  assert.equal(aggregateGaps[0]?.location.col, 1, "첫 미결속 합계 값 셀을 가리킴");
  assert.match(aggregateGaps[0]?.reason ?? "", /다열 빈 값 4개/);
  const aggregateCoverage = finalizeRoundtripFieldCoverage(fixedAggregateFields, aggregateGaps);
  assert.equal(aggregateCoverage.status, "partial", "고정 라벨 제외로 인접 입력 미지원을 숨기지 않음");
  assert.equal(aggregateCoverage.structuralWarningCount, 1);

  const exactValueFields = [1, 2, 3, 4].map((col) => {
    const valueField = field({
      id: `aggregate-value-${col}`,
      label: `합계 값 ${col}`,
      recommendedInput: true,
      targetText: " ",
    });
    valueField.location = {
      blockIndex: 0,
      row: 2,
      col: 0,
      occurrence: 0,
      pageNumber: 1,
      target: {
        kind: "table_cell",
        row: 2,
        col,
        textStart: 0,
        textEnd: 0,
        expectedText: "",
        expectedSha256: "a".repeat(64),
      },
    };
    return valueField;
  });
  assert.deepEqual(
    detectUnsupportedNativeInputGaps({
      blocks: fixedAggregateBlocks,
      fields: [...fixedAggregateFields, ...exactValueFields],
      role: "application_form",
    }),
    [],
    "인접 합계 값 셀이 모두 exact field로 결속되면 미지원 경고를 만들지 않음",
  );
}

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
  displayLabel?: string;
  originalValue?: string;
  helperText?: string;
  analysisSource?: RoundtripFieldCandidate["analysisSource"];
  llmConfidence?: number;
}): RoundtripFieldCandidate {
  const targetText = input.targetText;
  return {
    fieldInstanceId: input.id,
    label: input.label,
    displayLabel: input.displayLabel ?? input.label,
    normalizedLabel: input.label.normalize("NFKC").replace(/[※*★\s]/g, "").toLowerCase(),
    originalValue: input.originalValue ?? (input.empty === false ? targetText ?? "기존값" : ""),
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
    helperText: input.helperText ?? null,
    unit: null,
    options: [],
    analysisSource: input.analysisSource ?? "heuristic",
    llmConfidence: input.llmConfidence ?? null,
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
