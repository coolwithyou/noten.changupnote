// 공모 딥분석 실험실(dev 전용) — 서버(lib/server/analysis-lab)와 UI(features/dev/analysis-lab)가
// 공유하는 단일 계약. 프로덕션 코드와 격리된 스파이크 트랙이며, DB에는 어떤 쓰기도 하지 않는다.
// 런 결과는 spike-out/analysis-lab/ 에 불변 JSON으로 저장된다.
import type { CriterionDimension, GrantBenefitFamily } from "@cunote/contracts";

// v2: 구조화 필드 렌더를 인용 친화("라벨: 값")로 변경 + 인용 지침 강화 — v1 런과 입력 형식이 다르다.
// v3: 자가신고 확인 질문(confirmation) 생성 추가 — 판정 불가 결격에 sourceSpan 앵커 객관식 질문을 사전 생성한다.
export const ANALYSIS_LAB_PROMPT_VERSION = "lab-deep-v3";
export const ANALYSIS_LAB_DEFAULT_MODEL = "claude-opus-4-8";

/**
 * 통과 기준 6종 — 2026-07-17 실험 설계 수치의 확정본 + 파일럿 집계 후 승격된 구조화 게이트.
 * 집계 CLI(aggregate.ts)의 판정과 검수 UI(ReviewSheet)의 안내가 이 상수를 공유한다.
 * 근거: 정밀도는 사람 검수 기준으로 오추출이 드물어야 하고(wrong 은 특히 치명),
 * 재현율은 "공고당 놓친 hard 요건" 수준이 검수 비용을 좌우하며,
 * 커버리지는 현행 파이프라인 대비 개선 배수(1.5x)가 딥분석 도입의 최소 명분이다.
 * 구조화 비율은 실험의 존재 이유(기계판정 가능률 병목 해소)를 직접 재는 게이트 —
 * 승격 결정·기준치 근거는 docs/research/2026-07-21-공모딥분석-검수집계-판정.md §6
 * (파일럿 실측 63.0%, 소표본·얇은 공고 유입을 감안한 보수 기준 50%).
 */
export const ANALYSIS_LAB_GATES = {
  strictPrecisionMin: 0.8, // correct / 판정된 criterion
  wrongRateMax: 0.1, // wrong / 판정된 criterion
  missedPerNoticeMax: 1.0, // 공고당 평균 누락(missed_condition) 건수
  coverageRatioMin: 1.5, // 사람 확정(correct) B criteria / 현행 A criteria
  costPerNoticeMaxUsd: 1.0,
  structuredRatioMin: 0.5, // 정확 확정 B 중 구조화(operator≠text_only) 비율 — 확대 실험부터
} as const;

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
  /** 검수 시트(<runId>.review.json)가 있으면 마지막 저장 시각, 없으면 null. */
  reviewedAt: string | null;
  /**
   * AI 검수 감사 상태(§9) — 채택 모델(AI_REVIEW_ADOPTED.model)의 ai-review 파일이 있고
   * 사람 review.json 이 없는 런만 non-null. 감사 파일 미생성이면 decided/total null(감사 대기).
   */
  auditStatus: LabRunAuditSummary | null;
}

/**
 * 공고 혜택 배지 — 제품 공용 taxonomy(deriveGrantBenefits, 7 family)를 그대로 소비한다.
 * label 은 서버가 확정한 한국어 라벨(archive 와 동일 어휘).
 */
