import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { runKStartupAttachmentArchiveBatch } from "./kstartupAttachmentArchiveBatch";

loadMonorepoEnv();

const write = process.argv.includes("--write");
const confirmation = readArg("confirm");
const limit = boundedInteger(readArg("limit"), 5, 1, 100);
const scanLimit = boundedInteger(readArg("scanLimit"), 2_000, limit, 2_000);
const maxAttachmentsPerGrant = boundedInteger(readArg("maxAttachmentsPerGrant"), 3, 1, 10);
const maxTotalAttachments = boundedInteger(
  readArg("maxTotalAttachments"),
  Math.min(1_000, limit * maxAttachmentsPerGrant),
  1,
  1_000,
);
const sourceIds = csvArg(readArg("sourceIds"), 100);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const convertHwp = !process.argv.includes("--skip-attachment-conversion");
if (write && confirmation !== "ARCHIVE_KSTARTUP_ATTACHMENTS") {
  throw new Error("--write requires --confirm=ARCHIVE_KSTARTUP_ATTACHMENTS");
}

const db = getCunoteDb();
try {
  const result = await runKStartupAttachmentArchiveBatch({
    db,
    storage: write ? createR2ObjectStorageFromEnv() : null,
    scanLimit,
    asOf,
    write,
    convertHwp,
    maxGrants: limit,
    maxTotalAttachments,
    maxAttachmentsPerGrant,
    sourceIds,
  });
  console.log(JSON.stringify({ ...result, source: "kstartup" }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}

function csvArg(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length > max) throw new Error(`sourceIds supports at most ${max} values`);
  return values;
}
