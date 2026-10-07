import type { ApplySheet, MatchingEvidence, RuleTraceChip, SupportAmount } from "@cunote/contracts";
import type { explainCondition } from "@cunote/core";
import type { VerdictStatus } from "@/components/app/verdict-badge";
import type { GrantPreviewAvailability } from "@/lib/server/documents/documentPreview";
import { formatDraftResumeCaption, type DraftResumeSummary } from "@/lib/documents/draftResume";

export type GrantOverviewCtaMode =
  | "resume"
  | "manual_form"
  | "ai_draft"
  | "web_form_guide"
  | "preparation_needed"
  | "unknown";

export interface GrantOverviewCta {
  mode: GrantOverviewCtaMode;
  label: string;
  caption: string;
  variant: "default" | "outline";
}

export interface GrantOverviewTraceAction {
  href: string;
  external: boolean;
}

/**
 * ApplySheet가 보존하는 실제 판정 흔적을 화면의 고정 4상태 어휘로 투영한다.
 * matcher의 검수 단계가 있으면 상세 화면이 trace만으로 더 낙관적인 판정을 다시 만들지 않는다.
 * legacy sheet에는 검수 단계가 없을 수 있으므로 그때만 기존 trace 기반 판정을 유지한다.
 */
export function grantOverviewVerdict(sheet: ApplySheet): VerdictStatus {
  if (sheet.grant.status === "closed") return "closed";
  if (sheet.needsCheck.some((trace) => trace.result === "fail")) return "closed";
  if (sheet.matchingEvidence?.level === "discovery") return "check_source";

  if (sheet.recommendationTier === "not_recommended") return "closed";
  if (sheet.recommendationTier === "needs_core_review" || sheet.scoreDisplay === "hidden") {
    return "check_source";
  }

  // 접수 예정과 수집 상태 미확인은 신청 가능 판정이 아니다. 예정 안내는 NoticeCard가 맡고,
  // 고정 4상태 뱃지에서는 원문 확인 필요로 보수적으로 표현한다.
  if (sheet.grant.status !== "open") return "check_source";

  // 원문에서만 확인된 서류가 하나라도 있으면 회사값 하나만 답해도 판정을 확정할 수 없다.
  if (sheet.documents.some((document) => document.fromTextOnly)) return "check_source";

  const unresolved = sheet.needsCheck.filter((trace) => trace.result !== "pass");
  const progressiveUnknowns = unresolved.filter(
    (trace) => trace.result === "unknown" && trace.action?.type === "progressive",
  );
  const progressiveDimensions = new Set(progressiveUnknowns.map((trace) => trace.dimension));
  if (
    unresolved.length > 0
    && progressiveUnknowns.length === unresolved.length
    && progressiveDimensions.size === 1
    && (
      sheet.recommendationTier === undefined
      || sheet.recommendationTier === "needs_profile_input"
    )
  ) {
    return "one_answer";
  }
  if (unresolved.length > 0) return "check_source";
  if (sheet.recommendationTier === "needs_profile_input") return "check_source";
  return "open";
}

/**
 * 자격 조건 CTA를 실제 존재하는 화면이나 검증된 원문 URL로만 연결한다.
 * dimension 키는 경로가 아니므로 progressive 액션은 회사 정보 편집 화면으로 모은다.
 */
export function grantOverviewTraceAction(
  action: NonNullable<RuleTraceChip["action"]>,
  sourceUrl: string | null | undefined,
): GrantOverviewTraceAction | null {
  if (action.type === "progressive") {
    return { href: "/settings?section=company", external: false };
  }

  const directExternalUrl = validHttpUrl(action.target);
  const originalGrantUrl = validHttpUrl(sourceUrl);

  if (action.type === "external_link") {
    const href = originalGrantUrl ?? directExternalUrl;
    return href ? { href, external: true } : null;
  }

  if (action.type === "apply") {
    const href = directExternalUrl ?? originalGrantUrl;
    return href ? { href, external: true } : null;
  }

  if (action.type === "prepare" || action.type === "verify") {
    const href = originalGrantUrl ?? directExternalUrl;
    if (href) return { href, external: true };
    return { href: "/settings?section=company", external: false };
  }

  return null;
}

