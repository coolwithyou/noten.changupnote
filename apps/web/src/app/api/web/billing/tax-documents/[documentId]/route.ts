import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  archiveBillingTaxDocument,
  BillingTaxDocumentError,
  type BillingTaxDocumentArchiveResult,
} from "@/lib/server/billing/taxDocuments";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ documentId: string }> },
) {
  try {
    const [access, { documentId }] = await Promise.all([
      requireCompanyAccess({ permission: "write" }),
      context.params,
    ]);
    const result = await archiveBillingTaxDocument({ access, documentId });
    return NextResponse.json<ActionResult<BillingTaxDocumentArchiveResult>>(
      { ok: true, data: result },
      { status: result.persisted ? 200 : 202 },
    );
  } catch (error) {
    if (error instanceof BillingTaxDocumentError) {
      return webActionError<BillingTaxDocumentArchiveResult>(error, {
        code: error.code,
        message: error.message,
      });
    }
    return webActionError<BillingTaxDocumentArchiveResult>(error, {
      code: "billing_tax_document_archive_failed",
      message: "청구 증빙 파일을 보관 해제하지 못했습니다.",
    });
  }
}
