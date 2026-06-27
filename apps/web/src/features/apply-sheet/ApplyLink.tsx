"use client";

import { recordWebMatchEvent } from "@/lib/client/matchEvents";

interface ApplyLinkProps {
  href: string;
  grantId: string;
}

export function ApplyLink({ href, grantId }: ApplyLinkProps) {
  function recordApplyClick() {
    recordWebMatchEvent({ grantId, event: "apply_click" });
  }

  return (
    <a href={href} target="_blank" rel="noreferrer" onClick={recordApplyClick}>
      신청 페이지 열기
    </a>
  );
}
