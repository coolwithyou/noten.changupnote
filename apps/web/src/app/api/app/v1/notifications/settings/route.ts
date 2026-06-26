import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { appErrorFromUnknown, appNotImplemented } from "@/lib/server/appApi/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    await requireCompanyAccess();
    return appNotImplemented("알림 설정");
  } catch (error) {
    return appErrorFromUnknown(error, "알림 설정을 불러오지 못했습니다.");
  }
}

export async function PUT() {
  try {
    await requireCompanyAccess();
    return appNotImplemented("알림 설정 저장");
  } catch (error) {
    return appErrorFromUnknown(error, "알림 설정을 저장하지 못했습니다.");
  }
}
