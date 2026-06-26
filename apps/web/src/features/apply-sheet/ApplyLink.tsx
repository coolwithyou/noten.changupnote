"use client";

import type { MatchEventRequest } from "@cunote/contracts";

interface ApplyLinkProps {
  href: string;
  grantId: string;
}

export function ApplyLink({ href, grantId }: ApplyLinkProps) {
  function recordApplyClick() {
    const endpoint = `/api/web/matches/${encodeURIComponent(grantId)}/events`;
    const body: MatchEventRequest = { event: "apply_click" };
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
      // Link navigation should not depend on analytics persistence.
    });
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={recordApplyClick}>
      신청 페이지 열기
    </a>
  );
}
