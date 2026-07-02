import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type LandingFunnelEvent =
  | "biz_no_input_started"
  | "biz_no_validation_failed"
  | "teaser_submitted"
  | "teaser_succeeded"
  | "teaser_failed"
  | "teaser_match_clicked"
  | "dashboard_cta_clicked"
  | "company_create_succeeded"
  | "auth_resume_started";

interface LandingEventReceipt {
  accepted: true;
  event: LandingFunnelEvent;
  receivedAt: string;
}

const LANDING_EVENTS: LandingFunnelEvent[] = [
  "biz_no_input_started",
  "biz_no_validation_failed",
  "teaser_submitted",
  "teaser_succeeded",
  "teaser_failed",
  "teaser_match_clicked",
  "dashboard_cta_clicked",
  "company_create_succeeded",
  "auth_resume_started",
];

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    const event = normalizeEvent(body.event);
    if (!event) {
      return NextResponse.json<ActionResult<null>>({
        ok: false,
        error: {
          code: "invalid_landing_event",
          message: "랜딩 이벤트 이름을 확인해주세요.",
          field: "event",
        },
      }, { status: 400 });
    }

    return NextResponse.json<ActionResult<LandingEventReceipt>>({
      ok: true,
      data: {
        accepted: true,
        event,
        receivedAt: new Date().toISOString(),
      },
    }, { status: 202 });
  } catch {
    return NextResponse.json<ActionResult<null>>({
      ok: false,
      error: {
        code: "landing_event_failed",
        message: "랜딩 이벤트를 기록하지 못했습니다.",
      },
    }, { status: 500 });
  }
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await request.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeEvent(value: unknown): LandingFunnelEvent | null {
  return LANDING_EVENTS.includes(value as LandingFunnelEvent) ? value as LandingFunnelEvent : null;
}
