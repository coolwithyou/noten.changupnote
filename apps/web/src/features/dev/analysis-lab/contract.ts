// 공모 딥분석 실험실(dev 전용) — 서버(lib/server/analysis-lab)와 UI(features/dev/analysis-lab)가
// 공유하는 단일 계약. 프로덕션 코드와 격리된 스파이크 트랙이며, DB에는 어떤 쓰기도 하지 않는다.
// 런 결과는 spike-out/analysis-lab/ 에 불변 JSON으로 저장된다.
import type { NoticePeriodStatus } from "./notice-period";
import type {
  CriterionDimension,
  DeepAnalysisAssessmentStatus,
  DeepAnalysisAxisAssessment,
  DeepAnalysisConfirmationOption,
  DeepAnalysisConfirmationReusable,
  DeepAnalysisCriterion,
  DeepAnalysisCriterionConfirmation,
  DeepAnalysisCriterionKind,
  DeepAnalysisProgramIntent,
  DeepAnalysisTaxonomyProposal,
  DeepAnalysisUsage,
  GrantBenefitFamily,
} from "@cunote/contracts";

// v2: 구조화 필드 렌더를 인용 친화("라벨: 값")로 변경 + 인용 지침 강화 — v1 런과 입력 형식이 다르다.
// v5: 운영 v2와 동일하게 investment 상한을 안전한 text_only로 제한한다.
export const ANALYSIS_LAB_PROMPT_VERSION = "lab-deep-v5";
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
  /**
   * 추론 전송층 provenance — LabRun.transport 를 그대로 통과시킨다(run-store toRunSummary).
   * transport 기록 이전의 구런 파일에는 없다(하위 호환 optional — undefined 는 api 로 해석).
   */
  transport?: "api" | "claude-cli";
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

export type LabCriterionKind = DeepAnalysisCriterionKind;

export type LabConfirmationReusable = DeepAnalysisConfirmationReusable;

export type LabConfirmationOption = DeepAnalysisConfirmationOption;

/**
 * 자가신고 확인 질문 — kind=exclusion 중 소싱 데이터로 판정 불가한 항목에 한해
 * 딥분석이 사전 생성한다(v3). 확인 시점 재생성 없이 이 캐시를 쓴다.
 * 근거: docs/research/2026-07-23-미판정-결격-사용자확인-루프-검토.md §4.1.
 */
export type LabCriterionConfirmation = DeepAnalysisCriterionConfirmation;

/** 딥분석(B)이 제안한 criterion. spanVerified 는 근거 인용이 입력 원문에 실재하는지의 서버 검증 결과. */
export type LabCriterion = DeepAnalysisCriterion;

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

export type LabAxisStatus = DeepAnalysisAssessmentStatus;

/** 축별 검사 완전성 보고 — 22축 전수. */
export type LabAxisAssessment = DeepAnalysisAxisAssessment;

/** 공모의 정성적 방향성 — hard 판정이 아니라 랭킹·조언 계층의 자산. */
export type LabProgramIntent = DeepAnalysisProgramIntent;

/** 22축에 담기지 않는 반복 요건의 신규 축 제안(수집만; 승격은 반복 실측 후). */
export type LabTaxonomyProposal = DeepAnalysisTaxonomyProposal;

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

export type LabUsage = DeepAnalysisUsage;

/**
 * 같은 공고 딥 분석 시점에 병렬 선계산한 Kordoc 지원 양식 결과 참조.
 * 실제 문서별 후보와 좌표는 불변 application-roundtrip artifact가 소유하고,
 * LabRun에는 두 실행의 결속과 빠른 작성 준비 상태만 남긴다.
 */
export interface LabApplicationRoundtripReference {
  status: "complete" | "partial" | "review_required" | "not_applicable" | "failed";
  runId: string | null;
  transport: "api" | "claude-cli";
  model: string;
  documentCount: number;
  sourceCount: number;
  errorCode: string | null;
  error: string | null;
}

