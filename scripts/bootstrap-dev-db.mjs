import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const CONFIRM_ENV_VALUE = "dev";
const args = new Set(process.argv.slice(2));

loadEnvFile(".env");
loadEnvFile(".env.local");

const databaseUrl = process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL;
const target = databaseUrl ? describeDatabaseUrl(databaseUrl) : null;
const confirmed = args.has("--confirm-dev-db") || process.env.CUNOTE_DB_BOOTSTRAP_CONFIRM === CONFIRM_ENV_VALUE;
const dryRun = args.has("--dry-run") || !confirmed;

const steps = [
  {
    label: "현재 DB 상태 확인",
    command: ["pnpm", "db:doctor"],
    allowFailure: true,
  },
  {
    label: "Drizzle 마이그레이션 적용",
    command: ["pnpm", "db:migrate"],
  },
  {
    label: "데모 사용자/회사/프로필 seed",
    command: ["pnpm", "seed:demo"],
  },
  {
    label: "K-Startup 샘플 공고 발행",
    command: ["pnpm", "publish:kstartup", "--", "--source=sample"],
  },
  {
    label: "기업마당 샘플 공고 발행",
    command: ["pnpm", "publish:bizinfo", "--", "--source=sample"],
  },
  {
    label: "DB 상태 재확인",
    command: ["pnpm", "db:doctor"],
  },
  {
    label: "DB-backed 서비스 smoke",
    command: ["pnpm", "smoke:db"],
  },
];

if (!databaseUrl) {
  console.error("DATABASE_URL, SUPABASE_DB_URL 또는 DIRECT_URL이 필요합니다.");
  process.exit(1);
}

console.log(JSON.stringify({
  dryRun,
  confirmed,
  confirmation: {
    flag: "--confirm-dev-db",
    env: `CUNOTE_DB_BOOTSTRAP_CONFIRM=${CONFIRM_ENV_VALUE}`,
  },
  target,
  steps: steps.map((step) => ({
    label: step.label,
    command: step.command.join(" "),
    allowFailure: Boolean(step.allowFailure),
  })),
}, null, 2));

if (dryRun) {
  console.log("\n쓰기 작업은 실행하지 않았습니다. 개발 DB가 맞으면 --confirm-dev-db 또는 CUNOTE_DB_BOOTSTRAP_CONFIRM=dev 로 다시 실행하세요.");
  process.exit(0);
}

for (const step of steps) {
  console.log(`\n> ${step.label}`);
  console.log(`$ ${step.command.join(" ")}`);
  const result = spawnSync(step.command[0], step.command.slice(1), {
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(`${step.label} 실행 실패: ${result.error.message}`);
    process.exit(1);
  }

  if ((result.status ?? 0) !== 0 && !step.allowFailure) {
    process.exit(result.status ?? 1);
  }
}

function loadEnvFile(fileName) {
  const path = resolve(process.cwd(), fileName);
  if (!existsSync(path)) return;

  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const separator = trimmed.indexOf("=");
    const key = trimmed.slice(0, separator).trim();
    const rawValue = trimmed.slice(separator + 1).trim();
    if (!key || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^['"]|['"]$/g, "");
  }
}

function describeDatabaseUrl(value) {
  const parsed = new URL(value);
  return {
    selected: selectedDatabaseUrlKey(),
    protocol: parsed.protocol.replace(":", ""),
    host: parsed.hostname,
    port: parsed.port || null,
    database: parsed.pathname.replace(/^\//, "") || null,
    username: parsed.username || null,
  };
}

function selectedDatabaseUrlKey() {
  if (process.env.DATABASE_URL) return "DATABASE_URL";
  if (process.env.SUPABASE_DB_URL) return "SUPABASE_DB_URL";
  if (process.env.DIRECT_URL) return "DIRECT_URL";
  return null;
}
