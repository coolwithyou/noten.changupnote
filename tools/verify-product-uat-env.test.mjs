import assert from "node:assert/strict";
import { verifyProductUatEnv } from "./verify-product-uat-env.mjs";
const production = { DATABASE_URL: "postgres://postgres:fixture@db.productionref.supabase.co/postgres", R2_BUCKET: "production-bucket", NEXTAUTH_SECRET: "production-secret" };
const candidate = {
  R2_ACCOUNT_ID: "a".repeat(32), CUNOTE_REPOSITORY_ADAPTER: "drizzle", CUNOTE_AUTH_DB_ADAPTER: "drizzle",
  DATABASE_URL: "postgres://postgres:fixture@db.uatref.supabase.co/postgres", R2_BUCKET: "cunote-product-uat", R2_ACCESS_KEY_ID: "isolated-key", R2_SECRET_ACCESS_KEY: "isolated-secret",
  GOOGLE_CLIENT_ID: "uat-client", GOOGLE_CLIENT_SECRET: "uat-client-secret", NEXTAUTH_SECRET: "web-test-secret-".repeat(3), ADMIN_AUTH_SECRET: "admin-test-secret-".repeat(3),
  NEXTAUTH_URL: "https://staging.changupnote.com", ADMIN_AUTH_URL: "https://staging.ops.changupnote.com", CUNOTE_ENVIRONMENT: "uat", CUNOTE_AUTH_REQUIRED: "true",
  DEEP_ANALYSIS_WORKER_MODE: "observe_only", APPLICATION_PRECOMPUTE_WORKER_MODE: "observe_only", CUNOTE_SOURCE_CORRECTIONS_ENABLED: "true",
  CUNOTE_DOCUMENT_AGENT_ENABLED: "false", CUNOTE_FIELD_EDITOR_AGENT_ENABLED: "false", CUNOTE_BILLING_AUTO_BILLING_ENABLED: "false", CUNOTE_BILLING_INVOICES_ENABLED: "false",
};
assert.equal(verifyProductUatEnv(candidate, production).ok, true);
for (const unsafe of [
  { DATABASE_URL: production.DATABASE_URL },
  { DATABASE_URL: "postgres://postgres.productionref:fixture@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres" },
  { DIRECT_URL: production.DATABASE_URL }, { R2_BUCKET: production.R2_BUCKET }, { NEXTAUTH_SECRET: production.NEXTAUTH_SECRET },
  { ANTHROPIC_API_KEY: "fixture" }, { CUNOTE_AUTH_MODE: "mock" }, { CUNOTE_EMAIL_WEBHOOK_URL: "https://example.invalid" },
  { SUPABASE_SERVICE_ROLE_KEY: "fixture" }, { ADMIN_AUTH_URL: "https://ops.changupnote.com" },
  { CUNOTE_REPOSITORY_ADAPTER: "runtime" }, { R2_ACCOUNT_ID: "" }, { R2_BUCKET_URL: "https://example.invalid" },
  { CUNOTE_AUTH_DB_ADAPTER: "" },
]) assert.equal(verifyProductUatEnv({ ...candidate, ...unsafe }, production).ok, false);
assert.equal(verifyProductUatEnv(candidate, {}).ok, false);
console.log("product UAT environment: isolated identities, production reuse and external execution gates passed");
