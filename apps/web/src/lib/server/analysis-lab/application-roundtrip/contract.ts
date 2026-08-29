// Kordoc 지원서 왕복 분석의 서버 도메인 계약.
// 운영 DB/R2는 읽기만 하고, 분석·채움 산출물은 spike-out 아래에만 저장한다.

/** v9: 표 밖 단일 문단 입력의 exact prefix/value/suffix 계약을 함께 봉인한다. */
export const APPLICATION_ROUNDTRIP_VERSION = "kordoc-application-roundtrip-v9";
/** 관리자 로컬 preview에서만 현재 원본 SHA와 다시 대조해 읽을 수 있는 역사 계약. */
export const LOCAL_PREVIEW_COMPATIBLE_ROUNDTRIP_VERSIONS = new Set([
  "kordoc-application-roundtrip-v7",
]);

/**
 * 로컬 구독 Kordoc 필드 판정의 채택 모델.
 * 사람 검수 대신 가장 높은 품질의 구독 모델 결과를 release 근거로 쓸 때 이 값과
 * claude-cli provenance가 함께 봉인되어야 한다.
 */
export const APPLICATION_ROUNDTRIP_ADOPTED_MODEL = "claude-opus-5";

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
  kind: "table_cell" | "block_text" | "paragraph_text";
  row: number | null;
  col: number | null;
  textStart: number;
  textEnd: number;
  expectedText: string;
  expectedSha256: string;
  /** paragraph_text만 사용한다. 값이 바뀌어도 고정 prefix/suffix로 native 문단을 재결속한다. */
  paragraphPrefix?: string;
  paragraphSuffix?: string;
  paragraphOccurrence?: number;
}

export type RoundtripFieldType =
  | "text"
  | "date"
  | "phone"
  | "email"
  | "amount"
  | "checkbox"
  | "idnum";

export type RoundtripFieldSource = "kordoc-form" | "contextual-region" | "rhwp-structural";
export type RoundtripLlmTransport = "api" | "claude-cli";
export type RoundtripFailureCode =
  | "api_key_missing"
  | "transport_not_configured"
  | "request_timeout"
  | "window_exhausted"
  | "http_error"
  | "invalid_response"
  | "request_failed"
  | "document_limit_exceeded"
  | "document_analysis_failed"
  | "all_documents_failed";
export type RoundtripFieldInputKind =
  | "text"
  | "textarea"
  | "number"
  | "single_choice"
  | "multiple_choice";
export type RoundtripFieldWriteOperation =
  | "kordoc_field"
  | "rhwp_field"
  | "replace_span"
  | "insert_after_label"
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
  /** 0은 최초 판정, 1 이상은 미해결 후보 자동 재판정 횟수다. */
  llmDecisionRound?: number;
  /** 낮은 확신을 확정 거절로 오인하지 않기 위한 최종 모델 판정 상태다. */
  llmDecision?: "input" | "not_input" | "uncertain";
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
  /** 신규 런 provenance. 기존 저장 파일과 테스트 픽스처 호환을 위해 additive optional이다. */
  transport?: RoundtripLlmTransport;
  requestedModel?: string;
  timeoutMs?: number;
  /** null이면 구독 경로에서 전체 후보를 처리했다는 뜻이다. */
  candidateLimit?: number | null;
  /** 한 모델 호출에 넣은 후보 수. 구독 경로는 미판정 자동 재판정을 전제로 더 큰 묶음을 쓴다. */
  candidateBatchSize?: number;
  candidateConcurrency?: number;
  /** 구조 후보 중 실제 LLM 판정이 필요했던 경계 후보 수. 구독 triage provenance다. */
  llmCandidateCount?: number;
  /** 강한 입력/비입력 신호로 모델 없이 종결한 후보 수. */
  deterministicDecisionCount?: number;
  parentLabRunId?: string | null;
  /** round 0(최초 판정)에 명시한 출력 effort. null/부재는 effort 미지정(현행 동작)이다. */
  effort?: "low" | "medium" | "high" | null;
  failureCode?: RoundtripFailureCode | null;
  /** 최초 판정과 자동 재판정을 합친 실제 후보 처리 범위. */
  processedCandidateCount?: number;
  unprocessedCandidateCount?: number;
  adjudicationStatus?: "not_needed" | "resolved" | "partial" | "failed" | "skipped";
  adjudicationRounds?: number;
  adjudicatedCandidateCount?: number;
  remainingUnresolvedCandidateCount?: number;
  adjudicationFailureCode?: RoundtripFailureCode | null;
  /** API/CLI 응답 usage를 합산한 관제용 실제 사용량. 구 산출물 호환을 위해 optional이다. */
  requestCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number | null;
}

export interface RoundtripFieldCoverageIssue {
  fieldInstanceId: string;
  label: string;
  reason: string;
  location: RoundtripFieldLocation;
}

/**
 * Kordoc 후보를 최종 입력 필드로 낮출 때의 누락 검수 결과.
 * partial 은 안전하게 확정한 필드는 쓸 수 있지만 일부 구조가 접혀 원문 직접 확인이 필요함을 뜻한다.
 */
export interface RoundtripFieldCoverageSummary {
  status: "complete" | "partial" | "review_required";
  rawEmptyCandidateCount: number;
  acceptedInputCount: number;
  unresolvedCandidateCount: number;
  structuralWarningCount: number;
  unresolvedCandidates: RoundtripFieldCoverageIssue[];
  structuralWarnings: RoundtripFieldCoverageIssue[];
  /** RHWP 표 구조에서 직접 회수한 고신호 입력 라벨 수. v7 이하는 미보유다. */
  structuralInputLabelCount?: number;
  /** 표시명과 별개인 원문 라벨·구조 위치를 갖춘 최종 입력 필드 수. */
  anchorReadyInputCount?: number;
  /** RHWP exact binding 계약이 불완전해 publishable로 셀 수 없는 입력 필드 수. */
  anchorUnreadyInputCount?: number;
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
  fieldCoverage: RoundtripFieldCoverageSummary;
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
  /** 같은 공고의 딥분석 런과 결속하는 additive provenance. */
  parentLabRunId?: string | null;
  /** 모델 재호출 없이 검증된 기존 불변 산출물을 새 딥분석 런에 재결속한 경우의 직접 원본. */
  reusedFromRunId?: string;
  transport?: RoundtripLlmTransport;
  requestedModel?: string;
  /** Kordoc round 0 판정에 요청한 effort. 구 산출물엔 없으며 null과 동치(미지정)로 해석한다. */
  requestedEffort?: "low" | "medium" | "high" | null;
  timeoutMs?: number;
  candidateLimit?: number | null;
  candidateBatchSize?: number;
  candidateConcurrency?: number;
  failureCode?: RoundtripFailureCode | null;
  startedAt: string;
  durationMs: number;
  /** 중복 제거 뒤 발견한 전체 HWP/HWPX 원본 수. 구런은 documents.length로 해석한다. */
  sourceCount?: number;
  /** 한 실행의 bounded 문서 상한 때문에 다음 실행으로 넘긴 원본 수. */
  skippedDocumentCount?: number;
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
  /** 분석 run 디렉터리 기준 로컬 artifact 경로. 다운로드 HTTP 표면과 결합하지 않는다. */
  artifactPath: string;
}

export interface RoundtripFillResponse {
  fill: RoundtripFillResult;
}
