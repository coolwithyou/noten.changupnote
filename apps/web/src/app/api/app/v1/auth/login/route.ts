import { appData, appNotImplemented, invalidAuthRequest } from "@/lib/server/appApi/envelope";
import { issueAppTokens } from "@/lib/server/auth/appIssueToken";
import { mockUserId } from "@/lib/server/auth/mockIdentity";
import { isDevelopmentAuthAllowed } from "@/lib/server/auth/runtimePolicy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface LoginRequest {
  email?: string;
  password?: string;
  deviceId?: string;
}

export async function POST(request: Request) {
  const body = await readBody(request);
  const email = body.email?.trim().toLowerCase();
  if (!email) return invalidAuthRequest("이메일이 필요합니다.", "email");

  if (!isDevelopmentAuthAllowed()) {
    return appNotImplemented("앱 이메일/PW 로그인 검증기");
  }

  const userId = mockUserId();
  const tokenInput: Parameters<typeof issueAppTokens>[0] = {
    userId,
    email,
  };
  if (body.deviceId) tokenInput.deviceId = body.deviceId;
  const tokens = await issueAppTokens(tokenInput);
  return appData(tokens);
}

async function readBody(request: Request): Promise<LoginRequest> {
  try {
    const parsed = await request.json() as LoginRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
