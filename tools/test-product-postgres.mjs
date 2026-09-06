import { mkdtempSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";

// 새 전용 cluster만 사용한다. 기존 DATABASE_URL/PGHOST나 TCP 서버는 접근하지 않는다.
const directory = mkdtempSync("/tmp/cunote-product-pg-");
const data = `${directory}/data`;
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(PG|DATABASE_URL$|SUPABASE_DB_URL$|DIRECT_URL$)/.test(key)) delete env[key];
}
let started = false;
try {
  execFileSync("initdb", ["-D", data, "-U", "postgres", "--auth-local=trust", "--auth-host=reject", "--no-locale", "--encoding=UTF8"], { env, stdio: "pipe" });
  execFileSync("pg_ctl", ["-D", data, "-l", `${directory}/postgres.log`, "-o", `-h '' -k ${directory} -c max_connections=20`, "-w", "start"], { env, stdio: "pipe" });
  started = true;
  const result = spawnSync("pnpm", ["exec", "tsx", "--tsconfig", "apps/web/tsconfig.json", "apps/web/src/lib/server/repositories/companyWritePostgres.integration.test.ts"], {
    env: { ...env, CUNOTE_PRODUCT_TEST_SOCKET: directory }, stdio: "inherit", timeout: 120_000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  if (process.exitCode === 0) {
    const adminResult = spawnSync("pnpm", ["exec", "tsx", "--tsconfig", "apps/admin/tsconfig.json", "apps/admin/src/lib/server/admin/sourceCorrectionsPostgres.integration.test.ts"], {
      env: { ...env, CUNOTE_PRODUCT_TEST_SOCKET: directory }, stdio: "inherit", timeout: 120_000,
    });
    if (adminResult.error) throw adminResult.error;
    process.exitCode = adminResult.status ?? 1;
  }
} finally {
  if (started) execFileSync("pg_ctl", ["-D", data, "-m", "fast", "-w", "stop"], { env, stdio: "pipe" });
  console.log(`Isolated PostgreSQL stopped; test-only data and log retained: ${directory}`);
}
