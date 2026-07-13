// Phase 2 T8 CLI: pending surface 를 변환 서버에 (재)등록·폴링하고 artifact/상태를 반영한다.
// 계획: docs/phase2-conversion-server-implementation-plan.md (8.3 상태 전이, 2장 재조정 스윕).
//
// 실행: pnpm conversion:poll -- [options]
//   기본은 dry-run (DB 쓰기 안 함). --write 로 반영.
//
// Options:
//   --write                 DB 반영 (document_artifacts upsert + status 전이)
//   --limit=50              한 사이클에 처리할 surface 수
//   --staleMs=3600000       재조정 스윕: 이 ms 이상 pending 인 surface 만 (기본 0=전부)
//   --source=bizinfo        source 제한
//   --sourceIds=id1,id2     특정 공고 source_id 제한
//   --maxAttempts=120       job 폴링 최대 시도
//   --intervalMs=250        폴링 간격
//
// Environment: CONVERSION_SERVER_URL, CONVERSION_SHARED_SECRET,
//              DATABASE_URL/SUPABASE_DB_URL/DIRECT_URL.

import { closeCunoteDb, getCunoteDb, type CunoteDbSession } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createConversionClientFromEnv } from "./conversionClient";
import {
  collectPendingSurfaceJobs,
  pollAndPersistSurfaceJob,
  type PollOneResult,
} from "./pollConversions";

loadMonorepoEnv();

if (hasFlag("help")) {
  printHelp();
  process.exit(0);
}

const cliWrite = hasFlag("write");
const write = cliWrite || process.env.CUNOTE_CONVERSION_POLL_WRITE === "true";
if (cliWrite && readArg("confirm") !== "POLL_CONVERSION_JOBS") {
  throw new Error("--write requires --confirm=POLL_CONVERSION_JOBS");
}
const limit = boundedInteger(readArg("limit") ?? process.env.CUNOTE_CONVERSION_POLL_LIMIT, 50, 1, 1000);
const staleMs = boundedInteger(readArg("staleMs") ?? process.env.CUNOTE_CONVERSION_POLL_STALE_MS, 0, 0, 7 * 24 * 3600 * 1000);
const source = readOptionalEnum(readArg("source") ?? process.env.CUNOTE_CONVERSION_POLL_SOURCE, ["kstartup", "bizinfo", "bizinfo_event"]);
const sourceIds = csvArg(readArg("sourceIds"), 100);
const maxAttempts = boundedInteger(readArg("maxAttempts"), 120, 1, 5000);
const intervalMs = boundedInteger(readArg("intervalMs"), 250, 25, 10_000);

const client = createConversionClientFromEnv();
if (!client) {
  console.error("CONVERSION_SERVER_URL / CONVERSION_SHARED_SECRET 미설정 — 폴링을 건너뜁니다.");
  console.log(JSON.stringify({ ok: false, reason: "conversion_env_missing" }, null, 2));
  process.exit(0);
}

const db = getCunoteDb();

try {
  const jobs = await collectPendingSurfaceJobs(db, {
    limit,
    staleMs,
    ...(source ? { source } : {}),
    ...(sourceIds.length ? { sourceIds } : {}),
  });

  const results: PollOneResult[] = [];
  for (const job of jobs) {
    if (!write) {
      // dry-run: 대상만 나열, 서버 호출/DB 쓰기 안 함.
      results.push({
        surfaceId: job.surfaceId,
        filename: job.filename,
        outcome: job.sourceObjectUrl && job.sha256 ? "pending" : "skipped",
        artifactsInserted: 0,
        artifactsUpdated: 0,
        message: job.sourceObjectUrl && job.sha256 ? "dry-run (미실행)" : "archive_url/sha256 누락",
      });
      continue;
    }
    try {
      const result = await db.transaction((tx) =>
        pollAndPersistSurfaceJob(
          tx as unknown as CunoteDbSession,
          client,
          job,
          { maxAttempts, intervalMs },
        ),
      );
      results.push(result);
    } catch (error) {
      results.push({
        surfaceId: job.surfaceId,
        filename: job.filename,
        outcome: "pending",
        artifactsInserted: 0,
        artifactsUpdated: 0,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  console.log(JSON.stringify({
    ok: true,
    dryRun: !write,
    limit,
    staleMs,
    source: source ?? "all",
    sourceIds,
    pendingCount: jobs.length,
    previewReady: results.filter((r) => r.outcome === "preview_ready").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    stillPending: results.filter((r) => r.outcome === "pending").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
    results,
  }, null, 2));
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

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid integer: ${value}. Use ${min}..${max}.`);
  }
  return parsed;
}

function readOptionalEnum<T extends string>(value: string | undefined, values: readonly T[]): T | undefined {
  if (!value) return undefined;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid value: ${value}. Use ${values.join("|")}.`);
}

function printHelp(): void {
  console.log(`Usage: pnpm conversion:poll -- [options]

Polls the conversion server for pending application surfaces, upserts
document_artifacts, and transitions extraction_status (pending -> preview_ready|failed).
Doubles as the reconciliation sweep (plan section 2). Default mode is dry-run.

Options:
  --write --confirm=POLL_CONVERSION_JOBS
  --limit=50
  --staleMs=3600000
  --source=kstartup|bizinfo|bizinfo_event
  --sourceIds=id1,id2
  --maxAttempts=120
  --intervalMs=250

Environment:
  CONVERSION_SERVER_URL
  CONVERSION_SHARED_SECRET
  DATABASE_URL / SUPABASE_DB_URL / DIRECT_URL
`);
}

function csvArg(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length > max) throw new Error(`sourceIds supports at most ${max} values`);
  return values;
}