export interface LabRun {
  runId: string;
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  model: string;
  /**
   * 추론 전송층 provenance — "claude-cli" 는 Max 구독(claude CLI) 경유 실행(계획 §2 원칙 4).
   * 기존 런 파일에는 없다(하위 호환 optional — undefined 는 api 로 해석한다).
   */
  transport?: "api" | "claude-cli";
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
  /** 구런과 Kordoc 미실행 런에는 없다. */
  applicationRoundtrip?: LabApplicationRoundtripReference;
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
  /** 사람 판정의 최종 작성자. 구 파일에는 없는 additive provenance. */
  decidedBy?: string | null;
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
  /**
   * AI 블라인드 감사의 추론 전송층 provenance — "claude-cli" 는 Max 구독(claude CLI) 경유.
   * 기존 감사 파일에는 없다(하위 호환 optional — undefined 는 api 로 해석한다).
   */
  aiAuditTransport?: "api" | "claude-cli";
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

// ---- 배치 운영 대시보드(ops) — 깔때기·transport 현황 (2026-08-03 계획 §3-4) ----
// GET /api/dev/analysis-lab/ops/summary → LabOpsSummary (?refresh=1 로 파일 스캔 캐시 무효화).
// 서버 집계는 lib/server/analysis-lab/ops-summary.ts 가 소유한다. 전부 additive 신규 타입.

/**
 * 깔때기 6단계(계획 §2) — 아카이빙 총계 → 모집기간 3분할 → 코호트 → 딥분석 4버킷 →
 * 검수/감사 3분할(무은폐) → 승격. 모든 수치는 집계 시점 스냅샷이다.
 */
export interface LabOpsFunnel {
  /** ① grants servingState='visible' 총계(grantServingVisiblePredicate — 전 소스). */
  archivedVisible: number;
  /** ① 의 LAB_SOURCES(kstartup/bizinfo) 한정 수치 — ② 3분할의 분모. */
  archivedVisibleLabSources: number;
  /** ② 모집기간에 오늘(KST)이 포함(withinApplyPeriod 기준) — LAB_SOURCES·visible 한정. */
  openToday: number;
  /** ② 기간 미상(applyEnd IS NULL) 예외 큐 — LAB_SOURCES·visible 한정. */
  periodUnknown: number;
  /** ② 마감·시작 전(위 두 갈래의 나머지) — LAB_SOURCES·visible 한정. */
  closedOrNotStarted: number;
  /** ③ cohort.json(v2) entries 수 — 파일이 없으면 0. */
  cohortSize: number;
  /** ③ 실험 라벨(cohort.json experimentLabel) — 없으면 null. */
  cohortLabel: string | null;
  /** ③ 코호트 선정 시각(cohort.json selectedAt) — 없으면 null. */
  cohortSelectedAt: string | null;
  /** ④ partitionCohortEntries 4버킷 — 현행 promptVersion ok 런 보유. */
  analysisOkCurrent: number;
  /** ④ 구버전 ok 런"만" 보유(--reanalyze-outdated 대상). */
  analysisOkOutdatedOnly: number;
  /** ④ 현행 버전 error 런만 보유(--retry-errors 대상 보류). */
  analysisErrorHeld: number;
  /** ④ 미분석 잔여(실행 대상). */
  analysisPending: number;
  /** ⑤ 사람 검수(review.json) 확정 공고 수 — 공고당 최신 1건 dedupe 후. */
  humanReviewed: number;
  /** ⑤ 감사 확정(사람 판정 포함 — provenance.auditedCount > 0) 공고 수. */
  auditConfirmed: number;
  /** ⑤ AI 블라인드 감사 일치만으로 자동 확정(사람 판정 0건) 공고 수 — 무은폐 분리 표기. */
  auditAiAutoConfirmed: number;
  /** ⑤ 감사 대기(파일 미생성·미완료) 공고 수. */
  auditPending: number;
  /** ⑥ 승격 반영 공고 수 — promotion items status='applied' AND rolled_back_at IS NULL, DISTINCT grantId. */
  promotedGrants: number;
}

/** 현재 프로세스의 transport 모드 + 코호트 런 파일의 transport 분포. */
export interface LabOpsTransportStatus {
  /** 현 프로세스 resolveLabTransport() 결과. */
  resolved: "api" | "claude-cli";
  /** resolveLabModel() 결과. */
  model: string;
  /** env ANALYSIS_LAB_TRANSPORT 설정 여부(빈 문자열은 unset 취급). */
  envSource: "env" | "unset";
  /** claude --version 출력(가능하면) — 실패·미설치면 null(필수 아님). */
  cliVersion: string | null;
  /** 코호트 런 파일 전수의 transport 분포 — 현행 버전 ok 런 기준(undefined transport 는 api). */
  runsByTransport: { api: number; claudeCli: number };
}

export interface LabOpsSummary {
  funnel: LabOpsFunnel;
  transportStatus: LabOpsTransportStatus;
  generatedAt: string;
  /** true 면 모듈 메모리 캐시(TTL 30s) 응답 — ?refresh=1 로 무효화 가능. */
  cacheHit: boolean;
}

// ---- 배치 잡 (ops/batch 라우트·배치 운영 탭이 공유하는 계약) ----
// 이벤트 union 은 batch-runner(서버)와 UI 가 같은 모양을 봐야 하므로 여기(계약)가 단일 원천이다.

/** 모집기간 정책 위반 상태 — notice-period classifyNoticePeriod 의 "eligible" 밖 3종. */
export type LabBatchPeriodSkipStatus = Exclude<NoticePeriodStatus, "eligible">;

/** plan 이벤트의 기간 정책 스킵 상세 — CLI 로그 라인 재현·UI 상세 표기가 공유한다. */
export interface LabBatchPeriodSkippedEntry {
  grantId: string;
  stratum: string;
  status: LabBatchPeriodSkipStatus;
}

/**
 * 배치 진행 이벤트. target 계열의 index 는 **0 기반**이다(표기 ordinal 은 index+1).
 * 옵셔널 additive 필드(plan 의 runnable/periodSkippedEntries/estimatedCostPerGrantUsd/
 * costSampleCount · target-error 의 title/durationMs)는 러너(batch-runner)가 항상 채워
 * 방출하지만, 이 계약 도입 전 잔상(batch-job.json 구 스냅샷) 호환을 위해 옵셔널로 둔다.
 */
export type LabBatchEvent =
  | {
      type: "plan";
      cohortLabel: string | null;
      total: number;
      skippedOk: number;
      skippedOkOutdatedOnly: number;
      heldError: number;
      periodSkipped: number;
      targets: number;
      /** perGrant × targets. 대상 0건이면 null(추정 표기 없음 — CLI 동작과 동형). */
      estimatedCostUsd: number | null;
      /** 기간 가드 통과 후 잔여(pending − periodSkipped) — limit 적용 전. */
      runnable?: number;
      periodSkippedEntries?: LabBatchPeriodSkippedEntry[];
      /** 공고당 예상 비용 — 현행 버전 ok 런 평균, 표본이 없으면 파일럿 실측 기본값. */
      estimatedCostPerGrantUsd?: number;
      /** 추정 근거가 된 현행 버전 ok 런 표본 수. 0 이면 파일럿 실측 기본값 사용. */
      costSampleCount?: number;
    }
  | { type: "target-started"; index: number; total: number; grantId: string; stratum: string }
  | {
      type: "target-ok";
      index: number;
      total: number;
      grantId: string;
      stratum: string;
      title: string;
      durationMs: number;
      costUsd: number | null;
      cumulativeCostUsd: number;
    }
  | {
      type: "target-error";
      index: number;
      total: number;
      grantId: string;
      stratum: string;
      /** true=error 런으로 저장된 실패, false=런 저장 없이 던져진 실패(공고 미존재 등). */
      runSaved: boolean;
      message: string;
      /** runSaved=true 면 런의 공고 제목, 미저장 실패면 null(additive — 로그 재현용). */
      title?: string | null;
      durationMs?: number;
    }
  | { type: "guard-stop"; reason: "cost-cap" | "window-exhausted"; cumulativeCostUsd: number }
  | { type: "finished"; summary: LabBatchSummary };

export interface LabBatchSummary {
  ok: number;
  errorRuns: number;
  unsavedFailures: number;
  notStarted: number;
  skippedOk: number;
  skippedOkOutdatedOnly: number;
  heldError: number;
  periodSkipped: number;
  totalCostUsd: number;
  durationMs: number;
  stopReason: "completed" | "cost-cap" | "window-exhausted" | "aborted";
}

/** POST ops/batch 본문 — transport/model 미지정 시 서버 env(resolveLabTransport/resolveLabModel)를 따른다. */
export interface LabBatchStartRequest {
  limit: number;
  concurrency: number;
  maxCostUsd: number;
  retryErrors: boolean;
  reanalyzeOutdated: boolean;
  transport?: "api" | "claude-cli";
  model?: string;
  /** 로컬 구독 배치에서 같은 공고의 Kordoc 지원 양식 선분석을 함께 실행한다. */
  withApplicationRoundtrip?: boolean;
  /** 미지정 시 딥 분석 모델을 상속한다. */
  roundtripModel?: string;
}

/** GET/POST/DELETE ops/batch 응답 — 동시 1잡(싱글턴). state=idle 이면 나머지는 직전 잡 잔상 또는 null. */
export interface LabBatchJobSnapshot {
  jobId: string | null;
  state: "idle" | "running" | "finished" | "aborted" | "error";
  /**
   * 잡 출처(관측 브리지, 2026-08-03) — "cli" 는 CLI 배치(pnpm lab:batch)가 batch-job.json
   * 으로 중계한 스냅샷. 부재는 "web"(웹 잡 관리자 batch-job.ts 소유 — 하위 호환 optional).
   */
  origin?: "web" | "cli";
  /**
   * origin "cli" 일 때 기록 프로세스 pid — 웹 폴백(batch-job.ts)이 생존 판정
   * (process.kill(pid, 0))에 써서 running 유지/aborted 강등을 가른다. web 스냅샷은 미기록.
   */
  pid?: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  options: (LabBatchStartRequest & { transport: "api" | "claude-cli"; model: string }) | null;
  progress: { total: number; started: number; ok: number; error: number; cumulativeCostUsd: number } | null;
  guardStop: { reason: "cost-cap" | "window-exhausted"; cumulativeCostUsd: number } | null;
  summary: LabBatchSummary | null;
  /** 최근 이벤트 링 버퍼(최대 200건) — 폴링 UI 가 그대로 렌더한다. */
  events: LabBatchEvent[];
  /** 러너 자체 실패(인프라) — 게이트 중단·error 런과 구분된다. */
  error: string | null;
}

// ---- API 계약 (모든 라우트는 dev 전용: production 이면 404) ----
// GET  /api/dev/analysis-lab/cohort           → LabCohortResponse (?refresh=1 로 코호트 재선정)
// POST /api/dev/analysis-lab/analyze          → LabAnalyzeResponse (본문: LabAnalyzeRequest, 동기 수 분 소요)
// GET  /api/dev/analysis-lab/run?grantId=&runId= → LabRunResponse
// GET  /api/dev/analysis-lab/review?grantId=&runId= → LabReviewResponse (없으면 review:null)
// PUT  /api/dev/analysis-lab/review           → 본문 LabReviewUpsertRequest → LabReviewResponse
// GET  /api/dev/analysis-lab/audit?grantId=&runId=&model= → LabAuditResponse (감사 파일 없으면 생성 — §9)
// PUT  /api/dev/analysis-lab/audit            → 본문 LabAuditUpsertRequest → LabAuditResponse
// GET  /api/dev/analysis-lab/ops/summary      → LabOpsSummary (?refresh=1 로 파일 스캔 캐시 무효화)
// POST /api/dev/analysis-lab/ops/batch        → LabBatchJobSnapshot (본문 LabBatchStartRequest, 실행 중이면 409)
// GET  /api/dev/analysis-lab/ops/batch        → LabBatchJobSnapshot (2~5s 폴링)
// DELETE /api/dev/analysis-lab/ops/batch      → LabBatchJobSnapshot (abort — 진행분은 완료 저장)

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
