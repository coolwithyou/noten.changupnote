import { appErrorFromUnknown, appNotImplemented } from "@/lib/server/appApi/envelope";
import { requireAppSession } from "@/lib/server/auth/appSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    await requireAppSession(request);
    return appNotImplemented("알림 설정");
  } catch (error) {
    return appErrorFromUnknown(error, "알림 설정을 불러오지 못했습니다.");
  }
}

export async function PUT(request: Request) {
  try {
    await requireAppSession(request);
    return appNotImplemented("알림 설정 저장");
  } catch (error) {
    return appErrorFromUnknown(error, "알림 설정을 저장하지 못했습니다.");
  }
}
