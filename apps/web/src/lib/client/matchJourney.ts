import type { MatchCard, MatchJourneyEvent } from "@cunote/contracts";

/** 회사 전환 시 새 세션. 메모리에만 두며 원문·회사 값은 이벤트에 넣지 않는다. */
export function createMatchJourneyRecorder() {
  let session: { companyId: string; id: string; start: number } | undefined;
  const begin = (companyId: string | null) => {
    try {
      if (!companyId) { session = undefined; return; }
      if (session?.companyId !== companyId) session = { companyId, id: crypto.randomUUID(), start: performance.now() };
    } catch { session = undefined; }
  };
  const record = (companyId: string | null, match: MatchCard, action: MatchJourneyEvent["action"]) => {
    if (!companyId || companyId.startsWith("virtual-") || typeof navigator === "undefined" || navigator.webdriver) return;
    try {
      begin(companyId);
      if (!session) return;
      const journey: MatchJourneyEvent = { version: 1, sessionId: session.id, action,
        elapsedMs: Math.min(86_400_000, Math.max(0, Math.round(performance.now() - session.start))),
        evidence: match.matchingEvidence?.level ?? "legacy", eligibility: match.eligibility };
      void fetch(`/api/web/matches/${encodeURIComponent(match.grantId)}/events`, {
        method: "POST", credentials: "same-origin", keepalive: true, headers: { "content-type": "application/json" },
        body: JSON.stringify({ companyId, event: "clicked", rulesetVer: "match-journey-v1", journey }),
      }).catch(() => {});
    } catch { /* 계측 장애가 기본 행동을 막지 않는다. */ }
  };
  return Object.assign(record, { begin });
}
