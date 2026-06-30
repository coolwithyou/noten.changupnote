import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import {
  BillingWebhookError,
  handleBillingWebhook,
  type BillingWebhookResult,
} from "@/lib/server/billing/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    provider: string;
  }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ provider }, rawBody] = await Promise.all([context.params, request.text()]);
    const result = await handleBillingWebhook({
      provider,
      rawBody,
      headers: request.headers,
    });
    return NextResponse.json<ActionResult<BillingWebhookResult>>(
      { ok: true, data: result },
      { status: result.persisted ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof BillingWebhookError) {
      return NextResponse.json<ActionResult<null>>(
        {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
          },
        },
        { status: error.status },
      );
    }
    return NextResponse.json<ActionResult<null>>(
      {
        ok: false,
        error: {
          code: "billing_webhook_failed",
          message: error instanceof Error ? error.message : "결제 webhook을 처리하지 못했습니다.",
        },
      },
      { status: 500 },
    );
  }
}
