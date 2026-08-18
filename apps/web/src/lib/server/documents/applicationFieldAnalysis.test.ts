import assert from "node:assert/strict";
import type {
  RoundtripFieldCandidate,
  RoundtripParsedDocument,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
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
    field({ id: "company", label: "기업명", required: true }),
    field({ id: "company-duplicate", label: "기업명", row: 2 }),
    field({ id: "vendor", label: "홍보물 제작기업 기업명", row: 3 }),
    field({ id: "rejected", label: "접수번호", recommendedInput: false, row: 4 }),
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
  emptyFieldCount: 4,
  recommendedInputFieldCount: 3,
  recommendedChoiceGroupCount: 1,
  fieldPlanning: {
    status: "skipped",
    model: null,
    durationMs: 0,
    candidateCount: 4,
    acceptedCount: 3,
    rejectedCount: 1,
    warning: null,
  },
  fieldCoverage: {
    status: "complete",
    rawEmptyCandidateCount: 4,
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

assert.equal(fields.length, 4, "추천 입력 3건과 HWP 객관식 1건만 반영해야 한다");
assert.deepEqual(fields.map((item) => item.fieldKey), [
  "company_name",
  "company_name-2",
  "홍보물_제작기업_기업명",
  "신청_분야",
]);

const company = fields[0]!;
assert.equal(company.mappedCompanyField, "name");
assert.equal(company.fillStrategy, "copy");
assert.equal(company.required, true);
assert.equal(company.documentCategory, "application_form");
assert.equal(company.documentName, "지원신청서.hwp");

const vendor = fields[2]!;
assert.equal(vendor.mappedCompanyField, null, "외주·수행기관 기업명은 신청 기업명으로 자동 채우면 안 된다");
assert.equal(vendor.fillStrategy, "ask_user");

const choice = fields[3]!;
assert.equal(choice.fieldType, "checkbox");
assert.equal(choice.fillStrategy, "ask_user");
assert.equal(choice.sourceSpan, "□ 홍보 브로슈어 □ 홍보 동영상");
assert.equal((choice.visualEvidence as { source?: string })?.source, "kordoc-rhwp-form-control");

assert.equal(fields.some((item) => item.label === "접수번호"), false);

console.log("application field analysis tests: ok");

function field(input: {
  id: string;
  label: string;
  required?: boolean;
  recommendedInput?: boolean;
  row?: number;
}): RoundtripFieldCandidate {
  return {
    fieldInstanceId: input.id,
    label: input.label,
    displayLabel: input.label,
    normalizedLabel: input.label.replaceAll(" ", ""),
    originalValue: "",
    type: "text",
    required: input.required ?? false,
    empty: true,
    recommendedInput: input.recommendedInput ?? true,
    inputLikelihood: 0.9,
    inputSignals: ["테스트"],
    sampleValue: "샘플",
    sampleReason: "테스트",
    source: "kordoc-form",
    inputKind: "text",
    writeOperation: "kordoc_field",
    helperText: null,
    unit: null,
    options: [],
    analysisSource: "heuristic",
    llmConfidence: null,
    location: {
      blockIndex: 1,
      row: input.row ?? 1,
      col: 1,
      occurrence: input.row ?? 1,
      pageNumber: 1,
    },
  };
}
