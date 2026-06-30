import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  BillingTaxProfileError,
  updateBillingTaxProfile,
  type BillingTaxProfileUpdateResult,
} from "@/lib/server/billing/taxProfile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request) {
  try {
    const [access, session, body] = await Promise.all([
      requireCompanyAccess({ permission: "write" }),
      getOptionalWebSession(),
      readBody(request),
    ]);
    const result = await updateBillingTaxProfile({
      access,
      session,
      businessName: body.businessName,
      businessRegistrationNumber: body.businessRegistrationNumber,
      recipientName: body.recipientName,
      recipientEmail: body.recipientEmail,
      recipientPhone: body.recipientPhone,
      taxInvoiceEmail: body.taxInvoiceEmail,
      billingAddressLine1: body.billingAddressLine1,
      billingAddressLine2: body.billingAddressLine2,
      postalCode: body.postalCode,
      taxInvoiceEnabled: body.taxInvoiceEnabled,
      notes: body.notes,
    });

    return NextResponse.json<ActionResult<BillingTaxProfileUpdateResult>>(
      { ok: true, data: result },
      { status: result.persisted ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof BillingTaxProfileError) {
      return webActionError<BillingTaxProfileUpdateResult>(error, {
        code: error.code,
        message: error.message,
      });
    }
    return webActionError<BillingTaxProfileUpdateResult>(error, {
      code: "billing_tax_profile_update_failed",
      message: "청구 프로필을 저장하지 못했습니다.",
    });
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