/**
 * 작성 지원 모드는 현재 상세 로더가 이미 제공하는 서식 보관본·변환·작성형 서류·접수 방법만으로 판정한다.
 * 정보가 부족하면 초안/서식 채움을 약속하지 않고 unknown으로 남긴다.
 *
 * 저장본이 있으면(디자인 2라운드 03 장면 F) 작성 시작 대신 같은 workspace 로 돌아가는 "문서 열기"로
 * 바꾼다. 원래 모드가 실제 작성이 시작되는 manual_form·ai_draft 일 때만이며, 준비 필요·안내·unknown
 * 모드는 저장본과 무관하게 원래 CTA 를 유지한다.
 */
export function grantOverviewCta(
  sheet: ApplySheet,
  availability: GrantPreviewAvailability | null,
  draftResume: DraftResumeSummary | null = null,
  options: { now?: Date } = {},
): GrantOverviewCta {
  const base = baseGrantOverviewCta(sheet, availability);
  if (
    draftResume
    && draftResume.savedCount > 0
    && (base.mode === "manual_form" || base.mode === "ai_draft")
  ) {
    return {
      mode: "resume",
      label: "문서 열기",
      caption: formatDraftResumeCaption({
        savedCount: draftResume.savedCount,
        lastSavedAt: draftResume.lastSavedAt,
        ...(options.now ? { now: options.now } : {}),
      }),
      variant: "default",
    };
  }
  return base;
}

function baseGrantOverviewCta(
  sheet: ApplySheet,
  availability: GrantPreviewAvailability | null,
): GrantOverviewCta {
  const documents = sheet.applicationPrep.draftableDocuments;
  const editableDocument = documents.some((document) => Boolean(document.sourceAttachment)
    && (document.hwpxTemplateAvailable || /\.hwpx?$/i.test(document.sourceAttachment ?? "")));
  const pendingSurfaceCount = Math.max(0, availability?.pendingSurfaceCount ?? 0);

  // 자격 분석/미리보기의 준비도는 원본 편집이나 자동 입력의 증거가 아니다.
  if (editableDocument) {
    return {
      mode: "manual_form",
      label: "지원서 작성 시작",
      caption: "원본 양식을 열고 작성해요. 자동 입력 가능한 항목은 작성 화면에서 확인해요",
      variant: "default",
    };
  }

  if (pendingSurfaceCount > 0) {
    return {
      mode: "preparation_needed",
      label: "서류 준비 내용 확인",
      caption: `${pendingSurfaceCount.toLocaleString("ko-KR")}개 양식의 준비가 필요해요. 작성 화면에서 현재 상태를 확인할 수 있어요`,
      variant: "outline",
    };
  }

  if (documents.length > 0) {
    return {
      mode: "ai_draft",
      label: "초안으로 준비 시작",
      caption: `${documents.length.toLocaleString("ko-KR")}개 작성 서류를 기준으로 초안 준비를 시작해요`,
      variant: "default",
    };
  }

  if (isOnlineApplication(sheet.applyMethod)) {
    return {
      mode: "web_form_guide",
      label: "신청 항목 안내 받기",
      caption: sheet.applyMethod
        ? `접수 방법: ${sheet.applyMethod}`
        : "온라인 접수에 필요한 항목과 준비 값을 확인해요",
      variant: "default",
    };
  }

  if (sheet.matchingEvidence?.level === "discovery") {
    return {
      mode: "unknown",
      label: "공고 원문에서 조건 확인",
      caption: "작성할 양식과 자격 조건을 공고 원문에서 확인해 주세요",
      variant: "outline",
    };
  }

  return {
    mode: "unknown",
    label: "이 사업 신청 준비하기",
    caption: "작성형 서류가 확인되지 않아 공고 원문과 준비 항목부터 살펴봐요",
    variant: "outline",
  };
}

export interface EligibilityConditionCounts {
  /** 필수·제외 조건 총수(M). */
  total: number;
  /** 회사 정보와 비교해 통과한 조건 수(N). */
  passed: number;
  /** 명백한 불일치(fail) 수(J). */
  failed: number;
  /** 답하거나 원문을 봐야 하는 남은 쟁점 수(K = M − N − J). */
  unknown: number;
}

