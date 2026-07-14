import type { CompanyPreviewResult, TeaserRequest } from "@cunote/contracts";
import {
  normalizeBusinessLookupBizNo,
  type BusinessLookupSuggestion,
} from "@/lib/businessLookupSuggestions";
import { safeInternalPath } from "@/lib/navigation/safeInternalPath";

/**
 * 로그인 후 재개(resume) 플로우가 읽는 sessionStorage 키.
 * matches 기능(MatchesExperience)이 동일 리터럴로 write 하므로 절대 바꾸지 않는다.
 */
export const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";

/** 비로그인 CTA용 로그인 링크(로그인 후 랜딩으로 복귀). */
export const LANDING_LOGIN_HREF = `/login?${new URLSearchParams({ callbackUrl: "/" }).toString()}`;

/**
 * 사업자번호 확인 다이얼로그 상태.
 * loading → 확인 중, confirm → 상호/영업상태 확인, error → 안내.
 */
export type BizLookupModalState =
  | { phase: "loading"; bizNo: string }
  | { phase: "confirm"; bizNo: string; preview: CompanyPreviewResult }
  | { phase: "error"; bizNo: string; title: string; message: string };

/** 숫자만 남기고 최대 10자리. */
export function onlyDigits(value: string): string {
  return value.replace(/\D/g, "").slice(0, 10);
}

/** 000-00-00000 자동 포맷. */
export function fmtBiz(value: string): string {
  const d = onlyDigits(value);
  if (d.length > 5) return `${d.slice(0, 3)}-${d.slice(3, 5)}-${d.slice(5)}`;
  if (d.length > 3) return `${d.slice(0, 3)}-${d.slice(3)}`;
  return d;
}

/** 10자리를 000-**-00*** 로 마스킹(서버 maskCorpNum과 동일 포맷 — 로딩→확인 상태에서 포맷이 바뀌지 않게). */
export function maskLandingBizNo(digits: string): string {
  if (digits.length !== 10) return fmtBiz(digits);
  return `${digits.slice(0, 3)}-**-${digits.slice(5, 7)}***`;
}

/** preview 에러 코드별 다이얼로그 제목. 번호 문제는 재확인, 그 외는 재시도 유도. */
export function titleForPreviewError(code: string | undefined): string {
  if (code === "biz_no_not_registered") return "등록된 사업자를 찾지 못했어요";
  if (code === "invalid_biz_no" || code === "biz_no_closed") {
    return "사업자번호를 다시 확인해 주세요";
  }
  return "잠시 후 다시 시도해 주세요";
}

/** 디자인 정본의 미등록 안내는 공급자 원문 대신 사용자가 다음 행동을 알 수 있게 고정한다. */
export function messageForPreviewError(code: string | undefined, fallback?: string): string {
  if (code === "biz_no_not_registered") {
    return "번호를 다시 확인해 주세요. 방금 낸 사업자라면 등록까지 1~2일 걸릴 수 있어요.";
  }
  return fallback ?? "회사 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.";
}

/** 입력값과 겹치는 최근 조회 제안을 걸러 최대 4개 노출. */
export function filterLandingLookupSuggestions(
  suggestions: BusinessLookupSuggestion[],
  query: string,
): BusinessLookupSuggestion[] {
  const normalizedQuery = normalizeBusinessLookupBizNo(query);
  const filtered = normalizedQuery
    ? suggestions.filter((suggestion) => {
        if (suggestion.bizNo === normalizedQuery) return false;
        return (
          suggestion.bizNo.startsWith(normalizedQuery) ||
          suggestion.bizNoFormatted.includes(normalizedQuery) ||
          suggestion.companyName?.includes(normalizedQuery)
        );
      })
    : suggestions;
  return filtered.slice(0, 4);
}

/** sessionStorage의 대기 중 teaser 요청을 읽고 즉시 제거(1회성). */
export function readPendingTeaserRequest(): TeaserRequest | null {
  try {
    const raw = window.sessionStorage.getItem(PENDING_TEASER_STORAGE_KEY);
    window.sessionStorage.removeItem(PENDING_TEASER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as TeaserRequest) : null;
  } catch {
    return null;
  }
}

/** 재개 로그인이 필요한 경우 랜딩으로 돌아오도록 callbackUrl을 심어 이동. */
export function redirectToLoginForDashboard(resumeNext?: string | null) {
  const resumeParams = new URLSearchParams({ resumeCompany: "1" });
  const safeNext = safeInternalPath(resumeNext);
  if (safeNext) resumeParams.set("resumeNext", safeNext);
  const params = new URLSearchParams({ callbackUrl: `/?${resumeParams.toString()}` });
  window.location.assign(`/login?${params.toString()}`);
}

/** resumeCompany/resumeGrant 쿼리를 URL에서 제거(경로·해시 유지). */
export function clearResumeFlag(params: URLSearchParams) {
  params.delete("resumeCompany");
  params.delete("resumeGrant");
  params.delete("resumeNext");
  const query = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
  );
}

/** 지원금 최대액을 억/만원 단위로 축약(정수 근사). banners 방어용. */
export function formatSupportAmount(amount: number): string | null {
  if (!Number.isFinite(amount) || amount <= 0) return null;
  if (amount >= 100_000_000) {
    const eok = amount / 100_000_000;
    const rounded = Number.isInteger(eok) ? eok.toString() : eok.toFixed(1);
    return `최대 ${rounded}억 원`;
  }
  if (amount >= 10_000) {
    return `최대 ${Math.round(amount / 10_000).toLocaleString("ko-KR")}만 원`;
  }
  return `최대 ${amount.toLocaleString("ko-KR")}원`;
}
