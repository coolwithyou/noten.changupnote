import { eq } from "drizzle-orm";
import type { KStartupAnnouncement } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { archiveGrantAttachments } from "./grantAttachmentArchive";
import { mergeArchivedKStartupAttachments, selectKStartupAttachmentsForArchive } from "./kstartupAttachmentSelection";
import { publishKStartupGrants } from "./kstartupPublisher";
import { buildGrantArchiveAttachmentReceipts } from "./grantArchiveWriteReceipt";

loadMonorepoEnv();

const write = process.argv.includes("--write");
const confirmation = readArg("confirm");
const limit = boundedInteger(readArg("limit"), 5, 1, 100);
const scanLimit = boundedInteger(readArg("scanLimit"), 2_000, limit, 2_000);
const maxAttachmentsPerGrant = boundedInteger(readArg("maxAttachmentsPerGrant"), 3, 1, 10);
const sourceIds = csvArg(readArg("sourceIds"), 100);
const sourceIdFilter = new Set(sourceIds);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const convertHwp = !process.argv.includes("--skip-attachment-conversion");
if (write && confirmation !== "ARCHIVE_KSTARTUP_ATTACHMENTS") {
  throw new Error("--write requires --confirm=ARCHIVE_KSTARTUP_ATTACHMENTS");
}

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<KStartupAnnouncement>({ dialect: "drizzle", client: db });
  const loaded = await repositories.grants.listActiveGrants({ limit: scanLimit, asOf });
  const allCandidates = loaded
    .filter((entry) => entry.grant.source === "kstartup")
    .filter((entry) => sourceIdFilter.size === 0 || sourceIdFilter.has(entry.grant.source_id))
    .map((entry) => ({
      entry,
      selected: selectKStartupAttachmentsForArchive(
        (entry.raw.attachments ?? []).filter((attachment) => !attachment.storage_key || !attachment.sha256),
        maxAttachmentsPerGrant,
      ),
    }))
    .filter((candidate) => candidate.selected.length > 0)
    .sort((left, right) => hardTextOnlyCount(right.entry.criteria) - hardTextOnlyCount(left.entry.criteria) ||
      right.selected.length - left.selected.length ||
      left.entry.grant.source_id.localeCompare(right.entry.grant.source_id));
  const candidates = allCandidates.slice(0, limit);
  const report = {
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    mode: write ? "write" : "dry-run",
    source: "kstartup" as const,
    scanLimit,
    loadedGrantCount: loaded.length,
    totalCandidateCount: allCandidates.length,
    batchCandidateCount: candidates.length,
    selectedAttachmentCount: candidates.reduce((sum, candidate) => sum + candidate.selected.length, 0),
    maxAttachmentsPerGrant,
    sourceIds,
    candidates: candidates.map((candidate) => ({
      sourceId: candidate.entry.grant.source_id,
      title: candidate.entry.grant.title,
      selectedFilenames: candidate.selected.map((attachment) => attachment.filename),
    })),
  };
  if (!write) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const storage = createR2ObjectStorageFromEnv();
    if (!storage) throw new Error("R2 storage configuration is required for --write");
    const [cursor] = await db
      .select({ lastPage: schema.sourceCursor.lastPage })
      .from(schema.sourceCursor)
      .where(eq(schema.sourceCursor.source, "kstartup"));
    const preservedLastPage = cursor?.lastPage ?? 1;
    const results: Array<Record<string, unknown>> = [];
    for (const candidate of candidates) {
      try {
        const bundle = await archiveGrantAttachments(candidate.selected, {
          source: "kstartup",
          sourceId: candidate.entry.grant.source_id,
          collectedAt: new Date(),
          enabled: true,
          convertHwp,
          autoInstallPyhwp: false,
          allowFailures: true,
          storage,
        });
        candidate.entry.raw.attachments = mergeArchivedKStartupAttachments(
          candidate.entry.raw.attachments,
          bundle.attachments,
        );
        const published = await publishKStartupGrants(db, [candidate.entry], {
          page: preservedLastPage,
          collectedAt: new Date(),
        });
        const attachmentReceipts = buildGrantArchiveAttachmentReceipts({
          selectedFilenames: candidate.selected.map((attachment) => attachment.filename),
          bundle,
        });
        results.push({
          sourceId: candidate.entry.grant.source_id,
          archivedCount: bundle.archivedCount,
          convertedCount: bundle.convertedCount,
          failureCount: bundle.failureCount,
          conversionWarnings: published.conversionWarnings ?? [],
          ...attachmentReceipts,
        });
      } catch (error) {
        results.push({
          sourceId: candidate.entry.grant.source_id,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        });
      }
    }
    console.log(JSON.stringify({
      ...report,
      preservedLastPage,
      succeededCount: results.filter((result) => !("error" in result)).length,
      failedCount: results.filter((result) => "error" in result).length,
      results,
    }, null, 2));
  }
} finally {
  await closeCunoteDb();
}

function hardTextOnlyCount(criteria: Array<{ operator: string; kind: string }>): number {
  return criteria.filter((criterion) =>
    criterion.operator === "text_only" && (criterion.kind === "required" || criterion.kind === "exclusion")).length;
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
