// 교차 소스 dedup 링크 발행 CLI. argv/env 파싱 + loadMonorepoEnv + db 생성 후 코어(publishDedupCore)를 호출한다.
// 코어 로직·타입은 publishDedupCore.ts 에 있으며, /api/cron/grant-cycle-post 라우트와 공유한다.
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { runDedupPublish } from "./publishDedupCore";

loadMonorepoEnv();

if (hasFlag("help")) {
  console.log([
    "Usage: pnpm publish:dedup -- [--limit=500] [--minScore=0.82] [--asOf=2026-06-27T00:00:00.000Z]",
    "       pnpm publish:dedup -- --write --confirm=PUBLISH_DEDUP_LINKS [options]",
    "       write additionally requires one or more --pair=<canonicalGrantKey>,<memberGrantKey>",
    "",
    "Default is read-only dry-run. DB publication requires both --write and the exact confirmation string.",
  ].join("\n"));
  process.exit(0);
}

const write = hasFlag("write");
if (write && readArg("confirm") !== "PUBLISH_DEDUP_LINKS") {
  throw new Error("--write requires --confirm=PUBLISH_DEDUP_LINKS");
}
if (write && hasFlag("dry-run")) throw new Error("--write and --dry-run cannot be used together");
const pairKeys = parsePairArgs(readArgs("pair"), 20);
if (write && pairKeys.length === 0) throw new Error("--write requires at least one exact --pair scope");
const dryRun = !write;
const limit = boundedInteger(readArg("limit") ?? process.env.CUNOTE_DEDUP_LIMIT, 500, 1, 2_000);
const minScore = optionalNumber(readArg("minScore") ?? process.env.CUNOTE_DEDUP_MIN_SCORE);
const asOf = dateArg(readArg("asOf") ?? process.env.CUNOTE_DEDUP_AS_OF) ?? new Date();
const db = getCunoteDb();

try {
  const result = await runDedupPublish({ db, dryRun, limit, minScore, asOf, pairKeys });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readArgs(name: string): string[] {
  const prefix = `--${name}=`;
  return process.argv.filter((arg) => arg.startsWith(prefix)).map((arg) => arg.slice(prefix.length));
}

function parsePairArgs(values: string[], max: number) {
  if (values.length > max) throw new Error(`--pair supports at most ${max} values`);
  return values.map((value) => {
    const [canonicalGrantKey, memberGrantKey, ...rest] = value.split(",");
    if (rest.length > 0 || !canonicalGrantKey || !memberGrantKey || canonicalGrantKey === memberGrantKey) {
      throw new Error(`Invalid --pair: ${value}. Use <canonicalGrantKey>,<memberGrantKey>.`);
    }
    for (const key of [canonicalGrantKey, memberGrantKey]) {
      if (!/^[A-Za-z0-9._:-]+$/.test(key)) throw new Error(`Unsafe grant key in --pair: ${key}`);
    }
    return { canonicalGrantKey, memberGrantKey };
  });
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

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid minScore: ${value}. Use 0..1.`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}
