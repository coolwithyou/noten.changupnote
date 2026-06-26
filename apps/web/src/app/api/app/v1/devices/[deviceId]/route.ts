import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { appErrorFromUnknown, appNotImplemented } from "@/lib/server/appApi/envelope";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE() {
  try {
    await requireCompanyAccess();
    return appNotImplemented("기기 삭제");
  } catch (error) {
    return appErrorFromUnknown(error, "기기를 삭제하지 못했습니다.");
  }
}
