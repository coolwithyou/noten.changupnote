import type { MatchEventKind, MatchEventRequest } from "@cunote/contracts";

export function recordWebMatchEvent(input: {
  grantId: string;
  event: MatchEventKind;
  rulesetVer?: string;
}) {
  const endpoint = `/api/web/matches/${encodeURIComponent(input.grantId)}/events`;
  const body: MatchEventRequest = { event: input.event };
  if (input.rulesetVer) body.rulesetVer = input.rulesetVer;
  const payload = JSON.stringify(body);

  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon(endpoint, blob)) return;
  }

  void fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Navigation and primary user actions should not depend on event persistence.
  });
}
