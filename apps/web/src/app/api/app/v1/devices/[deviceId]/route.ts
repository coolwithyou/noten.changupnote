import { appErrorFromUnknown, appNotImplemented } from "@/lib/server/appApi/envelope";
import { requireAppSession } from "@/lib/server/auth/appSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request) {
  try {
    await requireAppSession(request);
    return appNotImplemented("기기 삭제");
  } catch (error) {
    return appErrorFromUnknown(error, "기기를 삭제하지 못했습니다.");
  }
}
