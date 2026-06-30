import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { updateNotificationReceipt } from "@/lib/server/notifications/notificationCenter";
import type { NotificationCenterItem, NotificationReceiptAction } from "@/lib/notifications/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const [access, body] = await Promise.all([requireCompanyAccess(), readBody(request)]);
    const item = await updateNotificationReceipt({
      access,
      notificationId: body.notificationId,
      action: body.action,
    });
    return NextResponse.json<ActionResult<NotificationCenterItem>>({ ok: true, data: item });
  } catch (error) {
    return webActionError<NotificationCenterItem>(error, {
      code: "notification_receipt_failed",
      message: "알림 상태를 저장하지 못했습니다.",
    });
  }
}

async function readBody(request: Request): Promise<{
  notificationId: string;
  action: NotificationReceiptAction;
}> {
  const parsed = await request.json() as Record<string, unknown>;
  const notificationId = typeof parsed.notificationId === "string" ? parsed.notificationId.trim() : "";
  const action = parsed.action === "dismiss" ? "dismiss" : "read";
  if (!notificationId) {
    throw new NotificationReceiptRequestError("invalid_notification_id", "알림 식별자를 확인해주세요.", 400);
  }
  return { notificationId, action };
}

class NotificationReceiptRequestError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.name = "NotificationReceiptRequestError";
    this.code = code;
    this.status = status;
  }
}
