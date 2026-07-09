import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const migrationPath = "db/migrations/0003_rls_company_scope.sql";
const adminRoleMigrationPath = "db/migrations/0004_company_role_admin.sql";
const profileScopeMigrationPath = "db/migrations/0034_sturdy_boom_boom.sql";
const creditMigrationPath = "db/migrations/0038_yielding_leader.sql";
const journalPath = "db/migrations/meta/_journal.json";
const schemaPath = "apps/web/src/lib/server/db/schema.ts";

const migration = readFileSync(resolve(process.cwd(), migrationPath), "utf8");
const adminRoleMigration = readFileSync(resolve(process.cwd(), adminRoleMigrationPath), "utf8");
const profileScopeMigration = readFileSync(resolve(process.cwd(), profileScopeMigrationPath), "utf8");
const creditMigration = readFileSync(resolve(process.cwd(), creditMigrationPath), "utf8");
const journal = readFileSync(resolve(process.cwd(), journalPath), "utf8");
const schema = readFileSync(resolve(process.cwd(), schemaPath), "utf8");

// 크레딧 시스템 (설계 4.13). BYPASSRLS 실측 → ENABLE + FORCE 전 테이블.
const creditProtectedTables = [
  "credit_wallets",
  "credit_lots",
  "credit_ledger",
  "credit_holds",
  "usage_events",
  "credit_payment_orders",
  "credit_plan_subscriptions",
  "credit_audit_logs",
  "portone_webhook_events",
  "credit_reconciliation_runs",
  "credit_settings",
  "credit_pricing_rules",
  "credit_products",
  "credit_plans",
];

const creditRequiredPolicies = [
  "credit_wallets_self_select",
  "credit_lots_self_select",
  "credit_ledger_self_select",
  "credit_holds_self_select",
  "usage_events_self_select",
  "credit_payment_orders_self_select",
  "credit_plan_subscriptions_self_select",
  "credit_products_active_select",
  "credit_plans_active_select",
];

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

// 크레딧 시스템 (4.13): 전 테이블 ENABLE + FORCE, self-select 정책, append-only 트리거.
for (const table of creditProtectedTables) {
  requireCreditPattern(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`, `${table} RLS enable`);
  requireCreditPattern(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`, `${table} RLS force`);
}
for (const policy of creditRequiredPolicies) {
  requireCreditPattern(`CREATE POLICY "${policy}"`, `${policy} policy`);
}
requireCreditPattern('CREATE TRIGGER "credit_ledger_no_update"', "credit_ledger append-only trigger");
requireCreditPattern('CREATE TRIGGER "credit_audit_logs_no_update"', "credit_audit_logs append-only trigger");
requireCreditPattern('"app_private"."reject_mutation"', "reject_mutation function");
requireCreditPattern("credit_plan_subs_one_active", "credit plan one-active partial unique index");
requireCreditPattern("credit_ledger_reversal_of_entry_uidx", "credit reversal partial unique index");
requireCreditPattern("credit_wallets_balance_nonneg", "credit wallet balance CHECK");
requireCreditPattern("credit_lots_remaining_bounds", "credit lot remaining CHECK");
if (!journal.includes('"tag": "0038_yielding_leader"')) {
  errors.push(`${journalPath} is missing 0038_yielding_leader`);
}

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

function requireCreditPattern(pattern: string, label: string) {
  if (!creditMigration.includes(pattern)) errors.push(`${creditMigrationPath} is missing ${label}`);
}
