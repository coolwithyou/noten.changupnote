import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { appErrorFromUnknown, appNotImplemented } from "@/lib/server/appApi/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  try {
    await requireCompanyAccess();
    return appNotImplemented("기기 등록");
  } catch (error) {
    return appErrorFromUnknown(error, "기기를 등록하지 못했습니다.");
  }
}
