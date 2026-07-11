/**
 * CODEF 환경설정 로더 — 환경변수에서 자격증명을 읽어 파생 URL과 함께 반환한다.
 *
 * 필수: CODEF_CLIENT_ID / CODEF_CLIENT_SECRET / CODEF_PUBLIC_KEY.
 * 선택: CODEF_ENVIRONMENT("demo" | "production"). 미지정/오타 시 데모로 폴백한다
 *       (운영 자격증명이 실수로 데모 URL로 새지 않도록 안전측 기본값=데모).
 * 토큰 URL은 환경과 무관하게 https://oauth.codef.io/oauth/token 고정.
 */

import type { CodefEnvConfig, CodefEnvironment } from "./types.js";

/** 토큰 발급 엔드포인트(환경 무관 고정). */
export const CODEF_TOKEN_URL = "https://oauth.codef.io/oauth/token";
/** 데모(개발) 상품 API base. */
export const CODEF_DEMO_API_BASE = "https://development.codef.io";
/** 운영 상품 API base. */
export const CODEF_PRODUCTION_API_BASE = "https://api.codef.io";

/** 환경설정 로딩 실패(필수 변수 누락 등). */
export class CodefEnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodefEnvError";
  }
}

/**
 * 환경변수에서 CODEF 설정을 읽는다. 필수 변수가 하나라도 없으면 어떤 변수가
 * 비었는지 명시해 CodefEnvError 를 던진다.
 */
export function readCodefEnvConfig(env: NodeJS.ProcessEnv = process.env): CodefEnvConfig {
  const clientId = env.CODEF_CLIENT_ID?.trim() ?? "";
  const clientSecret = env.CODEF_CLIENT_SECRET?.trim() ?? "";
  const publicKey = env.CODEF_PUBLIC_KEY?.trim() ?? "";

  const missing: string[] = [];
  if (!clientId) missing.push("CODEF_CLIENT_ID");
  if (!clientSecret) missing.push("CODEF_CLIENT_SECRET");
  if (!publicKey) missing.push("CODEF_PUBLIC_KEY");
  if (missing.length > 0) {
    throw new CodefEnvError(`CODEF 환경변수 누락: ${missing.join(", ")}`);
  }

  const environment = resolveEnvironment(env.CODEF_ENVIRONMENT);
  const apiBaseUrl =
    environment === "production" ? CODEF_PRODUCTION_API_BASE : CODEF_DEMO_API_BASE;

  return {
    clientId,
    clientSecret,
    publicKey,
    environment,
    apiBaseUrl,
    tokenUrl: CODEF_TOKEN_URL,
  };
}

/** CODEF_ENVIRONMENT 값을 해석한다. "production"만 운영, 그 외(미지정/오타)는 데모로 폴백. */
export function resolveEnvironment(value: string | undefined): CodefEnvironment {
  return value?.trim().toLowerCase() === "production" ? "production" : "demo";
}
