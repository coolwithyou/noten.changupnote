import { safeInternalPath } from "./safeInternalPath";

/** URL의 회사는 선택 쿠키와 독립적이다. 서버에서 반드시 소속 권한을 검증한다. */
export function withCompanyContext(path: string, companyId: string): string {
  const safe = safeInternalPath(path);
  if (!safe) throw new Error("안전한 내부 경로가 필요합니다.");
  const url = new URL(safe, "https://company-context.invalid");
  url.searchParams.set("companyId", companyId);
  if (url.pathname === "/matches") url.searchParams.delete("biz");
  return `${url.pathname}${url.search}${url.hash}`;
}

export const COMPANY_CONTEXT_HEADER = "x-cunote-company-id";

/** 작성 화면에서 나가는 API 호출만 회사 문맥에 결속한다. 외부/R2 요청에는 전달하지 않는다. */
export function companyScopedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (typeof window === "undefined") return fetch(input, init);
  const current = new URL(window.location.href);
  const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const target = new URL(raw, current);
  if (!current.searchParams.has("companyId") || target.origin !== current.origin || !target.pathname.startsWith("/api/web/")) {
    return fetch(input, init);
  }
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  // 빈 값도 전달: 명시한 잘못된 회사가 쿠키 회사로 후퇴해서는 안 된다.
  headers.set(COMPANY_CONTEXT_HEADER, current.searchParams.get("companyId")!);
  return fetch(input, { ...init, headers });
}
