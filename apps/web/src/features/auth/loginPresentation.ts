import type { WebAuthProviderSummary } from "@/lib/server/auth/options";

export function selectVisibleLoginMethods(providers: WebAuthProviderSummary[]): {
  hasPassword: boolean;
  oauthProviders: WebAuthProviderSummary[];
} {
  return {
    hasPassword: providers.some((provider) => provider.id === "password"),
    // 서버가 실제 구성해 전달한 OAuth만 노출한다. 특정 브랜드 allowlist로
    // 이미 사용 중인 provider를 로그인 화면에서 숨기지 않는다.
    oauthProviders: providers.filter((provider) => provider.kind === "oauth"),
  };
}
