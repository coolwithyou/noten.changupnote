import { readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { pathToFileURL } from "node:url";

// Offline only. Never contacts a DB, uploads files, creates resources, or logs secret values.
export function verifyProductUatEnv(candidate, production) {
  const failures = [];
  const requireValue = (key, value) => { if (candidate[key] !== value) failures.push(`${key}: required safe value missing`); };
  const distinct = (key, min = 1) => {
    if (!candidate[key] || candidate[key].length < min) failures.push(`${key}: missing or too short`);
    else if (Object.values(production).includes(candidate[key])) failures.push(`${key}: production value reused`);
  };
  const dbIdentity = (value) => {
    try {
      const url = new URL(value);
      if (!["postgres:", "postgresql:"].includes(url.protocol)) return null;
      const ref = url.hostname.match(/^db\.([a-z0-9]+)\.supabase\.co$/)?.[1]
        ?? (/\.pooler\.supabase\.com$/.test(url.hostname) ? decodeURIComponent(url.username).match(/^postgres\.([a-z0-9]+)$/)?.[1] : undefined);
      if (ref) return `supabase:${ref}`;
      if (/supabase/.test(url.hostname)) return null;
      return `${url.hostname}:${url.port || "5432"}`; // Same cluster is not treated as isolated merely by changing DB/user.
    } catch { return null; }
  };
  const prodUrls = ["DATABASE_URL", "SUPABASE_DB_URL", "DIRECT_URL"].map((key) => production[key]).filter(Boolean);
  const prodIdentities = prodUrls.map(dbIdentity);
  if (!prodIdentities.length || prodIdentities.some((id) => !id)) failures.push("production database identity: unavailable");
  const database = dbIdentity(candidate.DATABASE_URL);
  if (!database || prodIdentities.includes(database)) failures.push("DATABASE_URL: isolated database identity required");
  for (const key of ["SUPABASE_DB_URL", "DIRECT_URL"]) {
    if (candidate[key] && dbIdentity(candidate[key]) !== database) failures.push(`${key}: inconsistent staging database`);
  }
  for (const key of ["R2_BUCKET", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"]) distinct(key);
  if (!/^[a-f0-9]{32}$/i.test(candidate.R2_ACCOUNT_ID ?? "")) failures.push("R2_ACCOUNT_ID: missing account identity");
  if (candidate.R2_BUCKET_URL) failures.push("R2_BUCKET_URL: public bucket URL is not used in private UAT");
  if (candidate.R2_ENDPOINT && candidate.R2_ENDPOINT !== `https://${candidate.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`) failures.push("R2_ENDPOINT: unexpected account endpoint");
  for (const key of ["NEXTAUTH_SECRET", "ADMIN_AUTH_SECRET"]) distinct(key, 32);
  if (candidate.NEXTAUTH_SECRET === candidate.ADMIN_AUTH_SECRET) failures.push("auth secrets: web/admin must be distinct");
  for (const [key, host] of [["NEXTAUTH_URL", "staging.changupnote.com"], ["ADMIN_AUTH_URL", "staging.ops.changupnote.com"]]) {
    try { const url = new URL(candidate[key]); if (url.protocol !== "https:" || url.hostname !== host || url.username || url.password) failures.push(`${key}: expected staging origin`); }
    catch { failures.push(`${key}: expected staging origin`); }
  }
  requireValue("CUNOTE_ENVIRONMENT", "uat");
  requireValue("CUNOTE_AUTH_REQUIRED", "true");
  requireValue("CUNOTE_REPOSITORY_ADAPTER", "drizzle");
  requireValue("CUNOTE_AUTH_DB_ADAPTER", "drizzle");
  if (candidate.CUNOTE_WEB_DATA_SOURCE === "sample") failures.push("CUNOTE_WEB_DATA_SOURCE: sample inventory is not database acceptance");
  requireValue("DEEP_ANALYSIS_WORKER_MODE", "observe_only");
  requireValue("APPLICATION_PRECOMPUTE_WORKER_MODE", "observe_only");
  requireValue("CUNOTE_SOURCE_CORRECTIONS_ENABLED", "true");
  for (const key of ["CUNOTE_DOCUMENT_AGENT_ENABLED", "CUNOTE_FIELD_EDITOR_AGENT_ENABLED", "CUNOTE_BILLING_AUTO_BILLING_ENABLED", "CUNOTE_BILLING_INVOICES_ENABLED"]) requireValue(key, "false");
  if (candidate.CUNOTE_AUTH_MODE === "mock" || candidate.CUNOTE_ADMIN_MODE === "mock") failures.push("mock authentication: forbidden");
  for (const [key, value] of Object.entries(candidate)) {
    if (value && /ANTHROPIC|OPENAI|GEMINI|XAI|CLAUDE|PORTONE|TOSS|STRIPE|EMAIL_WEBHOOK|SLACK_WEBHOOK|CRON_SECRET|INTERNAL_API_SECRET|POPBILL_API_KEY|APICK_API_KEY|PASS_API_KEY/.test(key)) failures.push(`${key}: external execution credential/config forbidden in initial UAT`);
    if (value && /SUPABASE.*(KEY|SECRET|URL)$/.test(key) && !/DB_URL$/.test(key)) failures.push(`${key}: not required for PostgreSQL/NextAuth UAT; omit to prevent alternate project access`);
  }
  return { ok: failures.length === 0, networkCalls: 0, writes: 0, failures,
    remainingChecks: ["R2 credential bucket restriction", "OAuth callbacks and designated accounts", "live environment injection", "database migrations and synthetic fixtures", "authenticated browser acceptance"] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const arg = (name) => process.argv.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
  const input = arg("--env"), reference = arg("--production-env");
  if (!input || !reference) throw new Error("Usage: node tools/verify-product-uat-env.mjs --env=<gitignored UAT file> --production-env=<existing production reference>");
  const result = verifyProductUatEnv(parseEnv(readFileSync(input, "utf8")), parseEnv(readFileSync(reference, "utf8")));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}
