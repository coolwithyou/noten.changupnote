import type { ApplySheet, RuleTraceChip, SupportAmount } from "@cunote/contracts";
import type { VerdictStatus } from "@/components/app/verdict-badge";
import type { GrantPreviewAvailability } from "@/lib/server/documents/documentPreview";

export type GrantOverviewCtaMode =
  | "template_fill"
  | "ai_draft"
  | "web_form_guide"
  | "analyzing"
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
 * 상세 계약에는 recommendationTier가 없으므로 hard fail/추가 답변 여부만 보수적으로 사용한다.
 */
export function grantOverviewVerdict(sheet: ApplySheet): VerdictStatus {
  if (sheet.grant.status === "closed") return "closed";
  if (sheet.needsCheck.some((trace) => trace.result === "fail")) return "closed";

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
  ) {
    return "one_answer";
  }
  if (unresolved.length > 0) return "check_source";
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
 */
export function grantOverviewCta(
  sheet: ApplySheet,
  availability: GrantPreviewAvailability | null,
): GrantOverviewCta {
  const documents = sheet.applicationPrep.draftableDocuments;
  const templateCount = documents.filter((document) => document.hwpxTemplateAvailable).length;
  const readySurfaceCount = Math.max(0, availability?.readySurfaceCount ?? 0);
  const pendingSurfaceCount = Math.max(0, availability?.pendingSurfaceCount ?? 0);

  if (templateCount > 0 || readySurfaceCount > 0) {
    const count = Math.max(templateCount, readySurfaceCount);
    return {
      mode: "template_fill",
      label: "지원서 작성 시작",
      caption: `${count.toLocaleString("ko-KR")}개 원본 양식을 확인하며 작성을 시작해요`,
      variant: "default",
    };
  }

  if (pendingSurfaceCount > 0) {
    return {
      mode: "analyzing",
      label: "서류 준비 중 — 채팅으로 먼저 물어보기",
      caption: `${pendingSurfaceCount.toLocaleString("ko-KR")}개 양식을 분석 중이에요. 준비 내용을 먼저 확인할 수 있어요`,
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

  return {
    mode: "unknown",
    label: "이 사업 신청 준비하기",
    caption: "작성형 서류가 확인되지 않아 공고 원문과 준비 항목부터 살펴봐요",
    variant: "outline",
  };
}

export function formatEligibilitySummary(satisfiedCount: number, needsCheckCount: number): string {
  if (satisfiedCount === 0 && needsCheckCount === 0) return "매칭 확인 중";
  return `충족 ${satisfiedCount.toLocaleString("ko-KR")} · 확인 ${needsCheckCount.toLocaleString("ko-KR")}`;
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
