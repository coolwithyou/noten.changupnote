import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationPath = "db/migrations/0003_rls_company_scope.sql";
const adminRoleMigrationPath = "db/migrations/0004_company_role_admin.sql";
const profileScopeMigrationPath = "db/migrations/0034_sturdy_boom_boom.sql";
const journalPath = "db/migrations/meta/_journal.json";
const schemaPath = "apps/web/src/lib/server/db/schema.ts";

const migration = readFileSync(resolve(process.cwd(), migrationPath), "utf8");
const adminRoleMigration = readFileSync(resolve(process.cwd(), adminRoleMigrationPath), "utf8");
const profileScopeMigration = readFileSync(resolve(process.cwd(), profileScopeMigrationPath), "utf8");
const journal = readFileSync(resolve(process.cwd(), journalPath), "utf8");
const schema = readFileSync(resolve(process.cwd(), schemaPath), "utf8");

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
if (!journal.includes('"tag": "0004_company_role_admin"')) {
  errors.push(`${journalPath} is missing 0004_company_role_admin`);
}
if (!journal.includes('"tag": "0034_sturdy_boom_boom"')) {
  errors.push(`${journalPath} is missing 0034_sturdy_boom_boom`);
}

requireAdminRolePattern(`ALTER TYPE "company_role" ADD VALUE IF NOT EXISTS 'admin' BEFORE 'member'`, "admin company_role migration");
requireAdminRolePattern(`"role"::text IN ('owner', 'admin', 'member')`, "admin writer role policy");
if (!schema.includes(`pgEnum("company_role", ["owner", "admin", "member", "viewer"])`)) {
  errors.push(`${schemaPath} is missing admin company_role enum value`);
}
requireProfileScopePattern(`ALTER TABLE "company_profiles" ADD COLUMN "user_id" uuid`, "company_profiles user_id column");
requireProfileScopePattern(`"company_profiles"."source" = 'self_declared'`, "self declared profile migration");
requireProfileScopePattern(`"company_profiles"."user_id" IS NULL`, "shared profile select scope");
requireProfileScopePattern(`"company_profiles"."user_id" = "app_private"."current_user_id"()`, "personal profile write scope");
if (!schema.includes(`userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" })`)) {
  errors.push(`${schemaPath} is missing company_profiles.user_id`);
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

function requireAdminRolePattern(pattern: string, label: string) {
  if (!adminRoleMigration.includes(pattern)) errors.push(`${adminRoleMigrationPath} is missing ${label}`);
}

function requireProfileScopePattern(pattern: string, label: string) {
  if (!profileScopeMigration.includes(pattern)) errors.push(`${profileScopeMigrationPath} is missing ${label}`);
}
