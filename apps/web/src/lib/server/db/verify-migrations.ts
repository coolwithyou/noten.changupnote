import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_TABLES, RLS_TABLES } from "./requirements";

const MIGRATION_DIR = "db/migrations";
const migrationFiles = readdirSync(MIGRATION_DIR)
  .filter((file) => file.endsWith(".sql"))
  .sort();
assert.ok(migrationFiles.length > 0, "Drizzle migration SQL files should exist");

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

console.log(JSON.stringify({
  ok: true,
  checked: [
    "required_table_migrations",
    "rls_enable_migrations",
    "rls_force_migrations",
  ],
  migrationFiles,
  requiredTableCount: REQUIRED_TABLES.length,
  rlsTableCount: RLS_TABLES.length,
}, null, 2));
