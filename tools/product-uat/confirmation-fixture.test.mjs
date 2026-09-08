import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createProductUatEnv } from "./runtime.mjs";

const repoRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "../.."));
const runRoot = mkdtempSync(join(realpathSync(tmpdir()), "cunote-product-uat-pg-"));
const markerPath = join(runRoot, ".cunote-product-uat-owner.json");
writeFileSync(markerPath, JSON.stringify({
  schema: "cunote-product-uat-runtime-owner-v1",
  id: "confirmation-fixture-guard-test",
}), { mode: 0o600 });
const baseEnv = createProductUatEnv({
  PGHOST: runRoot,
  PGUSER: "postgres",
  DATABASE_URL: "postgres:///postgres",
  CUNOTE_PRODUCT_UAT_RUNTIME_ROOT: runRoot,
});
const checks = [];

rejectBeforeDatabase("broad_runtime_root", { CUNOTE_PRODUCT_UAT_RUNTIME_ROOT: "/" });
rejectBeforeDatabase("tcp_database_url", { DATABASE_URL: "postgres://127.0.0.1/postgres" });
rejectBeforeDatabase("unknown_action", {}, ["--action=unbounded"]);
writeFileSync(markerPath, JSON.stringify({ schema: "wrong", id: "confirmation-fixture-guard-test" }));
rejectBeforeDatabase("invalid_owner_marker", {});
rejectRunnerBeforeRuntime("hold_above_max", ["--hold-seconds=601"]);
rejectRunnerBeforeRuntime("hold_zero", ["--hold-seconds=0"]);

console.log(JSON.stringify({
  ok: true,
  suite: "product-uat-confirmation-fixture-guard",
  checks,
  databaseStarted: false,
  retainedFixture: runRoot,
}));

function rejectBeforeDatabase(name, overrides, args = ["--action=inspect"]) {
  const child = spawnSync(process.execPath, [
    join(repoRoot, "node_modules/tsx/dist/cli.mjs"),
    "--tsconfig",
    "apps/web/tsconfig.json",
    "tools/product-uat/confirmation-fixture.ts",
    ...args,
  ], {
    cwd: repoRoot,
    env: { ...baseEnv, ...overrides },
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.notEqual(child.status, 0, name);
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  assert.match(output, /AssertionError/, name);
  assert.doesNotMatch(output, /ECONNREFUSED|ENOENT.*PGSQL|connection refused/i, `${name}: DB 착수 전 거부`);
  checks.push({ name, status: "rejected_before_database" });
}

function rejectRunnerBeforeRuntime(name, args) {
  const child = spawnSync(process.execPath, [join(repoRoot, "tools/run-local-product-uat.mjs"), ...args], {
    cwd: repoRoot,
    env: createProductUatEnv(),
    encoding: "utf8",
    timeout: 15_000,
  });
  assert.notEqual(child.status, 0, name);
  const output = `${child.stdout ?? ""}${child.stderr ?? ""}`;
  assert.match(output, /--hold-seconds는 1~600 사이의 정수/, name);
  assert.doesNotMatch(output, /initdb|pg_ctl|source snapshot|pnpm install/i, `${name}: runtime 착수 전 거부`);
  checks.push({ name, status: "rejected_before_runtime" });
}
