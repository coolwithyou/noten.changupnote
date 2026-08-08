const DEV_WEB_ORIGIN = "https://dev.changupnote.com";

export interface RoundtripReviewTarget {
  grantId: string;
  runId: string;
}

export function roundtripReviewHref(grantId: string, runId: string): string {
  const search = new URLSearchParams({ roundtripGrantId: grantId, roundtripRunId: runId });
  return `/dev/analysis-lab?${search.toString()}#application-roundtrip`;
}

export function readRoundtripReviewTarget(search: string): RoundtripReviewTarget | null {
  const params = new URLSearchParams(search);
  const grantId = params.get("roundtripGrantId")?.trim() ?? "";
  const runId = params.get("roundtripRunId")?.trim() ?? "";
  return grantId && runId ? { grantId, runId } : null;
}

/**
 * analysis-lab은 127.0.0.1에서도 열리지만 웹 로그인 쿠키는 dev.changupnote.com에 있다.
 * 관리자 시뮬레이션은 인증된 개발 웹 호스트에서 열어 세션 경계를 유지한다.
 */
export function adminGrantSimulationHref(grantId: string): string {
  const path = `/grants/${encodeURIComponent(grantId)}?adminPreview=1`;
  return new URL(path, DEV_WEB_ORIGIN).toString();
}

export function adminGrantSimulationListHref(): string {
  return new URL("/internal/review/grants", DEV_WEB_ORIGIN).toString();
}
