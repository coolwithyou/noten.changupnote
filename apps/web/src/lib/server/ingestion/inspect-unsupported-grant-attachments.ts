import { extname } from "node:path";
import { closeCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { getCunoteDb } from "../db/client";
import { inspectArchiveContainer, isArchiveContainerFilename } from "./archiveContainerInspection";
import { downloadAttachmentWithLimit } from "./attachmentDownload";

loadMonorepoEnv();

const source = readEnum(readArg("source"), ["bizinfo", "kstartup"], "bizinfo");
const sourceIds = csvArg(readArg("sourceIds"), 100);
const limit = boundedInteger(readArg("limit"), 20, 1, 100);
const scanLimit = boundedInteger(readArg("scanLimit"), 2_000, limit, 5_000);
const maxBytes = boundedInteger(readArg("maxBytes"), 50 * 1024 * 1024, 1_024, 100 * 1024 * 1024);
const asOf = dateArg(readArg("asOf")) ?? new Date();

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ limit: scanLimit, asOf });
  const sourceIdFilter = new Set(sourceIds);
  const targets = grants
    .filter((entry) => entry.grant.source === source)
    .filter((entry) => sourceIdFilter.size === 0 || sourceIdFilter.has(entry.grant.source_id))
    .flatMap((entry) => (entry.raw.attachments ?? [])
      .filter((attachment) => !attachment.storage_key || !attachment.sha256)
      .filter((attachment) => isArchiveContainerFilename(attachment.filename))
      .map((attachment) => ({
        sourceId: entry.grant.source_id,
        title: entry.grant.title,
        filename: attachment.filename,
        url: attachment.source_uri ?? attachment.url ?? null,
      })))
    .slice(0, limit);

  const results: Array<Record<string, unknown>> = [];
  for (const target of targets) {
    if (!target.url) {
      results.push({ ...target, error: "attachment_url_missing" });
      continue;
    }
    try {
      const { body } = await downloadAttachmentWithLimit(target.url, maxBytes);
      results.push({
        sourceId: target.sourceId,
        title: target.title,
        filename: target.filename,
        extension: extname(target.filename).toLowerCase(),
        inspection: await inspectArchiveContainer(target.filename, body),
      });
    } catch (error) {
      results.push({
        sourceId: target.sourceId,
        title: target.title,
        filename: target.filename,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      });
    }
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    source,
    requestedSourceIds: sourceIds,
    loadedGrantCount: grants.length,
    targetCount: targets.length,
    inspectedCount: results.filter((result) => "inspection" in result).length,
    actionableCount: results.filter((result) =>
      (result.inspection as { actionable?: boolean } | undefined)?.actionable === true).length,
    failureCount: results.filter((result) => "error" in result).length,
    maxBytes,
    results,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function readEnum<T extends string>(value: string | undefined, values: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((values as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid value: ${value}. Use ${values.join("|")}.`);
}

function csvArg(value: string | undefined, max: number): string[] {
  if (!value) return [];
  const values = [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  if (values.length > max) throw new Error(`sourceIds supports at most ${max} values`);
  return values;
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid integer: ${value}. Use ${min}..${max}.`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}
