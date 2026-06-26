import { appErrorFromUnknown, appNotImplemented } from "@/lib/server/appApi/envelope";
import { requireAppSession } from "@/lib/server/auth/appSession";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    await requireAppSession(request);
    return appNotImplemented("기기 등록");
  } catch (error) {
    return appErrorFromUnknown(error, "기기를 등록하지 못했습니다.");
  }
}
