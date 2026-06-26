import { appData, appErrorFromUnknown } from "@/lib/server/appApi/envelope";
import { requireAppSession } from "@/lib/server/auth/appSession";
import {
  invalidAuthRequest,
  revokeAppDeviceTokens,
  revokeAppRefreshToken,
} from "@/lib/server/auth/appIssueToken";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LogoutRequest {
  refreshToken?: string;
  allForDevice?: boolean;
}

export async function POST(request: Request) {
  try {
    const body = await readBody(request);
    if (body.refreshToken) {
      await revokeAppRefreshToken(body.refreshToken);
      return appData({ revoked: true });
    }
    if (!body.allForDevice) return invalidAuthRequest("refreshToken 또는 allForDevice가 필요합니다.");

    const session = await requireAppSession(request);
    await revokeAppDeviceTokens({
      userId: session.user.id,
      deviceId: session.deviceId,
    });
    return appData({ revoked: true });
  } catch (error) {
    return appErrorFromUnknown(error, "앱 로그아웃을 처리하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<LogoutRequest> {
  try {
    const parsed = await request.json() as LogoutRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