/** 판정에 쓰인 필수·제외 조건만 센다. 우대 조건은 집계에 넣지 않는다. */
export function countHardConditions(
  sheet: Pick<ApplySheet, "satisfied" | "needsCheck">,
): EligibilityConditionCounts {
  const hard = hardConditions(sheet);
  const passed = hard.filter((trace) => trace.result === "pass").length;
  const failed = hard.filter((trace) => trace.result === "fail").length;
  return { total: hard.length, passed, failed, unknown: hard.length - passed - failed };
}

/** 필수·제외 조건 중 명백한 불일치(fail)만 돌려준다(콜아웃 "중요 자격 쟁점 N건"의 근거). */
export function failedHardConditions(
  sheet: Pick<ApplySheet, "satisfied" | "needsCheck">,
): RuleTraceChip[] {
  return hardConditions(sheet).filter((trace) => trace.result === "fail");
}

/**
 * 불일치 조건 한 건을 콜아웃 문장으로 만든다. 디자인 문장("대표자 만 39세 이하 — 회사 정보의
 * 대표자 출생연도 1984년과 맞지 않아요")의 구조를 따르되 회사값이 비어 있으면 값 없이 말한다.
 */
export function describeFailedCondition(trace: RuleTraceChip): string {
  const label = trace.label?.trim() || trace.sourceSpan?.trim() || "자격 조건";
  const companyValue = trace.companyValue?.trim();
  return companyValue
    ? `${label} — 회사 정보(${companyValue})와 맞지 않아요.`
    : `${label} — 현재 회사 정보와 맞지 않아요.`;
}

/**
 * 집계 어휘(결정 D1): "확인된 조건 N/M · 남은 쟁점 K", 불일치가 있으면 " · 불일치 J"를 붙인다.
 * 필수·제외 조건이 하나도 정리되지 않았으면(총수 0) 기존 "매칭 확인 중"을 유지한다.
 */
export function formatEligibilitySummary(
  satisfiedCount: number,
  unknownCount: number,
  failedCount = 0,
): string {
  const total = satisfiedCount + unknownCount + failedCount;
  if (total === 0) return "매칭 확인 중";
  const parts = [
    `확인된 조건 ${satisfiedCount.toLocaleString("ko-KR")}/${total.toLocaleString("ko-KR")}`,
    `남은 쟁점 ${unknownCount.toLocaleString("ko-KR")}`,
  ];
  if (failedCount > 0) parts.push(`불일치 ${failedCount.toLocaleString("ko-KR")}`);
  return parts.join(" · ");
}

function hardConditions(sheet: Pick<ApplySheet, "satisfied" | "needsCheck">): RuleTraceChip[] {
  return [...sheet.satisfied, ...sheet.needsCheck]
    .filter((trace) => trace.kind === "required" || trace.kind === "exclusion");
}

export function formatSupportAmount(amount: SupportAmount): string {
  if (amount.label) return normalizeAmountSpacing(amount.label);
  if (!amount.max || amount.max <= 0) return "금액 미확인";
  if (amount.max >= 100_000_000) {
    const eok = amount.max / 100_000_000;
    const value = Number.isInteger(eok) ? eok.toLocaleString("ko-KR") : eok.toFixed(1);
    return `${value}억 원`;
  }
  if (amount.max >= 10_000) {
    return `${Math.round(amount.max / 10_000).toLocaleString("ko-KR")}만 원`;
  }
  return `${Math.round(amount.max).toLocaleString("ko-KR")}원`;
}

export function formatDday(value: number | null): string {
  if (value === null) return "일정 확인";
  if (value < 0) return "마감 확인";
  if (value === 0) return "오늘 마감";
  return `D-${value}`;
}

function isOnlineApplication(value: string | null): boolean {
  if (!value) return false;
  return /온라인\s*접수|웹\s*폼|구글\s*폼|google\s*form|시스템\s*(직접\s*)?입력/i.test(value);
}

function validHttpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : null;
  } catch {
    return null;
  }
}

function normalizeAmountSpacing(value: string): string {
  return value.replace(/(억|만)\s*원/g, "$1 원");
}

