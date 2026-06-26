import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { writeSelectedCompanyId } from "@/lib/server/auth/companySelection";
import { webActionError } from "@/lib/server/auth/webActionError";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface SwitchCompanyRequest {
  companyId?: string;
}

interface SwitchCompanyResult {
  currentCompanyId: string;
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    if (!body.companyId) {
      return NextResponse.json<ActionResult<SwitchCompanyResult>>({
        ok: false,
        error: {
          code: "invalid_company_id",
          message: "companyId가 필요합니다.",
          field: "companyId",
        },
      }, { status: 400 });
    }

    const access = await requireCompanyAccess({ companyId: body.companyId });
    const response = NextResponse.json<ActionResult<SwitchCompanyResult>>({
      ok: true,
      data: {
        currentCompanyId: access.companyId,
      },
    });
    writeSelectedCompanyId(response, access.companyId);
    return response;
  } catch (error) {
    return webActionError<SwitchCompanyResult>(error, {
      code: "company_switch_failed",
      message: "회사 전환에 실패했습니다.",
    });
  }
}

async function readBody(request: Request): Promise<SwitchCompanyRequest> {
  try {
    const parsed = await request.json() as SwitchCompanyRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
