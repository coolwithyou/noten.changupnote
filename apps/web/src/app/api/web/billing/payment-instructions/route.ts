import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { getOptionalWebSession } from "@/lib/server/auth/session";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  billingPaymentInstructionsDownloadResponse,
  buildBillingPaymentInstructions,
} from "@/lib/server/billing/paymentInstructions";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const access = await requireCompanyAccess();
    const session = await getOptionalWebSession();
    const instructions = await buildBillingPaymentInstructions({ access, session });
    return billingPaymentInstructionsDownloadResponse(instructions);
  } catch (error) {
    return webActionError<null>(error, {
      code: "billing_payment_instructions_failed",
      message: "수동 결제 안내서를 다운로드하지 못했습니다.",
    });
  }
}
