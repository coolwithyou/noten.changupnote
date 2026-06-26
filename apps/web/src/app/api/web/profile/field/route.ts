import type { ActionResult, CompanyProfile, CriterionDimension } from "@cunote/contracts";
import { updateCompanyProfileField } from "@cunote/core";
import { NextResponse } from "next/server";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import { getServiceRepositories } from "@/lib/server/serviceData";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ProfileFieldRequest {
  field?: CriterionDimension;
  value?: unknown;
  confidence?: number | null;
}

interface ProfileFieldResult {
  profile: CompanyProfile;
}

export async function POST(request: Request) {
  try {
    const [access, body] = await Promise.all([requireCompanyAccess({ permission: "write" }), readBody(request)]);
    if (!body.field) {
      return NextResponse.json<ActionResult<ProfileFieldResult>>({
        ok: false,
        error: {
          code: "invalid_profile_field",
          message: "field가 필요합니다.",
          field: "field",
        },
      }, { status: 400 });
    }

    const current = await getServiceRepositories().companies.resolveCompanyProfile({
      companyId: access.companyId,
    });
    if (!current) {
      return NextResponse.json<ActionResult<ProfileFieldResult>>({
        ok: false,
        error: {
          code: "company_not_found",
          message: "회사를 찾지 못했습니다.",
          field: "companyId",
        },
      }, { status: 404 });
    }

    const profile = updateCompanyProfileField(current, {
      field: body.field,
      value: body.value,
      confidence: body.confidence ?? null,
    });
    const saved = await getServiceRepositories().companies.saveCompanyProfile({
      companyId: access.companyId,
      userId: access.userId,
      profile,
    });

    return NextResponse.json<ActionResult<ProfileFieldResult>>({
      ok: true,
      data: { profile: saved },
    });
  } catch (error) {
    return webActionError<ProfileFieldResult>(error, {
      code: "profile_field_failed",
      message: "회사 프로필 입력을 저장하지 못했습니다.",
    });
  }
}

async function readBody(request: Request): Promise<ProfileFieldRequest> {
  try {
    const parsed = await request.json() as ProfileFieldRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
