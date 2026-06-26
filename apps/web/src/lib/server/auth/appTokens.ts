import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export type AppTokenType = "access" | "refresh";

export interface AppTokenClaims {
  sub: string;
  typ: AppTokenType;
  jti: string;
  deviceId: string;
  email?: string | null;
  iat: number;
  exp: number;
}

export interface AppTokenPair {
  accessToken: string;
  refreshToken: string;
  access: AppTokenClaims;
  refresh: AppTokenClaims;
  expiresIn: number;
}

const DEFAULT_ACCESS_TTL_SECONDS = 15 * 60;
const DEFAULT_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

export function createAppTokenPair(input: {
  userId: string;
  deviceId: string;
  email?: string | null;
  now?: Date;
}): AppTokenPair {
  const issuedAt = Math.floor((input.now?.getTime() ?? Date.now()) / 1000);
  const accessTtl = readTtl("APP_ACCESS_TOKEN_TTL_SECONDS", DEFAULT_ACCESS_TTL_SECONDS);
  const refreshTtl = readTtl("APP_REFRESH_TOKEN_TTL_SECONDS", DEFAULT_REFRESH_TTL_SECONDS);

  const access: AppTokenClaims = {
    sub: input.userId,
    typ: "access",
    jti: randomUUID(),
    deviceId: input.deviceId,
    email: input.email ?? null,
    iat: issuedAt,
    exp: issuedAt + accessTtl,
  };
  const refresh: AppTokenClaims = {
    sub: input.userId,
    typ: "refresh",
    jti: randomUUID(),
    deviceId: input.deviceId,
    email: input.email ?? null,
    iat: issuedAt,
    exp: issuedAt + refreshTtl,
  };

  return {
    accessToken: signAppJwt(access),
    refreshToken: signAppJwt(refresh),
    access,
    refresh,
    expiresIn: accessTtl,
  };
}

export function verifyAppJwt(token: string, expectedType?: AppTokenType): AppTokenClaims {
  const [rawHeader, rawPayload, signature] = token.split(".");
  if (!rawHeader || !rawPayload || !signature) {
    throw new Error("토큰 형식이 올바르지 않습니다.");
  }

  const expected = sign(`${rawHeader}.${rawPayload}`);
  if (!safeEqual(signature, expected)) {
    throw new Error("토큰 서명이 올바르지 않습니다.");
  }

  const header = JSON.parse(base64UrlDecode(rawHeader).toString("utf8")) as { alg?: string };
  if (header.alg !== "HS256") {
    throw new Error("지원하지 않는 토큰 알고리즘입니다.");
  }

  const payload = JSON.parse(base64UrlDecode(rawPayload).toString("utf8")) as AppTokenClaims;
  if (expectedType && payload.typ !== expectedType) {
    throw new Error("토큰 종류가 올바르지 않습니다.");
  }
  if (!payload.sub || !payload.jti || !payload.deviceId || !payload.exp) {
    throw new Error("토큰 클레임이 부족합니다.");
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new Error("토큰이 만료되었습니다.");
  }
  return payload;
}

export function hashAppToken(token: string): string {
  return createHmac("sha256", getTokenSecret()).update(token).digest("hex");
}

export function generateDeviceId(): string {
  return `device_${randomBytes(12).toString("hex")}`;
}

function signAppJwt(payload: AppTokenClaims): string {
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(payload));
  const unsigned = `${header}.${body}`;
  return `${unsigned}.${sign(unsigned)}`;
}

function sign(value: string): string {
  return createHmac("sha256", getTokenSecret()).update(value).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function base64UrlEncode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function base64UrlDecode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}

function getTokenSecret(): string {
  const secret = process.env.JWT_SECRET ?? process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV !== "production") return "cunote-dev-token-secret";
  throw new Error("JWT_SECRET 또는 NEXTAUTH_SECRET이 필요합니다.");
}

function readTtl(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}
