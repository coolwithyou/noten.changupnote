// K-Startup 증분 수집 코어. fetch → (상세 수집) → normalize → publish 를 수행한다.
//
// 이 모듈은 순수 코어다: argv/env 파싱과 loadMonorepoEnv 는 호출부(CLI · API 라우트)의 책임이며,
// 여기서는 process.env 가 이미 주입돼 있다고 가정한다(Vercel 런타임 · CLI 양쪽 공통).
// CLI 는 archive-kstartup.ts, 서버 라우트는 /api/cron/ingest-kstartup 이 이 함수를 호출한다.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { NormalizedGrant } from "@cunote/contracts";
import {
  fetchKStartupPage,
  normalizeKStartupPayload,
  type KStartupAnnouncement,
  type KStartupApiResponse,
  type KStartupDetailContent,
} from "@cunote/core";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import {
  planGrantArchivePublication,
  selectPublishableArchiveEntries,
  type ExistingGrantRawHash,
  type GrantArchivePlan,
} from "./archivePlan";
import {
  attachmentsFromDetail,
  fetchKStartupDetailWithRetry,
  resolveKStartupDetailUrl,
  sleep,
  KSTARTUP_DETAIL_REQUEST_DELAY_MS,
} from "./kstartupDetailFetch";
import { publishKStartupGrants } from "./kstartupPublisher";

export interface ArchiveKStartupInput {
  db: CunoteDb | null;
  source: "sample" | "live";
  perPage: number;
  startPage: number;
  pages: number;
  allPages: boolean;
  maxPages: number;
  limit: number | undefined;
  write: boolean;
  compareDb: boolean;
  skipUnchanged: boolean;
  stopAfterUnchangedPages: number;
  collectedAt: Date;
  details: boolean;
  /**
   * 한 번의 실행에서 허용하는 상세 fetch 최대 건수. 초과분 공고는 detail 없이 발행하고
   * detailTotals.skippedBudget 로 집계한다(라우트 B / 백필이 나중에 치유). 미지정이면 무제한.
   */
  maxDetailFetches?: number;
}

export interface ArchiveKStartupResult {
  dryRun: boolean;
  source: "sample" | "live";
  compareDb: boolean;
  skipUnchanged: boolean;
  details: boolean;
  startPage: number;
  perPage: number;
  pageCount: number;
  stopReason: string;
  collectedAt: string;
  totals: ArchiveTotals;
  detailTotals: DetailTotals;
  pages: ArchivePageSummary[];
}

export interface DetailTotals {
  attempted: number;
  fetched: number;
  failed: number;
  skippedNoUrl: number;
  skippedBudget: number;
  attachments: number;
}

export interface ArchivePageSummary {
  page: number;
  currentCount: number;
  totalCount: number | null;
  publishedCount: number;
  plan: Omit<GrantArchivePlan, "rawHashes"> & { rawHashCount: number };
}

export interface ArchiveTotals {
  fetchedCount: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  publishableCount: number;
  publishedCount: number;
  criteriaCount: number;
  publishableCriteriaCount: number;
}

