// Kordoc 지원서 왕복 실험실(dev 전용) 공유 계약.
// 운영 DB/R2는 읽기만 하고, 분석·채움 산출물은 spike-out 아래에만 저장한다.

export const APPLICATION_ROUNDTRIP_VERSION = "kordoc-application-roundtrip-v3";

export type RoundtripDocumentFormat = "hwp" | "hwpx";
export type RoundtripDocumentRole =
  | "application_form"
  | "business_plan"
  | "mixed_form"
  | "announcement"
  | "evidence"
  | "unknown";

export interface RoundtripCohortAttachment {
  filename: string;
  declaredFormat: RoundtripDocumentFormat;
  bytes: number | null;
  roleHint: RoundtripDocumentRole;
  roleHintScore: number;
  likelyApplicationDocument: boolean;
}

export interface RoundtripCohortNotice {
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  agency: string | null;
  applyEnd: string | null;
  url: string | null;
  attachments: RoundtripCohortAttachment[];
  likelyApplicationDocumentCount: number;
}

export interface RoundtripCohortResponse {
  engine: "kordoc";
  engineVersion: string;
  generatedAt: string;
  notices: RoundtripCohortNotice[];
}

export interface RoundtripFieldLocation {
  blockIndex: number;
  row: number;
  col: number;
  occurrence: number;
  pageNumber: number | null;
  target?: RoundtripEditableTarget;
}

export interface RoundtripEditableTarget {
  kind: "table_cell" | "block_text";
  row: number | null;
  col: number | null;
  textStart: number;
  textEnd: number;
  expectedText: string;
  expectedSha256: string;
}

export type RoundtripFieldType =
  | "text"
  | "date"
  | "phone"
  | "email"
  | "amount"
  | "checkbox"
  | "idnum";

export type RoundtripFieldSource = "kordoc-form" | "contextual-region";
export type RoundtripFieldInputKind =
  | "text"
  | "textarea"
  | "number"
  | "single_choice"
  | "multiple_choice";
export type RoundtripFieldWriteOperation =
  | "kordoc_field"
  | "replace_span"
  | "insert_before_unit"
  | "toggle_text_choice"
  | "replace_instruction";

export interface RoundtripFieldOption {
  optionId: string;
  label: string;
  selected: boolean;
  /** 선택 시 원문에 기록할 값. 일반 텍스트 체크박스는 마커 토글로 계산한다. */
  writeValue?: string;
}

export interface RoundtripFieldCandidate {
  fieldInstanceId: string;
  label: string;
  displayLabel: string;
  normalizedLabel: string;
  originalValue: string;
  type: RoundtripFieldType;
  required: boolean;
  empty: boolean;
  recommendedInput: boolean;
  inputLikelihood: number;
  inputSignals: string[];
  sampleValue: string;
  sampleReason: string;
  source: RoundtripFieldSource;
  inputKind: RoundtripFieldInputKind;
  writeOperation: RoundtripFieldWriteOperation;
  helperText: string | null;
  unit: string | null;
  options: RoundtripFieldOption[];
  analysisSource: "heuristic" | "llm";
  llmConfidence: number | null;
  location: RoundtripFieldLocation;
}

export interface RoundtripFieldPlanningSummary {
  status: "llm" | "heuristic_fallback" | "skipped";
  model: string | null;
  durationMs: number;
  candidateCount: number;
  acceptedCount: number;
  rejectedCount: number;
  warning: string | null;
}

export type RoundtripChoiceSelectionMode = "single" | "multiple";
export type RoundtripChoiceSource = "hwp-form-control";

export interface RoundtripChoiceOption {
  optionId: string;
  label: string;
  selected: boolean;
}

export interface RoundtripChoiceGroup {
  groupId: string;
  label: string;
  normalizedLabel: string;
  selectionMode: RoundtripChoiceSelectionMode;
  source: RoundtripChoiceSource;
  options: RoundtripChoiceOption[];
  location: {
    sectionIndex: number;
    tableIndex: number;
    row: number;
    col: number;
    pageNumber: null;
  };
}

export interface RoundtripRoleScores {
  applicationForm: number;
  businessPlan: number;
  announcement: number;
  evidence: number;
}

export interface RoundtripParsedDocument {
  attachmentId: string;
  filename: string;
  declaredFormat: RoundtripDocumentFormat;
  detectedFormat: string | null;
  sourceSha256: string | null;
  byteLength: number | null;
  parseDurationMs: number;
  parsedChars: number;
  blockCount: number;
  tableCount: number;
  formConfidence: number;
  role: RoundtripDocumentRole;
  roleConfidence: number;
  roleScores: RoundtripRoleScores;
  roleSignals: string[];
  fields: RoundtripFieldCandidate[];
  choiceGroups: RoundtripChoiceGroup[];
  emptyFieldCount: number;
  recommendedInputFieldCount: number;
  recommendedChoiceGroupCount: number;
  fieldPlanning: RoundtripFieldPlanningSummary;
  markdownPreview: string;
  warnings: string[];
  error: string | null;
}

export interface ApplicationRoundtripRun {
  version: typeof APPLICATION_ROUNDTRIP_VERSION;
  runId: string;
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  engine: "kordoc";
  engineVersion: string;
  startedAt: string;
  durationMs: number;
  documents: RoundtripParsedDocument[];
  recommendedAttachmentId: string | null;
  recommendationReason: string;
  error: string | null;
}

export interface RoundtripAnalyzeResponse {
  run: ApplicationRoundtripRun;
}

export interface RoundtripFieldVerification {
  fieldInstanceId: string;
  label: string;
  occurrence: number;
  expectedValue: string;
  actualValue: string | null;
  status: "matched" | "mismatch" | "missing_after_fill";
}

export interface RoundtripChoiceVerification {
  groupId: string;
  label: string;
  expectedOptionIds: string[];
  actualOptionIds: string[] | null;
  status: "matched" | "mismatch" | "missing_after_fill";
}

export interface RoundtripFillResult {
  fillId: string;
  runId: string;
  grantId: string;
  attachmentId: string;
  sourceFilename: string;
  outputFilename: string;
  outputFormat: RoundtripDocumentFormat;
  fillMode:
    | "hwpx-preserve"
    | "hwpx-markdown-patch"
    | "hwp-binary-patch"
    | "hwp-form-controls"
    | "hwp-binary-patch+form-controls";
  createdAt: string;
  durationMs: number;
  requestedFieldCount: number;
  kordocFilledCount: number;
  verifiedFieldCount: number;
  requestedChoiceGroupCount: number;
  formControlPatchedCount: number;
  verifiedChoiceGroupCount: number;
  hwpIntegrity: {
    repairedLineSegmentParagraphs: number;
    validatedParagraphs: number;
    baselineIssueCount: number;
    finalIssueCount: number;
  } | null;
  allVerified: boolean;
  unmatchedLabels: string[];
  patchApplied: number | null;
  patchSkipped: Array<{ reason: string; before?: string; after?: string; partial?: boolean }>;
  documentDiff: {
    added: number;
    removed: number;
    modified: number;
    unchanged: number;
  };
  fieldVerifications: RoundtripFieldVerification[];
  choiceVerifications: RoundtripChoiceVerification[];
  warnings: string[];
  downloadUrl: string;
}

export interface RoundtripFillResponse {
  fill: RoundtripFillResult;
}
