import type { NotificationReceiptAction, NotificationReceiptResult } from "@cunote/contracts";
import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppCompanyAccess } from "@/lib/server/auth/appSession";
import { updateNotificationReceipt } from "@/lib/server/notifications/notificationCenter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ companyId: string }>;
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const [{ companyId }, body] = await Promise.all([context.params, readBody(request)]);
    const access = await requireAppCompanyAccess(request, companyId);
    const notification = await updateNotificationReceipt({
      access: {
        companyId: access.companyId,
        userId: access.userId,
        role: "viewer",
        mode: access.mode,
      },
      notificationId: body.notificationId,
      action: body.action,
    });
    const { href: _href, ...item } = notification;
    return appData<NotificationReceiptResult>({ notification: item });
  } catch (error) {
    return appErrorFromUnknown(error, "알림 상태를 저장하지 못했습니다.");
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
    throw new NotificationReceiptRequestError("invalid_notification_id", "알림 식별자를 확인해주세요.", 400, "notificationId");
  }
  return { notificationId, action };
}

class NotificationReceiptRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "NotificationReceiptRequestError";
    this.code = code;
    this.status = status;
    this.field = field;
  }
}
