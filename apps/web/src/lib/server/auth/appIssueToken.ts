import { appError } from "@/lib/server/appApi/envelope";
import {
  createAppTokenPair,
  generateDeviceId,
  hashAppToken,
  verifyAppJwt,
} from "./appTokens";
import { getAppRefreshTokenStore } from "./appRefreshTokenStore";

export interface AppTokenResponse {
  tokenType: "Bearer";
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresAt: string;
  deviceId: string;
  user: {
    id: string;
    email?: string | null;
  };
}

export async function issueAppTokens(input: {
  userId: string;
  email?: string | null;
  deviceId?: string;
  rotatedFrom?: string | null;
}): Promise<AppTokenResponse> {
  const deviceId = input.deviceId || generateDeviceId();
  const pair = createAppTokenPair({
    userId: input.userId,
    email: input.email ?? null,
    deviceId,
  });
  await getAppRefreshTokenStore().save({
    id: pair.refresh.jti,
    userId: input.userId,
    tokenHash: hashAppToken(pair.refreshToken),
    deviceId,
    expiresAt: new Date(pair.refresh.exp * 1000),
    rotatedFrom: input.rotatedFrom ?? null,
  });

  return {
    tokenType: "Bearer",
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    expiresIn: pair.expiresIn,
    refreshExpiresAt: new Date(pair.refresh.exp * 1000).toISOString(),
    deviceId,
    user: {
      id: input.userId,
      email: input.email ?? null,
    },
  };
}

export async function rotateAppRefreshToken(refreshToken: string): Promise<AppTokenResponse> {
  const payload = verifyAppJwt(refreshToken, "refresh");
  const hash = hashAppToken(refreshToken);
  const store = getAppRefreshTokenStore();
  const stored = await store.findActiveByHash(hash);
  if (!stored || stored.id !== payload.jti || stored.userId !== payload.sub) {
    throw new Error("refresh token이 유효하지 않습니다.");
  }

  await store.revoke(stored.id);
  return issueAppTokens({
    userId: payload.sub,
    email: payload.email ?? null,
    deviceId: payload.deviceId,
    rotatedFrom: stored.id,
  });
}

export async function revokeAppRefreshToken(refreshToken: string): Promise<void> {
  const payload = verifyAppJwt(refreshToken, "refresh");
  const stored = await getAppRefreshTokenStore().findActiveByHash(hashAppToken(refreshToken));
  if (stored && stored.id === payload.jti) await getAppRefreshTokenStore().revoke(stored.id);
}

export async function revokeAppDeviceTokens(input: {
  userId: string;
  deviceId: string;
}): Promise<void> {
  await getAppRefreshTokenStore().revokeDevice(input.userId, input.deviceId);
}

export function invalidAuthRequest(message: string, field?: string) {
  return appError("invalid_auth_request", message, 400, field);
}
