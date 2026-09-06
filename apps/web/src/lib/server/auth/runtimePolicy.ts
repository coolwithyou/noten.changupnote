/** 배포된 제품에서는 개발 인증 플래그로 실제 사용자 인증을 우회할 수 없다. */
export function isDevelopmentAuthAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "production" && env.VERCEL_ENV !== "production";
}

export function isAuthEnforced(env: NodeJS.ProcessEnv = process.env): boolean {
  return !isDevelopmentAuthAllowed(env) || env.CUNOTE_AUTH_REQUIRED === "true";
}

export function isMockAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isDevelopmentAuthAllowed(env) && env.CUNOTE_AUTH_MODE === "mock";
}