export async function archiveKStartup(input: ArchiveKStartupInput): Promise<ArchiveKStartupResult> {
  if (input.write && !input.db) throw new Error("--write requires database access.");
  const pages: ArchivePageSummary[] = [];
  const totals = emptyTotals();
  const detailTotals = emptyDetailTotals();
  const detailBudget = input.maxDetailFetches !== undefined ? { remaining: input.maxDetailFetches } : null;
  let stopReason = "page_limit";
  let unchangedPageStreak = 0;
  let totalCount: number | null = null;
  let fetchedRows = 0;

  for (let offset = 0; offset < input.pages; offset += 1) {
    const page = input.startPage + offset;
    const payload = input.source === "live"
      ? await readLivePayload(page, input.perPage)
      : readSamplePayload(input.limit ?? input.perPage);
    const entries = normalizeKStartupPayload(payload, {
      collectedAt: input.collectedAt,
      asOf: input.collectedAt,
    });
    const existing = input.db ? await readExistingKStartupRawState(input.db, entries) : null;
    // 이미 저장된 상세(detail)를 base payload 에 다시 붙여, 변경되지 않은 공고가
    // detail 유무 차이로 매번 "changed" 로 뒤집혀 재발행되는 것을 막는다(멱등성).
    if (existing) reattachStoredDetail(entries, existing.detailBySourceId);
    const existingHashes = existing?.hashes ?? [];
    const plan = planGrantArchivePublication("kstartup", entries, existingHashes, {
      skipUnchanged: input.skipUnchanged,
    });
    const publishableEntries = selectPublishableArchiveEntries(entries, plan);

    // 신규/변경 공고에 대해서만 상세 페이지를 fetch 해 payload.detail + attachments 를 채운다.
    await enrichEntriesWithDetail(publishableEntries, input.details, detailTotals, detailBudget);

    if (input.write && input.db) {
      if (publishableEntries.length > 0) {
        await publishKStartupGrants(input.db, publishableEntries, {
          page,
          collectedAt: input.collectedAt,
        });
      } else {
        await updateSourceCursor(input.db, page, input.collectedAt);
      }
    }

    totalCount = readTotalCount(payload, totalCount);
    fetchedRows += payload.currentCount ?? payload.data.length;
    addTotals(totals, plan, input.write ? publishableEntries.length : 0);
    pages.push({
      page,
      currentCount: payload.currentCount ?? payload.data.length,
      totalCount,
      publishedCount: input.write ? publishableEntries.length : 0,
      plan: summarizePlan(plan),
    });

    if (input.compareDb && input.skipUnchanged && plan.publishableCount === 0) {
      unchangedPageStreak += 1;
      if (input.stopAfterUnchangedPages > 0 && unchangedPageStreak >= input.stopAfterUnchangedPages) {
        stopReason = "unchanged_page_streak";
        break;
      }
    } else {
      unchangedPageStreak = 0;
    }

    if (input.source === "sample") {
      stopReason = "sample";
      break;
    }
    if (payload.data.length === 0 || (payload.currentCount !== undefined && payload.currentCount === 0)) {
      stopReason = "empty_page";
      break;
    }
    if (input.allPages && totalCount !== null && fetchedRows >= totalCount) {
      stopReason = "total_count_reached";
      break;
    }
    if (!input.allPages && offset + 1 >= input.pages) {
      stopReason = "page_limit";
      break;
    }
    if (input.allPages && offset + 1 >= input.maxPages) {
      stopReason = "max_pages";
      break;
    }
  }

  return {
    dryRun: !input.write,
    source: input.source,
    compareDb: input.compareDb,
    skipUnchanged: input.skipUnchanged,
    details: input.details,
    startPage: input.startPage,
    perPage: input.perPage,
    pageCount: pages.length,
    stopReason,
    collectedAt: input.collectedAt.toISOString(),
    totals,
    detailTotals,
    pages,
  };
}

/**
 * publishable(신규/변경) 공고에 대해 상세 페이지를 순차 fetch 해 payload.detail + attachments 를 채운다.
 * - details 가 꺼져 있으면 이미 붙어 있는(저장분) detail 로 attachments 만 보존한다.
 * - budget(maxDetailFetches)이 소진되면 초과분은 detail 없이 진행하고 skippedBudget 로 집계한다.
 * - 개별 실패는 삼키고(detail 없이 진행) 카운트만 남긴다.
 */
async function enrichEntriesWithDetail(
  entries: Array<NormalizedGrant<KStartupAnnouncement>>,
  details: boolean,
  totals: DetailTotals,
  budget: { remaining: number } | null,
): Promise<void> {
  let first = true;
  for (const entry of entries) {
    if (details) {
      const url = resolveKStartupDetailUrl(entry.raw.payload);
      if (!url) {
        totals.skippedNoUrl += 1;
      } else if (budget && budget.remaining <= 0) {
        // 예산 소진 — detail 없이 발행하고 라우트 B / 백필이 나중에 치유한다.
        totals.skippedBudget += 1;
      } else {
        if (!first) await sleep(KSTARTUP_DETAIL_REQUEST_DELAY_MS);
        first = false;
        if (budget) budget.remaining -= 1;
        totals.attempted += 1;
        const outcome = await fetchKStartupDetailWithRetry(url);
        if (outcome.ok) {
          totals.fetched += 1;
          entry.raw.payload.detail = outcome.content;
        } else {
          totals.failed += 1;
        }
      }
    }
    // fresh 또는 저장분 detail 이 있으면 attachments 를 채운다(재발행 시 첨부 유실 방지).
    const detail = entry.raw.payload.detail;
    if (detail) {
      const attachments = attachmentsFromDetail(detail);
      entry.raw.attachments = attachments;
      totals.attachments += attachments.length;
    }
  }
}

