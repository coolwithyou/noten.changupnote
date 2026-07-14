import type { ActionQueueItem, MatchingProfileView } from "@cunote/contracts";

export interface DashboardPrecisionSummary {
  pct: number;
  known: number;
  remaining: number;
}

/** 매칭 결과 화면과 같은 보수적 규칙으로 회사 정보 완성도를 계산한다. */
export function dashboardPrecision(profileView: MatchingProfileView): DashboardPrecisionSummary {
  const total = Math.max(1, profileView.rows.length);
  return {
    pct: Math.max(0, Math.min(100, Math.round((profileView.knownCount / total) * 100))),
    known: profileView.knownCount,
    remaining: Math.max(0, profileView.partialCount + profileView.unknownCount),
  };
}

/** 프로필 보강은 설정으로, 공고별 행동은 해당 공고로 보낸다. */
export function dashboardActionHref(action: ActionQueueItem): string {
  if (action.kind === "input" || action.kind === "enrich") {
    return "/settings#company-settings";
  }
  if (action.target.startsWith("/")) return action.target;
  if (/^https?:\/\//.test(action.target)) return action.target;

  const firstGrantId = action.affectedGrantIds[0];
  return firstGrantId ? `/grants/${encodeURIComponent(firstGrantId)}` : "/dashboard";
}
