import { appError } from "@/lib/server/appApi/envelope";
import { demoCompanyId } from "@/lib/server/repositories/runtime";
import { getServiceRepositories } from "@/lib/server/serviceData";
import {
  CompanyAccessForbiddenError,
  resolveCompanyAccessFromRecords,
  type CompanyAccessPermission,
} from "./companyAccessPolicy";
import { verifyAppJwt } from "./appTokens";
import { mockUserEmail, mockUserId } from "./mockIdentity";

export interface AppSession {
  user: {
    id: string;
    email?: string | null;
  };
  deviceId: string;
  mode: "token" | "demo";
}

export class AppAuthError extends Error {
  readonly status = 401;
  readonly code = "app_auth_required";

  constructor(message = "앱 인증 토큰이 필요합니다.") {
    super(message);
    this.name = "AppAuthError";
  }
}

export interface AppCompanyAccess {
  companyId: string;
  userId: string;
  deviceId: string;
  mode: AppSession["mode"];
}

export async function requireAppSession(request: Request): Promise<AppSession> {
  const authorization = request.headers.get("authorization");
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) {
    const payload = verifyAppJwt(token, "access");
    return {
      user: {
        id: payload.sub,
        email: payload.email ?? null,
      },
      deviceId: payload.deviceId,
      mode: "token",
    };
  }

  if (process.env.CUNOTE_AUTH_REQUIRED === "true") throw new AppAuthError();

  return {
    user: {
      id: mockUserId(),
      email: mockUserEmail(),
    },
    deviceId: "demo-device",
    mode: "demo",
  };
}

export async function requireAppCompanyAccess(
  request: Request,
  companyId = demoCompanyId(),
  options: { permission?: CompanyAccessPermission } = {},
): Promise<AppCompanyAccess> {
  const session = await requireAppSession(request);
  if (session.mode === "demo") {
    const defaultCompanyId = demoCompanyId();
    if (companyId !== defaultCompanyId) throw new CompanyAccessForbiddenError();
    return {
      companyId: defaultCompanyId,
      userId: session.user.id,
      deviceId: session.deviceId,
      mode: session.mode,
    };
  }

  const companies = await getServiceRepositories().companies.listUserCompanies(session.user.id);
  const access = resolveCompanyAccessFromRecords({
    companies,
    userId: session.user.id,
    mode: session.mode,
    companyId,
    ...(options.permission ? { permission: options.permission } : {}),
  });
  return {
    companyId: access.companyId,
    userId: session.user.id,
    deviceId: session.deviceId,
    mode: session.mode,
  };
}

export function appAuthErrorResponse(error: unknown) {
  if (error instanceof AppAuthError) return appError(error.code, error.message, error.status);
  if (error instanceof Error && /토큰/.test(error.message)) return appError("invalid_token", error.message, 401);
  return null;
}