export interface LabBenefitBadge {
  family: GrantBenefitFamily;
  label: string;
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
  /** 이 공고에서 받을 수 있는 혜택 — 카드에서 공고 성격을 한눈에 파악하는 용도. */
  benefits: LabBenefitBadge[];
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

export type LabConfirmationReusable = "company_fact" | "per_notice";

export interface LabConfirmationOption {
  value: string; // 영문 snake_case 슬러그
  label: string; // 한국어 표시 문구
  disqualifies: boolean; // 이 선택지가 결격에 해당하는가
}

/**
 * 자가신고 확인 질문 — kind=exclusion 중 소싱 데이터로 판정 불가한 항목에 한해
 * 딥분석이 사전 생성한다(v3). 확인 시점 재생성 없이 이 캐시를 쓴다.
 * 근거: docs/research/2026-07-23-미판정-결격-사용자확인-루프-검토.md §4.1.
 */
export interface LabCriterionConfirmation {
  prompt: string;
  options: LabConfirmationOption[]; // 2~4개, disqualifies true/false 각 1개 이상
  answerType: "single" | "multi";
  reusable: LabConfirmationReusable;
  /** reusable=company_fact 일 때만 — 공고 간 동일 항목 식별 키. LLM 판단(사전 거버넌스 없음 — 2026-07-23 결정). */
  conditionKey: string | null;
}

/** 딥분석(B)이 제안한 criterion. spanVerified 는 근거 인용이 입력 원문에 실재하는지의 서버 검증 결과. */
export interface LabCriterion {
  dimension: CriterionDimension;
  kind: LabCriterionKind;
  operator: string;
  value: unknown;
  confidence: number;
  sourceSpan: string | null;
  spanVerified: boolean;
  /**
   * 근거 인용이 검증된 위치의 입력 내 비율(0~1) — 서버 span 검증 시점에 부수 기록한다.
   * 장문 recall 저하(lost-in-the-middle) 위치 진단 전용(aggregate.ts 위치 진단 블록)이며
   * 게이트 판정에는 쓰지 않는다. 미검증(spanVerified=false)이면 null.
   * 구 런(파일럿)에는 필드 자체가 없다(미계측 — 하위 호환 optional).
   */
  spanOffsetRatio?: number | null;
  note: string | null;
  /** 자가신고 확인 질문(결격 전용, v3) — v2 이하 런에는 필드 없음(하위 호환 optional). */
  confirmation?: LabCriterionConfirmation | null;
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

// ---- 검수 시트 — 사람 검수(창업자)로 딥분석 결과를 확정한다 ----
// 런은 불변이므로 criterionIndex(LabRun.criteria 배열 인덱스)가 안정 키다.
// 검수 파일은 런 파일 옆 <runId>.review.json 에 저장(사람 산출물이라 덮어쓰기 허용).
// 이 검수 결과가 공고 criterion 골든셋의 1차 원천이 된다 — AI 라벨의 golden 승격은
// 반드시 이 사람 검수를 거친다(Gate 1 순환성 가드와 동일 원칙). DB 승격은 별도 트랙.

export type LabCriterionVerdict = "correct" | "needs_edit" | "wrong" | "unsure";

/** 딥분석 제안 criterion 1건에 대한 판정. */
export interface LabCriterionReview {
  criterionIndex: number;
  verdict: LabCriterionVerdict;
  /** needs_edit/wrong/unsure 의 사유·수정 내용. */
  note: string | null;
}

export type LabEmptyAxisVerdict = "confirmed_absent" | "missed_condition";

/** 제안이 없는 축에 대한 확인 — 재현율(누락) 골든 신호. */
export interface LabAxisReview {
  dimension: CriterionDimension;
  verdict: LabEmptyAxisVerdict;
  /** missed_condition 이면 누락된 요건을 원문 기준으로 서술. */
  note: string | null;
}

export interface LabReview {
  grantId: string;
  runId: string;
  /** 사람 검수자 이메일 — AI 라벨러 식별자는 서버가 거부한다. */
  reviewerEmail: string;
  createdAt: string;
  updatedAt: string;
  /**
   * 검수 시트를 처음 연 시각 — 공고당 실검수 시간 측정용(확대 실험 운영 지표).
   * 파일럿 검수 파일에는 없다(하위 호환 optional). 최초 저장의 값을 보존한다.
   */
  startedAt?: string | null;
  criterionReviews: LabCriterionReview[];
  axisReviews: LabAxisReview[];
  overallNote: string | null;
}

export interface LabReviewUpsertRequest {
  grantId: string;
  runId: string;
  reviewerEmail: string;
  /** 검수 시트 최초 오픈 시각(ISO) — 클라이언트가 계측해 보낸다. 없으면 미계측. */
  startedAt?: string | null;
  criterionReviews: LabCriterionReview[];
  axisReviews: LabAxisReview[];
  overallNote: string | null;
}

export interface LabReviewResponse {
  review: LabReview | null;
}

// ---- AI 검수 감사(audit) — §9 "AI 전수 + 사람 표본 감사"의 사람 감사 기록 ----
// 확대 실험 계획(2026-07-21) §9 프로토콜 개정: 검수 주체를 "사람 전수"에서 "AI 전수 +
// 사람 표본 감사"로 바꿨다. 감사 파일은 런 파일 옆 <runId>.audit.<modelSlug>.json
// (audit-store 소관). 대상 목록은 최초 생성 시 selectAuditTargets(시드·비율은
// ai-review-compare 의 AUDIT_SEED/AUDIT_SAMPLE_RATIO — CLI --audit-list 와 동일)로
// **동결**되고, 이후 저장은 humanVerdict/note 만 갱신한다. 완료된 감사는 AI 검수와
// 병합돼(audited-reviews) 게이트 표본의 새 원천이 된다. 사람 review.json 보유 공고에는
// 감사 파일을 만들지 않는다(사람 전수 검수가 항상 우선 — 순환성 가드 §9 유지 조항).

/**
 * §9 검수 자동화 채택 기록 — 계획 문서 "§9 캘리브레이션 결과 기록"(2026-07-23)의 단일 정의.
 * 판정 모델 claude-fable-5 · 판정 프롬프트 ai-review-v2 가 사전 등록 채택 기준 3종을 충족:
 * criterion 일치 24/28 · correct→wrong 오검출 0 · 빈 축 일치 45/46 (개정 카드 1회 소진).
 * 집계 방법론 표기(aggregate)·감사 로더(audited-reviews)·감사 UI 가 이 상수를 공유한다 —
 * 수치·모델을 다른 곳에 하드코딩하지 말 것.
 * promptVersion 은 생성기 상수(ai-review.ts AI_REVIEW_PROMPT_VERSION)와 같아야 한다 —
 * §9 상 재개정 불가이므로 다르면 프로토콜 위반 신호다(로더가 불일치 시 경고 출력).
 */
export const AI_REVIEW_ADOPTED = {
  model: "claude-fable-5",
  promptVersion: "ai-review-v2",
  calibration: {
    criterionAgreement: "24/28",
    correctToWrong: 0,
    emptyAxisAgreement: "45/46",
  },
} as const;

/** 감사 대상 선정 사유 — selectAuditTargets(§9 감사 설계)의 세 갈래와 1:1. */
export type LabAuditReason = "ai_non_correct" | "missed_condition_flag" | "correct_sample";

/** 감사 대상 1건 — AI 판정 스냅샷 + 사람 감사 판정. */
export interface LabAuditItem {
  /** 대상 종류 — 제안 criterion 판정 감사 또는 빈 축 판정 감사. */
  kind: "criterion" | "axis";
  /** kind=criterion 이면 LabRun.criteria 배열 인덱스(런 불변 — 안정 키). */
  criterionIndex?: number;
  /** kind=axis 이면 축. */
  dimension?: CriterionDimension;
  reason: LabAuditReason;
  /** AI 판정 스냅샷 — criterion 이면 LabCriterionVerdict, 축이면 LabEmptyAxisVerdict 어휘. */
  aiVerdict: string;
  aiNote: string | null;
  /** 사람 감사 판정 — null 이면 미판정. 동의면 aiVerdict 와 같은 값이 저장된다. */
  humanVerdict: LabCriterionVerdict | LabEmptyAxisVerdict | null;
  /** 감사 사유 — AI 판정 뒤집기(humanVerdict ≠ aiVerdict) 시 필수(서버 검증). */
  note: string | null;
  /**
   * AI 블라인드 감사(2차 독립 판정) — lab:ai-audit 러너가 기록한다(§9 완화 개정, 2026-07-23
   * 사용자 승인). 기존 AI 검수의 aiVerdict/aiNote 를 프롬프트에 노출하지 않고 같은 입력
   * (공고 원문+추출 criteria+가이드 rubric)으로 재판정한 결과. aiVerdict 와 정확 일치하면
   * (unsure 제외 — isAiAuditConcur) 사람 판정 없이 완료로 간주된다(isLabAuditComplete).
   * 기존 27개 감사 파일에는 없다(하위 호환 optional — 미기록과 null 은 동치).
   */
  aiAuditVerdict?: LabCriterionVerdict | LabEmptyAxisVerdict | null;
  /** AI 블라인드 감사 판정 사유 — 비-correct/missed_condition 판정이면 기록된다. */
  aiAuditNote?: string | null;
}

/**
 * AI 블라인드 감사 일치(concur) 판정 — 단일 원천. 감사 판정이 기록돼 있고 기존 AI 검수
 * 판정과 **정확히 같으며 unsure 가 아닐 때만** 일치다. unsure 는 두 모델 모두 판단 불가라는
 * 뜻이라 자동 확정하지 않고 사람 큐에 남긴다(순환성 가드의 보수 조항 — §9 완화 개정에서도
 * 유지). 일치 항목은 사람 판정 없이 감사 완료로 간주된다(audit-store isLabAuditComplete ·
 * run-store 감사 배지 · AuditSheet 배지가 이 함수를 공유한다).
 */
export function isAiAuditConcur(item: {
  aiVerdict: string;
  aiAuditVerdict?: string | null | undefined;
}): boolean {
  return (
    item.aiAuditVerdict !== null &&
    item.aiAuditVerdict !== undefined &&
    item.aiAuditVerdict === item.aiVerdict &&
    item.aiAuditVerdict !== "unsure"
  );
}

export interface LabAudit {
  schema: "lab-audit-v1";
  grantId: string;
  runId: string;
  /** 감사 대상 AI 검수의 판정 모델(provenance) — 파일 키의 일부. */
  model: string;
  aiPromptVersion: string;
  /** 사람 감사자 이메일 — 최초 생성 직후(판정 저장 전)는 null. 저장 시 사람 이메일 강제(validateReviewerEmail). */
  auditorEmail: string | null;
  createdAt: string;
  updatedAt: string;
  /** 감사 대상 항목 — 생성 시 동결. 이후 저장은 humanVerdict/note 만 갱신한다. */
  items: LabAuditItem[];
  overallNote: string | null;
  /**
   * AI 블라인드 감사 메타 — lab:ai-audit 러너가 마지막 실행 시 기록한다(provenance).
   * 구 감사 파일에는 없다(하위 호환 optional). 스키마 id 는 additive 변경이라 lab-audit-v1 유지.
   */
  aiAuditModel?: string | null;
  aiAuditPromptVersion?: string | null;
  aiAuditedAt?: string | null;
}

/** PUT 본문의 항목 판정 — 판정한 항목만 보낸다(부분 저장). 서버는 저장본 대상 목록에 병합만 한다. */
export interface LabAuditItemJudgment {
  kind: "criterion" | "axis";
  criterionIndex?: number;
  dimension?: CriterionDimension;
  humanVerdict: LabCriterionVerdict | LabEmptyAxisVerdict;
  note: string | null;
}

export interface LabAuditUpsertRequest {
  grantId: string;
  runId: string;
  /** AI 검수 모델 — 감사 파일 키(<runId>.audit.<modelSlug>.json)의 일부. */
  model: string;
  auditorEmail: string;
  items: LabAuditItemJudgment[];
  overallNote: string | null;
}

export interface LabAuditResponse {
  audit: LabAudit;
  /** 표시용 조인 — items 와 같은 순서. criterion 항목이면 런의 제안 원본, 축 항목이면 null. */
  itemCriteria: Array<LabCriterion | null>;
}

/** 런 요약의 감사 상태 — 감사 파일이 아직 없으면 decided/total 이 null("감사 대기"). */
export interface LabRunAuditSummary {
  model: string;
  decidedItems: number | null;
  totalItems: number | null;
}

// ---- API 계약 (모든 라우트는 dev 전용: production 이면 404) ----
// GET  /api/dev/analysis-lab/cohort           → LabCohortResponse (?refresh=1 로 코호트 재선정)
// POST /api/dev/analysis-lab/analyze          → LabAnalyzeResponse (본문: LabAnalyzeRequest, 동기 수 분 소요)
// GET  /api/dev/analysis-lab/run?grantId=&runId= → LabRunResponse
// GET  /api/dev/analysis-lab/review?grantId=&runId= → LabReviewResponse (없으면 review:null)
// PUT  /api/dev/analysis-lab/review           → 본문 LabReviewUpsertRequest → LabReviewResponse
// GET  /api/dev/analysis-lab/audit?grantId=&runId=&model= → LabAuditResponse (감사 파일 없으면 생성 — §9)
// PUT  /api/dev/analysis-lab/audit            → 본문 LabAuditUpsertRequest → LabAuditResponse

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
