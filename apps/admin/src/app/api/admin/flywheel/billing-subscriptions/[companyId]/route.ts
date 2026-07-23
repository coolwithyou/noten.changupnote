import type { NextRequest } from "next/server";
import { updateBillingSubscription, BillingSubscriptionError } from "@/lib/server/billing/subscriptions";
import { AdminRequiredError, requireAdminSession } from "@/lib/server/auth/adminSession";
import { handleRoleError, requireAdminRole } from "@/lib/server/auth/adminRole";
import { adminData, adminError, readJson } from "@/lib/server/http/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<unknown>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const admin = await requireAdminSession();
    requireAdminRole(admin, "admin");
    const [params, body] = await Promise.all([context.params, readJson(request)]);
    const companyId = readParam(params, "companyId");
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
    return adminData(result, { status: result.persisted ? 200 : 202 });
  } catch (error) {
    if (error instanceof AdminRequiredError) return adminError(error.code, error.message, error.status);
    const roleError = handleRoleError(error);
    if (roleError) return roleError;
    if (error instanceof BillingSubscriptionError) {
      return adminError(error.code, error.message, error.status, error.field);
    }
    return adminError(
      "admin_billing_subscription_update_failed",
      error instanceof Error ? error.message : "구독 상태를 저장하지 못했습니다.",
    );
  }
}

function readParam(params: unknown, key: string): string {
  if (params && typeof params === "object" && key in params) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  throw new BillingSubscriptionError("invalid_route_param", "요청 경로를 확인해주세요.", 400, key);
}
