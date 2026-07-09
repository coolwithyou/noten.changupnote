type LandingFunnelEvent =
  | "biz_no_input_started"
  | "biz_no_validation_failed"
  | "company_preview_requested"
  | "company_preview_succeeded"
  | "company_preview_failed"
  | "company_confirmed"
  | "company_rejected"
  | "teaser_submitted"
  | "teaser_succeeded"
  | "teaser_failed"
  | "teaser_match_clicked"
  | "dashboard_cta_clicked"
  | "company_create_succeeded"
  | "auth_resume_started";

interface LandingFunnelEventPayload {
  event: LandingFunnelEvent;
  requestId?: string;
  durationMs?: number;
  inputLength?: number;
  reason?: string;
  errorCode?: string;
  grantId?: string;
  eligibility?: string;
  eligibleCount?: number;
  conditionalCount?: number;
  ineligibleCount?: number;
  deadlineSoonCount?: number;
  hasAmount?: boolean;
  avgConfidenceBucket?: "none" | "low" | "medium" | "high";
}

export function recordLandingEvent(input: LandingFunnelEventPayload) {
  const payload = JSON.stringify(sanitizeLandingEvent(input));

  if (navigator.sendBeacon) {
    const blob = new Blob([payload], { type: "application/json" });
    if (navigator.sendBeacon("/api/web/landing-events", blob)) return;
  }

  void fetch("/api/web/landing-events", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: payload,
    keepalive: true,
  }).catch(() => {
    // Landing conversion should never depend on analytics persistence.
  });
}

function sanitizeLandingEvent(input: LandingFunnelEventPayload): LandingFunnelEventPayload {
  return {
    event: input.event,
    ...(input.requestId ? { requestId: input.requestId.slice(0, 80) } : {}),
    ...(typeof input.durationMs === "number" ? { durationMs: Math.max(0, Math.round(input.durationMs)) } : {}),
    ...(typeof input.inputLength === "number" ? { inputLength: Math.max(0, Math.min(10, Math.round(input.inputLength))) } : {}),
    ...(input.reason ? { reason: input.reason.slice(0, 80) } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode.slice(0, 80) } : {}),
    ...(input.grantId ? { grantId: input.grantId.slice(0, 160) } : {}),
    ...(input.eligibility ? { eligibility: input.eligibility.slice(0, 40) } : {}),
    ...(typeof input.eligibleCount === "number" ? { eligibleCount: Math.max(0, Math.round(input.eligibleCount)) } : {}),
    ...(typeof input.conditionalCount === "number" ? { conditionalCount: Math.max(0, Math.round(input.conditionalCount)) } : {}),
    ...(typeof input.ineligibleCount === "number" ? { ineligibleCount: Math.max(0, Math.round(input.ineligibleCount)) } : {}),
    ...(typeof input.deadlineSoonCount === "number" ? { deadlineSoonCount: Math.max(0, Math.round(input.deadlineSoonCount)) } : {}),
    ...(typeof input.hasAmount === "boolean" ? { hasAmount: input.hasAmount } : {}),
    ...(input.avgConfidenceBucket ? { avgConfidenceBucket: input.avgConfidenceBucket } : {}),
  };
}
