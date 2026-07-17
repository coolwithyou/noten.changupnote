// 공모 딥분석 실험실(dev 전용) — 서버(lib/server/analysis-lab)와 UI(features/dev/analysis-lab)가
// 공유하는 단일 계약. 프로덕션 코드와 격리된 스파이크 트랙이며, DB에는 어떤 쓰기도 하지 않는다.
// 런 결과는 spike-out/analysis-lab/ 에 불변 JSON으로 저장된다.
import type { CriterionDimension } from "@cunote/contracts";

// v2: 구조화 필드 렌더를 인용 친화("라벨: 값")로 변경 + 인용 지침 강화 — v1 런과 입력 형식이 다르다.
export const ANALYSIS_LAB_PROMPT_VERSION = "lab-deep-v2";
export const ANALYSIS_LAB_DEFAULT_MODEL = "claude-opus-4-8";

export interface LabAttachment {
  filename: string;
  markdownAvailable: boolean;
  markdownBytes: number | null;
  conversionStatus: string | null;
}

export interface LabRunSummary {
  runId: string;
  startedAt: string;
  model: string;
  promptVersion: string;
  durationMs: number;
  costUsd: number | null;
  ok: boolean;
  error: string | null;
}

export interface LabNoticeSummary {
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  agency: string | null;
  applyStart: string | null;
  applyEnd: string | null;
  status: string;
  url: string | null;
  attachments: LabAttachment[];
  currentCriteriaCount: number;
  runs: LabRunSummary[];
}

export interface LabInputBlock {
  label: string;
  chars: number;
  truncated: boolean;
}

export type LabCriterionKind = "required" | "preferred" | "exclusion";

/** 딥분석(B)이 제안한 criterion. spanVerified 는 근거 인용이 입력 원문에 실재하는지의 서버 검증 결과. */
export interface LabCriterion {
  dimension: CriterionDimension;
  kind: LabCriterionKind;
  operator: string;
  value: unknown;
  confidence: number;
  sourceSpan: string | null;
  spanVerified: boolean;
  note: string | null;
}

/** 현재 프로덕션 DB(grant_criteria)에 있는 criterion 스냅샷(A). */
export interface LabCurrentCriterion {
  dimension: CriterionDimension;
  kind: string;
  operator: string;
  value: unknown;
  confidence: number | null;
  needsReview: boolean | null;
  sourceSpan: string | null;
}

export type LabAxisStatus =
  | "condition_found"
  | "inspected_no_condition"
  | "ambiguous"
  | "input_missing";

/** 축별 검사 완전성 보고 — 22축 전수. */
export interface LabAxisAssessment {
  dimension: CriterionDimension;
  status: LabAxisStatus;
  confidence: number;
  comment: string | null;
}

/** 공모의 정성적 방향성 — hard 판정이 아니라 랭킹·조언 계층의 자산. */
export interface LabProgramIntent {
  oneLiner: string;
  targetProfile: string;
  evaluationFocus: string[];
  benefitSummary: string;
  cautionNotes: string[];
}

/** 22축에 담기지 않는 반복 요건의 신규 축 제안(수집만; 승격은 반복 실측 후). */
export interface LabTaxonomyProposal {
  proposedDimension: string;
  rationale: string;
  exampleSpan: string;
}

export type LabDimensionVerdict = "new" | "changed" | "same" | "only_current" | "none";

/** 축 단위 A/B 비교 — 서버가 계산해 내려준다. */
export interface LabDimensionDiff {
  dimension: CriterionDimension;
  label: string;
  current: LabCurrentCriterion[];
  proposed: LabCriterion[];
  assessment: LabAxisAssessment | null;
  verdict: LabDimensionVerdict;
}

export interface LabUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
}

export interface LabRun {
  runId: string;
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  model: string;
  promptVersion: string;
  startedAt: string;
  durationMs: number;
  inputBlocks: LabInputBlock[];
  inputTotalChars: number;
  inputSha256: string;
  usage: LabUsage | null;
  costUsd: number | null;
  /** 사람이 읽는 한국어 분석 문서(마크다운). */
  analysisMarkdown: string;
  programIntent: LabProgramIntent | null;
  criteria: LabCriterion[];
  axisAssessments: LabAxisAssessment[];
  taxonomyProposals: LabTaxonomyProposal[];
  dimensionDiffs: LabDimensionDiff[];
  error: string | null;
}

// ---- API 계약 (모든 라우트는 dev 전용: production 이면 404) ----
// GET  /api/dev/analysis-lab/cohort           → LabCohortResponse (?refresh=1 로 코호트 재선정)
// POST /api/dev/analysis-lab/analyze          → LabAnalyzeResponse (본문: LabAnalyzeRequest, 동기 수 분 소요)
// GET  /api/dev/analysis-lab/run?grantId=&runId= → LabRunResponse

export interface LabCohortResponse {
  model: string;
  promptVersion: string;
  notices: LabNoticeSummary[];
}

export interface LabAnalyzeRequest {
  grantId: string;
}

export interface LabAnalyzeResponse {
  run: LabRun;
}

export interface LabRunResponse {
  run: LabRun;
}
