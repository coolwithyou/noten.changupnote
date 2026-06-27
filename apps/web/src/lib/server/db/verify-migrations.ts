import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_TABLES, RLS_TABLES } from "./requirements";

const MIGRATION_DIR = "db/migrations";
const MIGRATION_META_DIR = join(MIGRATION_DIR, "meta");
const SCHEMA_PATH = "apps/web/src/lib/server/db/schema.ts";
const migrationFiles = readdirSync(MIGRATION_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();
assert.ok(migrationFiles.length > 0, "Drizzle migration SQL files should exist");
const snapshotFiles = readdirSync(MIGRATION_META_DIR)
  .filter((file) => file.endsWith("_snapshot.json"))
  .sort();
assert.ok(snapshotFiles.length > 0, "Drizzle migration snapshots should exist");

const migrationSql = migrationFiles
  .map((file) => readFileSync(join(MIGRATION_DIR, file), "utf8"))
  .join("\n");

const missingTables = REQUIRED_TABLES.filter((table) =>
  !migrationSql.includes(`CREATE TABLE "${table}"`)
);
const missingRlsEnable = RLS_TABLES.filter((table) =>
  !migrationSql.includes(`ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY`)
);
const missingRlsForce = RLS_TABLES.filter((table) =>
  !migrationSql.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)
);

assert.deepEqual(missingTables, [], `missing CREATE TABLE migrations: ${missingTables.join(", ")}`);
assert.deepEqual(missingRlsEnable, [], `missing RLS ENABLE migrations: ${missingRlsEnable.join(", ")}`);
assert.deepEqual(missingRlsForce, [], `missing RLS FORCE migrations: ${missingRlsForce.join(", ")}`);

const latestSnapshotFile = snapshotFiles.at(-1);
assert.ok(latestSnapshotFile, "latest Drizzle snapshot should exist");
const latestSnapshotPath = join(MIGRATION_META_DIR, latestSnapshotFile);
assert.ok(existsSync(latestSnapshotPath), `missing latest Drizzle snapshot: ${latestSnapshotPath}`);
assert.deepEqual(
  readCompanyRoleValuesFromSnapshot(latestSnapshotPath),
  readCompanyRoleValuesFromSchema(SCHEMA_PATH),
  "company_role enum values should match the latest Drizzle snapshot",
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "required_table_migrations",
    "rls_enable_migrations",
    "rls_force_migrations",
    "company_role_snapshot",
  ],
  migrationFiles,
  latestSnapshotFile,
  requiredTableCount: REQUIRED_TABLES.length,
  rlsTableCount: RLS_TABLES.length,
}, null, 2));

function readCompanyRoleValuesFromSchema(path: string): string[] {
  const schema = readFileSync(path, "utf8");
  const match = schema.match(/pgEnum\("company_role", \[(?<values>[^\]]+)\]\)/);
  assert.ok(match?.groups?.values, `${path} is missing company_role enum declaration`);
  return [...match.groups.values.matchAll(/"([^"]+)"/g)].map((entry) => entry[1] ?? "");
}

function readCompanyRoleValuesFromSnapshot(path: string): string[] {
  const snapshot = JSON.parse(readFileSync(path, "utf8")) as {
    enums?: Record<string, { values?: string[] }>;
  };
  const values = snapshot.enums?.["public.company_role"]?.values;
  assert.ok(Array.isArray(values), `${path} is missing public.company_role enum values`);
  return values;
}
