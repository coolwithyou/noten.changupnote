// 기업마당(BizInfo) 증분 수집 CLI. argv/env 파싱 + loadMonorepoEnv + db·storage 생성 후 코어(archiveBizInfoCore)를 호출한다.
// 코어 로직·타입은 archiveBizInfoCore.ts 에 있으며, /api/cron/ingest-bizinfo 라우트와 공유한다.
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { archiveBizInfo } from "./archiveBizInfoCore";

loadMonorepoEnv();

if (hasFlag("help")) {
  printHelp();
  process.exit(0);
}

const source = readEnum(readArg("source") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_SOURCE, ["sample", "live"], "sample");
const limit = optionalBoundedInteger(readArg("limit") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_LIMIT, source === "live" ? 20 : 1, 1, 10_000);
const offset = boundedInteger(readArg("offset") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_OFFSET, 0, 0, 100_000);
const sourceId = readArg("sourceId") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_SOURCE_ID;
const write = hasFlag("write") || process.env.CUNOTE_BIZINFO_ARCHIVE_WRITE === "true";
const compareDb = write || hasFlag("compare-db") || process.env.CUNOTE_BIZINFO_ARCHIVE_COMPARE_DB === "true";
const skipUnchanged = !hasFlag("publish-unchanged") && process.env.CUNOTE_BIZINFO_ARCHIVE_PUBLISH_UNCHANGED !== "true";
const allowTextOnlyFallback = hasFlag("allow-text-only-fallback") ||
  process.env.CUNOTE_BIZINFO_ARCHIVE_ALLOW_TEXT_ONLY_FALLBACK === "true";
const extractionMode = readEnum(
  readArg("extraction") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_EXTRACTION,
  ["auto", "anthropic", "text_only"],
  "auto",
);
const archiveAttachments = !hasFlag("skip-attachments") && (
  hasFlag("archive-attachments") ||
  process.env.CUNOTE_BIZINFO_ARCHIVE_ATTACHMENTS === "true" ||
  (write && source === "live")
);
const convertAttachments = archiveAttachments && !hasFlag("skip-attachment-conversion") &&
  process.env.CUNOTE_BIZINFO_ARCHIVE_CONVERT_ATTACHMENTS !== "false";
const autoInstallPyhwp = readArg("autoInstallPyhwp") !== "false" &&
  process.env.CUNOTE_BIZINFO_ARCHIVE_AUTO_INSTALL_PYHWP !== "false";
const allowAttachmentFailures = hasFlag("allow-attachment-failures") ||
  process.env.CUNOTE_BIZINFO_ARCHIVE_ALLOW_ATTACHMENT_FAILURES === "true";
const collectedAt = dateArg(readArg("collectedAt") ?? process.env.CUNOTE_BIZINFO_ARCHIVE_COLLECTED_AT) ?? new Date();
const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTROPHIC_API_KEY?.trim();
const anthropicModel = readArg("model") ?? process.env.ANTHROPIC_MODEL;
const db = compareDb ? getCunoteDb() : null;
const storage = archiveAttachments ? createR2ObjectStorageFromEnv() : null;

try {
  const result = await archiveBizInfo({
    db,
    source,
    limit,
    offset,
    sourceId,
    write,
    compareDb,
    skipUnchanged,
    allowTextOnlyFallback,
    extractionMode,
    archiveAttachments,
    convertAttachments,
    autoInstallPyhwp,
    allowAttachmentFailures,
    collectedAt,
    anthropicApiKey,
    anthropicModel,
    storage,
  });
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
): number {
  if (value === undefined || value.trim() === "") return fallback;
  return boundedInteger(value, fallback, min, max);
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function printHelp() {
  console.log(`Usage: pnpm archive:bizinfo -- [options]

Archives BizInfo support programs through the normalized grant contract.
Default mode is dry-run. Add --write to persist.

Options:
  --source=sample|live
  --limit=20
  --offset=0
  --sourceId=PBLN_...
  --compare-db
  --write
  --publish-unchanged
  --extraction=auto|anthropic|text_only
  --allow-text-only-fallback
  --archive-attachments
  --skip-attachments
  --skip-attachment-conversion
  --allow-attachment-failures
  --autoInstallPyhwp=false
  --model=claude...
  --collectedAt=2026-06-27T00:00:00Z

Environment:
  BIZINFO_SERVICE_KEY
  ANTHROPIC_API_KEY
  R2_ACCOUNT_ID/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY/R2_BUCKET/R2_BUCKET_URL
  CUNOTE_BIZINFO_ARCHIVE_SOURCE=sample
  CUNOTE_BIZINFO_ARCHIVE_WRITE=true
  CUNOTE_BIZINFO_ARCHIVE_ATTACHMENTS=true
`);
}
