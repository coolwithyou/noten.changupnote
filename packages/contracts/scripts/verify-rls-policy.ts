import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationPath = "db/migrations/0003_rls_company_scope.sql";
const journalPath = "db/migrations/meta/_journal.json";

const migration = readFileSync(resolve(process.cwd(), migrationPath), "utf8");
const journal = readFileSync(resolve(process.cwd(), journalPath), "utf8");

const protectedTables = [
  "companies",
  "user_company",
  "company_profiles",
  "consents",
  "app_refresh_tokens",
  "app_devices",
  "notification_settings",
  "match_state",
  "match_events",
];

const requiredPolicies = [
  "companies_member_select",
  "companies_creator_insert",
  "companies_writer_update",
  "user_company_self_select",
  "user_company_creator_insert",
  "company_profiles_member_select",
  "company_profiles_writer_write",
  "consents_self_select",
  "consents_self_write",
  "app_refresh_tokens_self",
  "app_devices_self",
  "notification_settings_self",
  "match_state_member",
  "match_events_member",
];

const errors: string[] = [];

for (const table of protectedTables) {
  requirePattern(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`, `${table} RLS enable`);
  requirePattern(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, `${table} RLS force`);
}

for (const policy of requiredPolicies) {
  requirePattern(`CREATE POLICY "${policy}"`, `${policy} policy`);
}

requirePattern("current_setting('app.current_user_id', true)", "app.current_user_id session setting");
requirePattern('"app_private"."current_user_id"', "current user helper");

if (!journal.includes('"tag": "0003_rls_company_scope"')) {
  errors.push(`${journalPath} is missing 0003_rls_company_scope`);
}

if (errors.length > 0) {
  console.error("RLS policy verification failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log("RLS policy verification passed.");

function requirePattern(pattern: string, label: string) {
  if (!migration.includes(pattern)) errors.push(`${migrationPath} is missing ${label}`);
}
