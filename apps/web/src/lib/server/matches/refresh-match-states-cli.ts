// 매치 상태(match_state) 갱신 CLI. argv/env 파싱 + loadMonorepoEnv + db 생성 후 코어(refreshMatchStatesCore)를 호출한다.
// 코어 로직·타입은 refreshMatchStatesCore.ts 에 있으며, /api/cron/grant-cycle-post 라우트와 공유한다.
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { runRefreshMatchStates } from "./refreshMatchStatesCore";

const DEFAULT_DEMO_COMPANY_ID = "00000000-0000-4000-8000-000000000101";

loadMonorepoEnv();

if (hasFlag("help")) {
  console.log([
    "Usage: pnpm match:states:refresh -- --companyId=<uuid> [--limit=500] [--asOf=2026-06-27T00:00:00.000Z] [--write]",
    "",
    "Default mode is dry-run. Add --write to persist match_state rows.",
  ].join("\n"));
  process.exit(0);
}

const companyId = readArg("companyId") ?? process.env.CUNOTE_DEMO_COMPANY_ID ?? DEFAULT_DEMO_COMPANY_ID;
const limit = boundedInteger(readArg("limit") ?? process.env.CUNOTE_MATCH_STATE_REFRESH_LIMIT, 500, 1, 2_000);
const asOf = dateArg(readArg("asOf") ?? process.env.CUNOTE_MATCH_STATE_REFRESH_AS_OF) ?? new Date();
const write = hasFlag("write") || process.env.CUNOTE_MATCH_STATE_REFRESH_WRITE === "true";
const db = getCunoteDb();

try {
  const summary = await runRefreshMatchStates({ db, companyId, limit, asOf, write });
  console.log(JSON.stringify(summary, null, 2));
} catch (error) {
  if (isMissingDatabaseSchemaError(error)) {
    console.error(JSON.stringify({
      ok: false,
      dryRun: !write,
      code: "missing_database_schema",
      message: "match_state 갱신은 DB 마이그레이션과 샘플 데이터 발행 이후 실행할 수 있습니다.",
      companyId,
      prerequisites: [
        "pnpm db:migrate",
        "pnpm seed:demo",
        "pnpm publish:kstartup -- --source=sample",
        "pnpm publish:bizinfo -- --source=sample",
        "pnpm publish:dedup",
      ],
      nextStep: "개발 DB가 맞으면 pnpm db:bootstrap:dev -- --confirm-dev-db 를 실행하세요.",
    }, null, 2));
    process.exitCode = 1;
  } else {
    throw error;
  }
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid bounded integer: ${value}. Use ${min}..${max}.`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function isMissingDatabaseSchemaError(error: unknown): boolean {
  return findErrorCode(error) === "42P01";
}

function findErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === "string") return candidate.code;
  return findErrorCode(candidate.cause);
}
