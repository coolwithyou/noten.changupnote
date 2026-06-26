import { appData, appErrorFromUnknown, appNotImplemented } from "@/lib/server/appApi/envelope";
import {
  type AppOAuthExchangeInput,
  isAppOAuthExchangeAllowed,
  issueDevAppOAuthTokens,
} from "@/lib/server/auth/appOAuth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ provider: string }>;
}

interface OAuthExchangeRequest {
  code?: string;
  codeVerifier?: string;
  redirectUri?: string;
  deviceId?: string;
}

export async function POST(request: Request, context: RouteContext) {
  if (!isAppOAuthExchangeAllowed()) {
    return appNotImplemented("앱 OAuth code 검증 및 토큰 교환");
  }

  try {
    const [{ provider }, body] = await Promise.all([context.params, readBody(request)]);
    const exchangeInput: AppOAuthExchangeInput = { provider };
    if (body.code !== undefined) exchangeInput.code = body.code;
    if (body.codeVerifier !== undefined) exchangeInput.codeVerifier = body.codeVerifier;
    if (body.redirectUri !== undefined) exchangeInput.redirectUri = body.redirectUri;
    if (body.deviceId !== undefined) exchangeInput.deviceId = body.deviceId;
    const tokens = await issueDevAppOAuthTokens(exchangeInput);
    return appData(tokens);
  } catch (error) {
    return appErrorFromUnknown(error, "앱 OAuth 토큰 교환을 처리하지 못했습니다.");
  }
}

async function readBody(request: Request): Promise<OAuthExchangeRequest> {
  try {
    const parsed = await request.json() as OAuthExchangeRequest;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
