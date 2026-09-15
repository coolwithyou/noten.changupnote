import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type {
  RoundtripFieldCandidate,
  RoundtripParsedDocument,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { serializeReconciledFieldPosition } from "./applyReconciledFields";
import { buildReconciledApplicationFields } from "./applicationFieldAnalysis";

const document: RoundtripParsedDocument = {
  attachmentId: "attachment-1",
  filename: "지원신청서.hwp",
  declaredFormat: "hwp",
  detectedFormat: "hwp",
  sourceSha256: "a".repeat(64),
  byteLength: 1024,
  parseDurationMs: 12,
  parsedChars: 240,
  blockCount: 4,
  tableCount: 2,
  formConfidence: 0.9,
  role: "application_form",
  roleConfidence: 0.95,
  roleScores: { applicationForm: 8, businessPlan: 0, announcement: 0, evidence: 0 },
  roleSignals: ["테스트"],
  fields: [
    field({ id: "company", label: "기업명", displayLabel: "신청기업명", required: true }),
    field({ id: "company-duplicate", label: "기업명", row: 2 }),
    field({ id: "vendor", label: "홍보물 제작기업 기업명", row: 3 }),
    field({
      id: "self-intro",
      label: "자기소개",
      row: 4,
      inputKind: "textarea",
      originalValue: "※ 성장과정과 전공분야가 나타나도록 작성",
    }),
    field({
      id: "same-cell-narrative",
      label: "※ 기타 현재 상황, 개선하고자 하는 점 등 자유롭게 기술해주세요.",
      row: 6,
      col: 0,
      inputKind: "textarea",
      source: "rhwp-structural",
      sameCellTarget: true,
    }),
    field({ id: "rejected", label: "접수번호", recommendedInput: false, row: 5 }),
  ],
  choiceGroups: [{
    groupId: "choice-1",
    label: "신청 분야",
    normalizedLabel: "신청분야",
    selectionMode: "single",
    source: "hwp-form-control",
    options: [
      { optionId: "brochure", label: "홍보 브로슈어", selected: false },
      { optionId: "video", label: "홍보 동영상", selected: false },
    ],
    location: { sectionIndex: 0, tableIndex: 1, row: 0, col: 0, pageNumber: null },
  }],
  emptyFieldCount: 5,
  recommendedInputFieldCount: 4,
  recommendedChoiceGroupCount: 1,
  fieldPlanning: {
    status: "skipped",
    model: null,
    durationMs: 0,
    candidateCount: 5,
    acceptedCount: 4,
    rejectedCount: 1,
    warning: null,
  },
  fieldCoverage: {
    status: "complete",
    rawEmptyCandidateCount: 5,
    acceptedInputCount: 3,
    unresolvedCandidateCount: 0,
    structuralWarningCount: 0,
    unresolvedCandidates: [],
    structuralWarnings: [],
  },
  markdownPreview: "지원 신청서",
  warnings: [],
  error: null,
};

const fields = buildReconciledApplicationFields(document);

assert.equal(fields.length, 6, "추천 입력 5건과 HWP 객관식 1건만 반영해야 한다");
assert.deepEqual(fields.map((item) => item.fieldKey), [
  "company_name",
  "company_name-2",
  "홍보물_제작기업_기업명",
  "자기소개",
  "기타_현재_상황_개선하고자_하는_점_등_자유롭게_기술해주세요",
  "신청_분야",
]);

const company = fields[0]!;
assert.equal(company.mappedCompanyField, "name");
assert.equal(company.fillStrategy, "copy");
assert.equal(company.required, true);
assert.equal(company.documentCategory, "application_form");
assert.equal(company.documentName, "지원신청서.hwp");
assert.deepEqual(company.position, {
  page: 1,
  bbox: null,
  blockIndex: 1,
  row: 1,
  col: 1,
  occurrence: 1,
  normalizedLabel: "기업명",
  anchorLabel: "기업명",
});
assert.deepEqual(
  serializeReconciledFieldPosition(company.position),
  company.position,
  "DB 저장 경계에서 동일 라벨 exact tie-break 구조 위치를 보존해야 한다",
);

const vendor = fields[2]!;
assert.equal(vendor.mappedCompanyField, null, "외주·수행기관 기업명은 신청 기업명으로 자동 채우면 안 된다");
assert.equal(vendor.fillStrategy, "ask_user");

const selfIntro = fields[3]!;
assert.equal(selfIntro.fieldType, "long_text");
assert.equal(selfIntro.fillStrategy, "ask_user");
assert.equal(selfIntro.sourceSpan, "※ 성장과정과 전공분야가 나타나도록 작성");
assert.equal((selfIntro.textEvidence as { helperText?: string })?.helperText, "※ 성장과정과 전공분야가 나타나도록 작성");
assert.equal(selfIntro.position?.targetKind, undefined, "일반 장문 필드에 same-cell region 계약을 추정하면 안 된다");

const sameCellNarrative = fields[4]!;
assert.deepEqual(sameCellNarrative.position, {
  page: 1,
  bbox: null,
  blockIndex: 1,
  row: 6,
  col: 0,
  occurrence: 6,
  normalizedLabel: "※기타현재상황,개선하고자하는점등자유롭게기술해주세요.",
  anchorLabel: "※ 기타 현재 상황, 개선하고자 하는 점 등 자유롭게 기술해주세요.",
  targetKind: "table_cell_region",
  targetRow: 6,
  targetCol: 0,
  protectedPrefixText: "※ 기타 현재 상황, 개선하고자 하는 점 등 자유롭게 기술해주세요.",
});

const choice = fields[5]!;
assert.equal(choice.fieldType, "checkbox");
assert.equal(choice.fillStrategy, "ask_user");
assert.equal(choice.sourceSpan, "□ 홍보 브로슈어 □ 홍보 동영상");
assert.equal((choice.visualEvidence as { source?: string })?.source, "kordoc-rhwp-form-control");

assert.equal(fields.some((item) => item.label === "접수번호"), false);

const techfestSourceSha256 = "5d9ad6200091e341c945f1c746b1512ded6f2d85f0aa21bd6f0eac5b566fe22c";
const techfestFields = buildReconciledApplicationFields({
  ...document,
  sourceSha256: techfestSourceSha256,
  fields: [
    field({
      id: "6200f43ce98d6b731ed42654",
      label: "공동대표",
      displayLabel: "기업 구성 현황 1번 구성원 직위",
      blockIndex: 106,
      row: 17,
      col: 1,
      occurrence: 0,
      analysisSource: "llm",
      llmConfidence: 0.8,
      llmDecision: "input",
      helperText: "예시로 기재된 '공동대표' 자리에 실제 구성원의 직위를 입력한다.",
      inputSignals: [
        "LLM 맥락 판정: 사용자 입력",
        "LLM 표시명 제안: 기업 구성 현황 1번 구성원 직위",
        "LLM 근거: [col1 TARGET;span=1x2] 공동대표",
      ],
    }),
    field({
      id: "851ed55f5c86157703600e13",
      label: "법인등록번호",
      blockIndex: 106,
      row: 5,
      col: 0,
      occurrence: 0,
      originalValue: "해당 시",
    }),
    field({ id: "excluded-conditional", label: "해당 시", blockIndex: 106, row: 5, col: 4, occurrence: 0, recommendedInput: false }),
    field({ id: "excluded-image", label: "이미지 삽입", blockIndex: 106, row: 12, col: 4, occurrence: 0, recommendedInput: false }),
  ],
  choiceGroups: [],
});
assert.equal(techfestFields.length, 2, "구조적으로 제외한 해당 시/이미지는 다시 열지 않는다");
assert.equal(techfestFields[0]?.visualEvidence?.sourceSha256, techfestSourceSha256);
assert.deepEqual(techfestFields[0]?.position, {
  page: 1,
  bbox: null,
  blockIndex: 106,
  row: 17,
  col: 1,
  occurrence: 0,
  normalizedLabel: "공동대표",
  anchorLabel: "공동대표",
  targetKind: "table_cell_text",
  targetRow: 17,
  targetCol: 1,
});
assert.equal(
  techfestFields[1]?.position?.targetKind,
  undefined,
  "일반 법인등록번호 라벨은 기존 오른쪽 값 셀 계약을 유지한다",
);

const techfestPlanSourceSha256 = "7eab03622b926be6e1b08ba28da3210d092c37ef2b479598919729eb5b5ef655";
const [techfestPlanRole] = buildReconciledApplicationFields({
  ...document,
  sourceSha256: techfestPlanSourceSha256,
  fields: [field({
    id: "afa5adef6e56543d22c8effd",
    label: "공동대표",
    displayLabel: "기업 구성 현황 1번 직위",
    blockIndex: 5,
    row: 17,
    col: 1,
    occurrence: 0,
    analysisSource: "llm",
    llmConfidence: 0.88,
    llmDecision: "input",
    helperText: "대표자 본인을 제외한 구성원 1번의 직위를 입력합니다(예: 공동대표, 이사, 팀장 등). 공동·각자대표는 포함합니다.",
    inputSignals: ["LLM 근거: [col1 TARGET;span=1x2] 공동대표"],
  })],
  choiceGroups: [],
});
assert.equal(techfestPlanRole?.visualEvidence?.sourceSha256, techfestPlanSourceSha256);
assert.deepEqual(techfestPlanRole?.position, {
  page: 1,
  bbox: null,
  blockIndex: 5,
  row: 17,
  col: 1,
  occurrence: 0,
  normalizedLabel: "공동대표",
  anchorLabel: "공동대표",
  targetKind: "table_cell_text",
  targetRow: 17,
  targetCol: 1,
});

const [ordinaryLabel] = buildReconciledApplicationFields({
  ...document,
  fields: [field({
    id: "ordinary-contact-label",
    label: "담당자",
    displayLabel: "사업 담당자 이름",
    row: 8,
    col: 0,
    analysisSource: "llm",
    llmConfidence: 0.9,
    llmDecision: "input",
    helperText: "담당자 이름을 입력합니다.",
    inputSignals: ["LLM 근거: [col0 TARGET;span=1x1] 담당자"],
  })],
  choiceGroups: [],
});
assert.equal(
  ordinaryLabel?.position?.targetKind,
  undefined,
  "TARGET 인용이 있어도 예시 값 근거가 없는 일반 라벨은 same-cell을 열지 않는다",
);

console.log("application field analysis tests: ok");

function field(input: {
  id: string;
  label: string;
  displayLabel?: string;
  required?: boolean;
  recommendedInput?: boolean;
  blockIndex?: number;
  row?: number;
  col?: number;
  occurrence?: number;
  inputKind?: RoundtripFieldCandidate["inputKind"];
  originalValue?: string;
  source?: RoundtripFieldCandidate["source"];
  sameCellTarget?: boolean;
  analysisSource?: RoundtripFieldCandidate["analysisSource"];
  llmConfidence?: number;
  llmDecision?: RoundtripFieldCandidate["llmDecision"];
  helperText?: string;
  inputSignals?: string[];
}): RoundtripFieldCandidate {
  return {
    fieldInstanceId: input.id,
    label: input.label,
    displayLabel: input.displayLabel ?? input.label,
    normalizedLabel: input.label.replaceAll(" ", ""),
    originalValue: input.originalValue ?? "",
    type: "text",
    required: input.required ?? false,
    empty: true,
    recommendedInput: input.recommendedInput ?? true,
    inputLikelihood: 0.9,
    inputSignals: input.inputSignals ?? ["테스트"],
    sampleValue: "샘플",
    sampleReason: "테스트",
    source: input.source ?? "kordoc-form",
    inputKind: input.inputKind ?? "text",
    writeOperation: "kordoc_field",
    helperText: input.helperText ?? input.originalValue ?? null,
    unit: null,
    options: [],
    analysisSource: input.analysisSource ?? "heuristic",
    llmConfidence: input.llmConfidence ?? null,
    ...(input.llmDecision ? { llmDecision: input.llmDecision } : {}),
    location: {
      blockIndex: input.blockIndex ?? 1,
      row: input.row ?? 1,
      col: input.col ?? 1,
      occurrence: input.occurrence ?? input.row ?? 1,
      pageNumber: 1,
      ...(input.sameCellTarget ? {
        target: {
          kind: "table_cell" as const,
          row: input.row ?? 1,
          col: input.col ?? 1,
          textStart: 0,
          textEnd: input.label.length,
          expectedText: input.label,
          expectedSha256: createHash("sha256").update(input.label).digest("hex"),
        },
      } : {}),
    },
  };
}
