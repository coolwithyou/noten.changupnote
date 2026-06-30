import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  BillingInvoiceError,
  billingInvoiceReceiptDownloadResponse,
  buildBillingInvoiceReceipt,
} from "@/lib/server/billing/invoices";

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
    const { invoiceId } = await context.params;
    const receipt = await buildBillingInvoiceReceipt({ access, invoiceId });
    return billingInvoiceReceiptDownloadResponse(receipt);
  } catch (error) {
    if (error instanceof BillingInvoiceError) {
      return webActionError<null>(error, {
        code: error.code,
        message: error.message,
      });
    }
    return webActionError<null>(error, {
      code: "billing_invoice_receipt_failed",
      message: "청구 영수증을 다운로드하지 못했습니다.",
    });
  }
}
