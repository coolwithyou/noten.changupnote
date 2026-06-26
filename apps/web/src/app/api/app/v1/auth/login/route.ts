import { appData, appNotImplemented } from "@/lib/server/appApi/envelope";
import { invalidAuthRequest, issueAppTokens } from "@/lib/server/auth/appIssueToken";

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

  if (!isLoginAllowed()) {
    return appNotImplemented("앱 이메일/PW 로그인 검증기");
  }

  const userId = process.env.CUNOTE_MOCK_USER_ID ?? `email:${email}`;
  const tokenInput: Parameters<typeof issueAppTokens>[0] = {
    userId,
    email,
  };
  if (body.deviceId) tokenInput.deviceId = body.deviceId;
  const tokens = await issueAppTokens(tokenInput);
  return appData(tokens);
}

function isLoginAllowed(): boolean {
  return (
    process.env.CUNOTE_AUTH_MODE === "mock" ||
    process.env.CUNOTE_APP_AUTH_ALLOW_DEV_LOGIN === "true" ||
    process.env.NODE_ENV !== "production"
  );
}

async function readBody(request: Request): Promise<LoginRequest> {
  try {
    const parsed = await request.json() as LoginRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
