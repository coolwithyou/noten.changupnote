// 공고 아카이브 인사이트 스냅샷 생성 CLI. argv/env 파싱 + loadMonorepoEnv + db 생성 후 코어(generateGrantInsightsCore)를 호출한다.
// 코어 로직·타입은 generateGrantInsightsCore.ts 에 있으며, /api/cron/grant-cycle-post 라우트와 공유한다.
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { runGrantInsights } from "./generateGrantInsightsCore";

loadMonorepoEnv();

if (hasFlag("help")) {
  printHelp();
  process.exit(0);
}

const write = hasFlag("write") || process.env.CUNOTE_GRANT_INSIGHTS_WRITE === "true";
const asOf = dateArg(readArg("asOf") ?? process.env.CUNOTE_GRANT_INSIGHTS_AS_OF) ?? new Date();
const staleCursorHours = boundedInteger(
  readArg("staleCursorHours") ?? process.env.CUNOTE_GRANT_INSIGHTS_STALE_CURSOR_HOURS,
  48,
  1,
  24 * 30,
);
const db = getCunoteDb();

try {
  const result = await runGrantInsights({ db, write, asOf, staleCursorHours });
  console.log(JSON.stringify(result, null, 2));
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

function printHelp() {
  console.log(`Usage: pnpm insights:grants -- [options]

Builds a grant archive insight snapshot from the selected database.
Default mode is dry-run. Add --write to persist grant_insight_snapshots.

Options:
  --write
  --asOf=2026-06-27T00:00:00Z
  --staleCursorHours=48
`);
}
