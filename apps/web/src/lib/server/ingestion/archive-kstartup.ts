import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { NormalizedGrant } from "@cunote/contracts";
import {
  fetchKStartupPage,
  normalizeKStartupPayload,
  type KStartupAnnouncement,
  type KStartupApiResponse,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import {
  planGrantArchivePublication,
  selectPublishableArchiveEntries,
  type ExistingGrantRawHash,
  type GrantArchivePlan,
} from "./archivePlan";
import { publishKStartupGrants } from "./kstartupPublisher";

loadMonorepoEnv();

if (hasFlag("help")) {
  printHelp();
  process.exit(0);
}

const source = readEnum(readArg("source") ?? process.env.CUNOTE_KSTARTUP_ARCHIVE_SOURCE, ["sample", "live"], "sample");
const perPage = boundedInteger(readArg("perPage") ?? process.env.KSTARTUP_PER_PAGE, 100, 1, 100);
const startPage = boundedInteger(readArg("startPage") ?? readArg("page") ?? process.env.KSTARTUP_PAGE, 1, 1, 100_000);
const requestedPages = boundedInteger(readArg("pages") ?? process.env.CUNOTE_KSTARTUP_ARCHIVE_PAGES, 1, 1, 10_000);
const allPages = hasFlag("all") || process.env.CUNOTE_KSTARTUP_ARCHIVE_ALL === "true";
const maxPages = boundedInteger(readArg("maxPages") ?? process.env.CUNOTE_KSTARTUP_ARCHIVE_MAX_PAGES, 500, 1, 10_000);
const limit = optionalBoundedInteger(readArg("limit") ?? process.env.CUNOTE_KSTARTUP_ARCHIVE_LIMIT, 1, 1, 100);
const write = hasFlag("write") || process.env.CUNOTE_KSTARTUP_ARCHIVE_WRITE === "true";
const compareDb = write || hasFlag("compare-db") || process.env.CUNOTE_KSTARTUP_ARCHIVE_COMPARE_DB === "true";
const skipUnchanged = !hasFlag("publish-unchanged") && process.env.CUNOTE_KSTARTUP_ARCHIVE_PUBLISH_UNCHANGED !== "true";
const stopAfterUnchangedPages = boundedInteger(
  readArg("stopAfterUnchangedPages") ?? process.env.CUNOTE_KSTARTUP_ARCHIVE_STOP_AFTER_UNCHANGED_PAGES,
  0,
  0,
  100,
);
const collectedAt = dateArg(readArg("collectedAt") ?? process.env.CUNOTE_KSTARTUP_ARCHIVE_COLLECTED_AT) ?? new Date();

if (source === "sample" && allPages) {
  throw new Error("--all은 --source=live 에서만 의미가 있습니다.");
}

const db = compareDb ? getCunoteDb() : null;

try {
  const result = await archiveKStartup({
    db,
    source,
    perPage,
    startPage,
    pages: allPages ? maxPages : requestedPages,
    allPages,
    maxPages,
    limit,
    write,
    compareDb,
    skipUnchanged,
    stopAfterUnchangedPages,
    collectedAt,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeCunoteDb();
}

interface ArchiveKStartupInput {
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
}

interface ArchiveKStartupResult {
  dryRun: boolean;
  source: "sample" | "live";
  compareDb: boolean;
  skipUnchanged: boolean;
  startPage: number;
  perPage: number;
  pageCount: number;
  stopReason: string;
  collectedAt: string;
  totals: ArchiveTotals;
  pages: ArchivePageSummary[];
}

interface ArchivePageSummary {
  page: number;
  currentCount: number;
  totalCount: number | null;
  publishedCount: number;
  plan: Omit<GrantArchivePlan, "rawHashes"> & { rawHashCount: number };
}

interface ArchiveTotals {
  fetchedCount: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  publishableCount: number;
  publishedCount: number;
  criteriaCount: number;
  publishableCriteriaCount: number;
}

async function archiveKStartup(input: ArchiveKStartupInput): Promise<ArchiveKStartupResult> {
  if (input.write && !input.db) throw new Error("--write requires database access.");
  const pages: ArchivePageSummary[] = [];
  const totals = emptyTotals();
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
    const existingHashes = input.db ? await readExistingGrantRawHashes(input.db, entries) : [];
    const plan = planGrantArchivePublication("kstartup", entries, existingHashes, {
      skipUnchanged: input.skipUnchanged,
    });
    const publishableEntries = selectPublishableArchiveEntries(entries, plan);

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
    startPage: input.startPage,
    perPage: input.perPage,
    pageCount: pages.length,
    stopReason,
    collectedAt: input.collectedAt.toISOString(),
    totals,
    pages,
  };
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

async function readExistingGrantRawHashes(
  db: CunoteDb,
  entries: Array<NormalizedGrant<KStartupAnnouncement>>,
): Promise<ExistingGrantRawHash[]> {
  const sourceIds = [...new Set(entries.map((entry) => entry.raw.source_id))];
  if (sourceIds.length === 0) return [];
  const rows = await db
    .select({
      sourceId: schema.grantRaw.sourceId,
      rawHash: schema.grantRaw.rawHash,
    })
    .from(schema.grantRaw)
    .where(and(
      eq(schema.grantRaw.source, "kstartup"),
      inArray(schema.grantRaw.sourceId, sourceIds),
    ));
  return rows;
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

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readEnum<T extends string>(value: string | undefined, values: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid value: ${value}. Use ${values.join("|")}.`);
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

function optionalBoundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  return boundedInteger(value, fallback, min, max);
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function printHelp() {
  console.log(`Usage: pnpm archive:kstartup -- [options]

Archives K-Startup announcements through the normalized grant contract.
Default mode is dry-run. Add --write to persist.

Options:
  --source=sample|live
  --page=1 / --startPage=1
  --perPage=100
  --pages=3
  --all --maxPages=500
  --limit=20                         Sample mode row limit
  --compare-db                       Read grant_raw.raw_hash and classify changed rows
  --write                            Persist changed/new rows and source_cursor
  --publish-unchanged                Publish unchanged rows too
  --stopAfterUnchangedPages=3         Stop live scan after N unchanged pages
  --collectedAt=2026-06-27T00:00:00Z

Environment:
  KSTARTUP_SERVICE_KEY
  CUNOTE_KSTARTUP_ARCHIVE_SOURCE=sample
  CUNOTE_KSTARTUP_ARCHIVE_COMPARE_DB=true
  CUNOTE_KSTARTUP_ARCHIVE_WRITE=true
`);
}
