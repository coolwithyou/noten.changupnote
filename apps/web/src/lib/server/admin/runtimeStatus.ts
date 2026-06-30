import { getWebAuthProviderSummaries } from "@/lib/server/auth/options";
import { isAuthEnforced } from "@/lib/server/auth/session";
import { buildLegalReadiness, type LegalReadiness } from "@/lib/server/legal/legalReadiness";
import { getRepositoryAdapterName, type RepositoryAdapterName } from "@/lib/server/repositories/factory";
import { buildSaasReadiness, type SaasReadiness } from "@/lib/server/saas/readiness";

export interface AdminRuntimeStatus {
  repositoryAdapter: RepositoryAdapterName;
  webDataSource: "auto" | "sample" | "live";
  authRequired: boolean;
  authMode: "mock" | "nextauth";
  authProviders: string[];
  databaseConfigured: boolean;
  legalReadiness: LegalReadiness;
  saasReadiness: SaasReadiness;
}

export function getAdminRuntimeStatus(env: NodeJS.ProcessEnv = process.env): AdminRuntimeStatus {
  return {
    repositoryAdapter: getRepositoryAdapterName(env),
    webDataSource: readWebDataSource(env),
    authRequired: isAuthEnforced(env),
    authMode: env.CUNOTE_AUTH_MODE === "mock" ? "mock" : "nextauth",
    authProviders: getWebAuthProviderSummaries(env).map((provider) => provider.id),
    databaseConfigured: Boolean(env.DATABASE_URL || env.SUPABASE_DB_URL),
    legalReadiness: buildLegalReadiness(env),
    saasReadiness: buildSaasReadiness(env),
  };
}

function readWebDataSource(env: NodeJS.ProcessEnv): AdminRuntimeStatus["webDataSource"] {
  const value = env.CUNOTE_WEB_DATA_SOURCE?.trim().toLowerCase();
  if (value === "sample" || value === "live") return value;
  return "auto";
}
