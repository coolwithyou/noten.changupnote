import { appData, appError } from "@/lib/server/appApi/envelope";
import { AdminAccessError, requireAdminAccess } from "@/lib/server/auth/adminGuard";
import {
  BillingSubscriptionError,
  updateBillingSubscription,
} from "@/lib/server/billing/subscription";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    companyId: string;
  }>;
}

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const admin = await requireAdminAccess();
    const [{ companyId }, body] = await Promise.all([context.params, readJson(request)]);
    const result = await updateBillingSubscription({
      companyId,
      admin,
      provider: body.provider,
      providerCustomerId: body.providerCustomerId,
      providerSubscriptionId: body.providerSubscriptionId,
      status: body.status,
      planCode: body.planCode,
      planName: body.planName,
      priceLabel: body.priceLabel,
      renewalLabel: body.renewalLabel,
      seatLimit: body.seatLimit,
      autoBillingEnabled: body.autoBillingEnabled,
      invoicesEnabled: body.invoicesEnabled,
      paymentMethodManaged: body.paymentMethodManaged,
      providerPortalUrl: body.providerPortalUrl,
      trialEndsAt: body.trialEndsAt,
      currentPeriodEnd: body.currentPeriodEnd,
    });
    return appData(result, { status: result.persisted ? 200 : 202 });
  } catch (error) {
    if (error instanceof AdminAccessError) {
      return appError(error.code, error.message, error.status);
    }
    if (error instanceof BillingSubscriptionError) {
      return appError(error.code, error.message, error.status, error.field);
    }
    return appError(
      "admin_billing_subscription_update_failed",
      error instanceof Error ? error.message : "구독 상태를 저장하지 못했습니다.",
    );
  }
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value = await request.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
