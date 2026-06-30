import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import { BillingInvoiceError } from "@/lib/server/billing/invoices";
import {
  billingInvoiceEmailHandoffDownloadResponse,
  buildBillingInvoiceEmailHandoff,
} from "@/lib/server/billing/invoiceEmailHandoff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{
    invoiceId: string;
  }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const access = await requireCompanyAccess();
    const session = await getOptionalWebSession();
    const { invoiceId } = await context.params;
    const handoff = await buildBillingInvoiceEmailHandoff({ access, session, invoiceId });
    return billingInvoiceEmailHandoffDownloadResponse(handoff);
  } catch (error) {
    if (error instanceof BillingInvoiceError) {
      return webActionError<null>(error, {
        code: error.code,
        message: error.message,
      });
    }
    return webActionError<null>(error, {
      code: "billing_invoice_email_handoff_failed",
      message: "청구서 이메일 파일을 만들지 못했습니다.",
    });
  }
}
