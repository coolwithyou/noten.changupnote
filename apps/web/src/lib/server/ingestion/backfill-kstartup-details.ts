/**
 * 모집 중(status='open') K-Startup 공고의 상세 페이지를 백필한다.
 *
 * 배경: K-Startup 공공 API 응답에는 첨부파일·제출서류·신청방법 상세가 없다.
 * 이 값들은 상세 페이지 HTML 에만 있으므로, grants.url(없으면 payload.detl_pg_url)로
 * 상세 페이지를 GET·파싱해 grant_raw.payload.detail + grant_raw.attachments 를 채우고
 * raw_hash 를 재계산한다. grants 테이블은 건드리지 않는다(작성방식 분류는 후속 작업).
 *
 * robots.txt 준수: 상세 페이지(/web/contents/*)만 GET 한다. 첨부 본문(/afile/*)은
 * 절대 다운로드하지 않고 파일명 + 다운로드 URL 메타데이터만 저장한다.
 *
 * 사용:
 *   dry-run(기본): pnpm backfill:kstartup-details -- --sourceIds=178373,178410 --limit=2
 *   실제 반영:     pnpm backfill:kstartup-details -- --sourceIds=178373,178410 --limit=2 \
 *                    --write --confirm=BACKFILL_KSTARTUP_DETAILS
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import type { KStartupAnnouncement } from "@cunote/core";
import { closeCunoteDb, getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  resolveKStartupDetailUrl,
  sleep,
  KSTARTUP_DETAIL_REQUEST_DELAY_MS,
} from "./kstartupDetailFetch";
import { healKStartupGrantDetail } from "./kstartupDetailHeal";

loadMonorepoEnv();

const PROGRESS_EVERY = 25;
const FORM_EXTENSIONS = /\.(hwp|hwpx|docx?)$/i;

const write = hasFlag("write");
const confirmation = readArg("confirm");
const limit = optionalPositiveInteger(readArg("limit"));
const sourceIds = csvArg(readArg("sourceIds"), 100);
if (write && confirmation !== "BACKFILL_KSTARTUP_DETAILS") {
  throw new Error("--write requires --confirm=BACKFILL_KSTARTUP_DETAILS");
}

interface TargetGrant {
  sourceId: string;
  url: string | null;
}

interface FailureRecord {
  sourceId: string;
  url: string | null;
  reason: string;
}

async function main(): Promise<void> {
  const db = getCunoteDb();
  const mode = write ? "WRITE" : "DRY-RUN";
  console.log(`K-Startup 상세 백필 (${mode})${limit ? ` limit=${limit}` : ""}${sourceIds.length ? ` sourceIds=${sourceIds.length}` : ""}\n`);

  const targets = await readOpenKStartupGrants(db, limit, sourceIds);
  console.log(`대상: 모집 중 K-Startup 공고 ${targets.length}건\n`);

  let processed = 0;
  let succeeded = 0;
  let updated = 0;
  let skippedNoUrl = 0;
  let skippedNoRaw = 0;
  const failures: FailureRecord[] = [];
  const detailResults: Array<{ sourceId: string; status: string; filenames: string[] }> = [];
  const attachmentCountDistribution = new Map<number, number>();
  let withFormFileCount = 0;
  let first = true;

  for (const target of targets) {
    processed += 1;
    const url = target.url ?? null;
    if (!url) {
      skippedNoUrl += 1;
      failures.push({ sourceId: target.sourceId, url: null, reason: "detail URL 없음" });
      logProgress(processed, targets.length);
      continue;
    }

    if (!first) await sleep(KSTARTUP_DETAIL_REQUEST_DELAY_MS);
    first = false;

    const result = await healKStartupGrantDetail(db, {
      sourceId: target.sourceId,
      url,
      write,
    });

    if (result.attachments) {
      // fetch 성공(dry_run · updated · no_raw 공통) — 첨부 통계는 항상 집계한다.
      succeeded += 1;
      bump(attachmentCountDistribution, result.attachments.length);
      if (result.attachments.some((attachment) => FORM_EXTENSIONS.test(attachment.filename))) {
        withFormFileCount += 1;
      }
      if (sourceIds.length > 0) {
        detailResults.push({
          sourceId: target.sourceId,
          status: result.status,
          filenames: result.attachments.map((attachment) => attachment.filename),
        });
      }
    }

    if (!result.ok) {
      if (result.status === "no_raw") {
        skippedNoRaw += 1;
        failures.push({ sourceId: target.sourceId, url, reason: "grant_raw 행 없음" });
      } else {
        failures.push({ sourceId: target.sourceId, url, reason: result.error ?? "상세 fetch 실패" });
      }
    } else if (result.status === "updated") {
      updated += 1;
    }

    logProgress(processed, targets.length);
  }

  console.log("\n요약");
  console.log(`  처리: ${processed}건 (성공 ${succeeded}, 실패 ${failures.length})`);
  if (write) console.log(`  반영: grant_raw 갱신 ${updated}건 (grant_raw 없음 ${skippedNoRaw}건)`);
  console.log(`  detail URL 없음: ${skippedNoUrl}건`);
  console.log(`  서식성 파일(.hwp/.hwpx/.doc/.docx) 보유 공고: ${withFormFileCount}건`);
  console.log("  첨부 수 분포:");
  for (const [count, grants] of [...attachmentCountDistribution.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`    첨부 ${count}개: ${grants}건`);
  }

  if (failures.length > 0) {
    console.log(`\n실패 ${failures.length}건 (최대 20건 표시):`);
    for (const failure of failures.slice(0, 20)) {
      console.log(`  - ${failure.sourceId}: ${failure.reason}`);
    }
  }

  if (detailResults.length > 0) {
    console.log("\n선택 대상 상세:");
    console.log(JSON.stringify(detailResults, null, 2));
  }

  if (!write) {
    console.log("\n(dry-run — DB 미변경. 반영하려면 --write --confirm=BACKFILL_KSTARTUP_DETAILS가 필요함)");
  }
}

async function readOpenKStartupGrants(
  db: CunoteDb,
  cap: number | undefined,
  sourceIds: string[],
): Promise<TargetGrant[]> {
  const query = db
    .select({
      sourceId: schema.grants.sourceId,
      url: schema.grants.url,
      detailPageUrl: schema.grantRaw.payload,
    })
    .from(schema.grants)
    .leftJoin(
      schema.grantRaw,
      and(
        eq(schema.grantRaw.source, schema.grants.source),
        eq(schema.grantRaw.sourceId, schema.grants.sourceId),
      ),
    )
    .where(and(
      eq(schema.grants.source, "kstartup"),
      eq(schema.grants.status, "open"),
      sourceIds.length > 0 ? inArray(schema.grants.sourceId, sourceIds) : undefined,
    ))
    .orderBy(asc(schema.grants.sourceId));

  const rows = cap ? await query.limit(cap) : await query;
  return rows.map((row) => {
    const payload = row.detailPageUrl as unknown as KStartupAnnouncement | null;
    const url =
      textOrNull(row.url) ??
      (payload ? resolveKStartupDetailUrl(payload) : null);
    return { sourceId: row.sourceId, url };
  });
}

function logProgress(processed: number, total: number): void {
  if (processed % PROGRESS_EVERY === 0 || processed === total) {
    console.log(`  진행: ${processed}/${total}`);
  }
}

function bump(map: Map<number, number>, key: number): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function textOrNull(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid --limit: ${value}. Use a positive integer.`);
  }
  return parsed;
}

function csvArg(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length > max) throw new Error(`sourceIds supports at most ${max} values`);
  return values;
}

main()
  .then(async () => {
    await closeCunoteDb();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error(error);
    await closeCunoteDb();
    process.exit(1);
  });
