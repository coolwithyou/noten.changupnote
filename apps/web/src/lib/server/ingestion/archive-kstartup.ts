// K-Startup 증분 수집 CLI. argv/env 파싱 + loadMonorepoEnv 후 코어(archiveKStartupCore)를 호출한다.
// 코어 로직·타입은 archiveKStartupCore.ts 에 있으며, /api/cron/ingest-kstartup 라우트와 공유한다.
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { archiveKStartup } from "./archiveKStartupCore";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";

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
const details = resolveDetailsFlag(source);
const archiveAttachments = hasFlag("archive-attachments") ||
  process.env.CUNOTE_KSTARTUP_ARCHIVE_ATTACHMENTS === "true";
const maxAttachmentsPerGrant = boundedInteger(readArg("maxAttachmentsPerGrant"), 3, 1, 10);
const convertHwpAttachments = !hasFlag("skip-attachment-conversion") &&
  process.env.CUNOTE_KSTARTUP_ARCHIVE_CONVERT_ATTACHMENTS !== "false";
const allowAttachmentFailures = hasFlag("allow-attachment-failures") ||
  process.env.CUNOTE_KSTARTUP_ARCHIVE_ALLOW_ATTACHMENT_FAILURES === "true";
const storage = archiveAttachments ? createR2ObjectStorageFromEnv() : null;

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
    details,
    archiveAttachments,
    storage,
    maxAttachmentsPerGrant,
    convertHwpAttachments,
    allowAttachmentFailures,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeCunoteDb();
}

/** 상세 수집 정책: --details / --no-details 우선, 없으면 env, 기본은 live 소스일 때 on. */
function resolveDetailsFlag(source: "sample" | "live"): boolean {
  if (hasFlag("no-details")) return false;
  if (hasFlag("details")) return true;
  const env = process.env.CUNOTE_ARCHIVE_KSTARTUP_DETAILS;
  if (env === "true") return true;
  if (env === "false") return false;
  return source === "live";
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
  --details / --no-details           Fetch detail pages for new/changed rows (default: on for live)
  --archive-attachments              Download selected detail attachments and archive them to R2
  --maxAttachmentsPerGrant=3         Max convertible attachments archived per grant
  --skip-attachment-conversion       Skip local HWP-to-markdown conversion
  --allow-attachment-failures        Continue after individual attachment failures
  --collectedAt=2026-06-27T00:00:00Z

Detail collection (robots-safe):
  기본은 detail page(/web/contents/*)만 수집하고 첨부는 filename + URL metadata만 저장합니다.
  --archive-attachments를 명시한 경우에만 선택된 변환 가능 첨부 본문을 다운로드해 R2에 보관합니다.

Environment:
  KSTARTUP_SERVICE_KEY
  CUNOTE_KSTARTUP_ARCHIVE_SOURCE=sample
  CUNOTE_KSTARTUP_ARCHIVE_COMPARE_DB=true
  CUNOTE_KSTARTUP_ARCHIVE_WRITE=true
  CUNOTE_ARCHIVE_KSTARTUP_DETAILS=true|false
  CUNOTE_KSTARTUP_ARCHIVE_ATTACHMENTS=true
`);
}