/** 저장된 grant_raw.payload.detail 을 fresh base entry 에 다시 붙인다(멱등 change-detection). */
function reattachStoredDetail(
  entries: Array<NormalizedGrant<KStartupAnnouncement>>,
  detailBySourceId: Map<string, KStartupDetailContent>,
): void {
  for (const entry of entries) {
    const stored = detailBySourceId.get(entry.raw.source_id);
    if (stored) entry.raw.payload.detail = stored;
  }
}

async function readLivePayload(page: number, perPage: number): Promise<KStartupApiResponse> {
  const serviceKey = process.env.KSTARTUP_SERVICE_KEY?.trim();
  if (!serviceKey) throw new Error("KSTARTUP_SERVICE_KEY가 필요합니다.");
  return fetchKStartupPage({ serviceKey, page, perPage });
}

function readSamplePayload(limit: number): KStartupApiResponse {
  const path = findProjectFile("samples/kstartup_announcement_sample.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as KStartupApiResponse;
  const safeLimit = Math.min(parsed.data.length, limit);
  return {
    ...parsed,
    data: parsed.data.slice(0, safeLimit),
    currentCount: safeLimit,
  };
}

interface ExistingKStartupRawState {
  hashes: ExistingGrantRawHash[];
  detailBySourceId: Map<string, KStartupDetailContent>;
}

async function readExistingKStartupRawState(
  db: CunoteDb,
  entries: Array<NormalizedGrant<KStartupAnnouncement>>,
): Promise<ExistingKStartupRawState> {
  const sourceIds = [...new Set(entries.map((entry) => entry.raw.source_id))];
  if (sourceIds.length === 0) return { hashes: [], detailBySourceId: new Map() };
  const rows = await db
    .select({
      sourceId: schema.grantRaw.sourceId,
      rawHash: schema.grantRaw.rawHash,
      payload: schema.grantRaw.payload,
    })
    .from(schema.grantRaw)
    .where(and(
      eq(schema.grantRaw.source, "kstartup"),
      inArray(schema.grantRaw.sourceId, sourceIds),
    ));
  const detailBySourceId = new Map<string, KStartupDetailContent>();
  for (const row of rows) {
    const detail = (row.payload as unknown as KStartupAnnouncement).detail;
    if (detail) detailBySourceId.set(row.sourceId, detail);
  }
  return {
    hashes: rows.map((row) => ({ sourceId: row.sourceId, rawHash: row.rawHash })),
    detailBySourceId,
  };
}

async function updateSourceCursor(db: CunoteDb, page: number, collectedAt: Date): Promise<void> {
  await db
    .insert(schema.sourceCursor)
    .values({
      source: "kstartup",
      lastPage: page,
      lastCollectedAt: collectedAt,
    })
    .onConflictDoUpdate({
      target: schema.sourceCursor.source,
      set: {
        lastPage: page,
        lastCollectedAt: collectedAt,
      },
    });
}

function summarizePlan(plan: GrantArchivePlan): ArchivePageSummary["plan"] {
  const { rawHashes, ...rest } = plan;
  return {
    ...rest,
    rawHashCount: rawHashes.length,
  };
}

function emptyTotals(): ArchiveTotals {
  return {
    fetchedCount: 0,
    newCount: 0,
    changedCount: 0,
    unchangedCount: 0,
    publishableCount: 0,
    publishedCount: 0,
    criteriaCount: 0,
    publishableCriteriaCount: 0,
  };
}

function emptyDetailTotals(): DetailTotals {
  return {
    attempted: 0,
    fetched: 0,
    failed: 0,
    skippedNoUrl: 0,
    skippedBudget: 0,
    attachments: 0,
  };
}

function addTotals(totals: ArchiveTotals, plan: GrantArchivePlan, publishedCount: number): void {
  totals.fetchedCount += plan.fetchedCount;
  totals.newCount += plan.newCount;
  totals.changedCount += plan.changedCount;
  totals.unchangedCount += plan.unchangedCount;
  totals.publishableCount += plan.publishableCount;
  totals.publishedCount += publishedCount;
  totals.criteriaCount += plan.criteriaCount;
  totals.publishableCriteriaCount += plan.publishableCriteriaCount;
}

function readTotalCount(payload: KStartupApiResponse, fallback: number | null): number | null {
  return payload.totalCount ?? payload.matchCount ?? fallback;
}

function findProjectFile(relativePath: string): string {
  const candidates = [
    resolve(process.cwd(), relativePath),
    resolve(process.cwd(), "../..", relativePath),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error(`Missing project file: ${relativePath}`);
  return found;
}
