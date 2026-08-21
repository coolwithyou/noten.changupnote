import type { ActionResult } from "@cunote/contracts";
import { NextResponse } from "next/server";
import type {
  ApplicationAutofillProfile,
  ApplicationAutofillProfileInput,
} from "@/lib/documents/applicationProfileAutofill";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { webActionError } from "@/lib/server/auth/webActionError";
import {
  loadApplicationAutofillProfile,
  saveApplicationAutofillProfile,
} from "@/lib/server/documents/applicationAutofillProfile";
import { getGrantDocumentDraft } from "@/lib/server/documents/grantDocumentDrafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ draftId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const { draftId } = await context.params;
    const access = await requireCompanyAccess();
    await getGrantDocumentDraft({ draftId, access });
    const profile = await loadApplicationAutofillProfile(access);
    return NextResponse.json<ActionResult<ApplicationAutofillProfile>>({ ok: true, data: profile });
  } catch (error) {
    return webActionError<ApplicationAutofillProfile>(error, {
      code: "application_profile_load_failed",
      message: "신청서 등록정보를 불러오지 못했습니다.",
    });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const [{ draftId }, access, body] = await Promise.all([
      context.params,
      requireCompanyAccess({ permission: "write" }),
      readBody(request),
    ]);
    await getGrantDocumentDraft({ draftId, access });
    const profile = await saveApplicationAutofillProfile({
      access,
      profile: body,
    });
    return NextResponse.json<ActionResult<ApplicationAutofillProfile>>({ ok: true, data: profile });
  } catch (error) {
    return webActionError<ApplicationAutofillProfile>(error, {
      code: "application_profile_save_failed",
      message: "신청서 등록정보를 저장하지 못했습니다.",
    });
  }
}

async function readBody(request: Request): Promise<ApplicationAutofillProfileInput> {
  try {
    const parsed = await request.json() as unknown;
    return parsed as ApplicationAutofillProfileInput;
  } catch {
    return null as unknown as ApplicationAutofillProfileInput;
  }
}
