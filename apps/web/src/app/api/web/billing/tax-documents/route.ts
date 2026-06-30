import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  BillingTaxDocumentError,
  uploadBillingTaxDocument,
  type BillingTaxDocumentUploadResult,
} from "@/lib/server/billing/taxDocuments";

export async function POST(request: Request) {
  try {
    const access = await requireCompanyAccess({ permission: "write" });
    const formData = await request.formData();
    const file = formData.get("file");
    if (!isUploadFile(file)) {
      return NextResponse.json<ActionResult<BillingTaxDocumentUploadResult>>({
        ok: false,
        error: {
          code: "billing_tax_document_file_required",
          message: "업로드할 파일을 선택해주세요.",
          field: "file",
        },
      }, { status: 400 });
    }
    const result = await uploadBillingTaxDocument({
      access,
      file,
      documentKind: formData.get("documentKind"),
    });
    return NextResponse.json<ActionResult<BillingTaxDocumentUploadResult>>(
      { ok: true, data: result },
      { status: result.persisted ? 201 : 202 },
    );
  } catch (error) {
    if (error instanceof BillingTaxDocumentError) {
      return webActionError<BillingTaxDocumentUploadResult>(error, {
        code: error.code,
        message: error.message,
      });
    }
    return webActionError<BillingTaxDocumentUploadResult>(error, {
      code: "billing_tax_document_upload_failed",
      message: "청구 증빙 파일을 업로드하지 못했습니다.",
    });
  }
}

function isUploadFile(value: FormDataEntryValue | null): value is File {
  return Boolean(value && typeof value === "object" && "arrayBuffer" in value && "size" in value && "name" in value);
}