// ── 자격 조건 행(디자인 03 `.ct`) ─────────────────────────────────────────

export type ExplainedCondition = ReturnType<typeof explainCondition>;

/** 조건 행 6상태(디자인 03 `.st-*`). 판정 4상태 뱃지(헌법 8조)와는 별개의 행 단위 어휘다. */
export type ConditionRowStatus = "met" | "unmet" | "ask" | "per" | "src" | "wait";

export const CONDITION_ROW_STATUS_LABEL: Record<ConditionRowStatus, string> = {
  met: "충족",
  unmet: "미충족",
  ask: "내 답 필요",
  per: "공고별 확인",
  src: "원문 확인 필요",
  wait: "검토 준비 중",
};

/**
 * explainCondition 결과를 조건 행 6상태로 투영한다.
 * pass/fail은 판정 그대로, 미해소 조건은 다음 행동(회사 정보 입력 → 공고별 확인 질문 → 원문 확인) 순으로 고른다.
 * confirmationNextAction이 없는 legacy trace는 action을 같은 뜻으로 읽는다(progressive는 회사 정보 입력,
 * 그 밖의 링크형 행동은 원문 확인). 어느 쪽도 아니면 검토 준비 중이다.
 */
export function conditionRowStatus(condition: ExplainedCondition): ConditionRowStatus {
  const { trace } = condition;
  if (trace.result === "pass") return "met";
  if (trace.result === "fail") return "unmet";
  if (condition.action === "company_profile") return "ask";
  if (condition.action === "user_confirmation") return "per";
  if (!trace.confirmationNextAction && trace.action) {
    return trace.action.type === "progressive" ? "ask" : "src";
  }
  if (trace.result === "text_only" || trace.unresolvedReason === "criterion_text_only") return "src";
  return "wait";
}

export type ConditionTrust = "reviewed" | "ai";

export const CONDITION_TRUST_LABEL: Record<ConditionTrust, string> = {
  reviewed: "검수됨",
  ai: "AI가 읽음",
};

/**
 * 조건 추출의 검수 여부 칩. 조건 자체가 검수 대기(criterion_needs_review)면 시트 수준과 무관하게 "AI가 읽음",
 * 그 외에는 시트의 matchingEvidence 수준(verified → 검수됨, discovery → AI가 읽음)을 따른다.
 * 수준이 없는 legacy 시트는 칩을 생략한다.
 */
export function conditionTrust(
  condition: ExplainedCondition,
  evidenceLevel: MatchingEvidence["level"] | null | undefined,
): ConditionTrust | null {
  if (condition.trace.unresolvedReason === "criterion_needs_review") return "ai";
  if (evidenceLevel === "verified") return "reviewed";
  if (evidenceLevel === "discovery") return "ai";
  return null;
}

/**
 * 상태 아래 근거 한 줄(디자인 `.ev`). 회사값이 있으면 그것(예: "부산 해운대구 · 국세청"), 없으면 판정 이유.
 * 공고별 확인은 core의 이유 문장이 이 화면의 금지 어휘를 포함해 행 어휘로 바꿔 쓴다.
 */
export function conditionRowEvidence(
  condition: ExplainedCondition,
  status: ConditionRowStatus = conditionRowStatus(condition),
): string {
  if (condition.hasCompanyValue) return condition.companyValue;
  if (status === "per") return "이 공고에서만 확인하는 질문이에요. 답하면 다시 판단해요.";
  return condition.reason;
}

/**
 * 조건 문장 아래 출처 줄(디자인 `.ev-src` "공고문 2쪽 「신청 자격」"). 쪽·절 위치가 없으므로 "공고 원문"에
 * 기준명(label, 조건 문장과 다를 때만)과 검수 전 표시를 붙인다. 조건 문장이 이미 원문 구절(requirement)이라
 * 같은 구절을 여기에 다시 적지 않는다.
 */
export function conditionRowSource(condition: ExplainedCondition, trust: ConditionTrust | null): string {
  const label = condition.trace.label?.trim();
  const parts = ["공고 원문"];
  if (label && label !== condition.requirement) parts.push(label);
  if (trust === "ai") parts.push("검수 전");
  return parts.join(" · ");
}
