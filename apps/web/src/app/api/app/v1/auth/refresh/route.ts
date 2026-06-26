import { appData, appErrorFromUnknown, invalidAuthRequest } from "@/lib/server/appApi/envelope";
import { rotateAppRefreshToken } from "@/lib/server/auth/appIssueToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RefreshRequest {
  refreshToken?: string;
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    if (!body.refreshToken) return invalidAuthRequest("refreshToken이 필요합니다.", "refreshToken");
    const tokens = await rotateAppRefreshToken(body.refreshToken);
    return appData(tokens);
  } catch (error) {
    return appErrorFromUnknown(error, "앱 토큰을 갱신하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<RefreshRequest> {
  try {
    const parsed = await request.json() as RefreshRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
