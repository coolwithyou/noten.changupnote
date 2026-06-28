import { and, asc, desc, eq, gte, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { GrantDocumentCategory, GrantDocumentPreparationType, GrantRequiredDocument, GrantSource } from "@cunote/contracts";
import { normalizeGrantDocuments, type DocumentTextSource } from "@cunote/core";
import { closeCunoteDb, getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "../storage/r2ObjectStorage";
import { activeGrantApplyEndCutoff } from "../repositories/activeGrantFilter";

loadMonorepoEnv();

if (hasFlag("help")) {
  printHelp();
  process.exit(0);
}

const status = readEnum(readArg("status") ?? process.env.CUNOTE_DOCUMENT_NORMALIZE_STATUS, ["open", "active", "all"], "open");
const source = readOptionalEnum(readArg("source") ?? process.env.CUNOTE_DOCUMENT_NORMALIZE_SOURCE, ["kstartup", "bizinfo", "bizinfo_event"] as const);
const sourceId = readArg("sourceId") ?? process.env.CUNOTE_DOCUMENT_NORMALIZE_SOURCE_ID;
const limit = boundedInteger(readArg("limit") ?? process.env.CUNOTE_DOCUMENT_NORMALIZE_LIMIT, 50, 1, 5_000);
const offset = boundedInteger(readArg("offset") ?? process.env.CUNOTE_DOCUMENT_NORMALIZE_OFFSET, 0, 0, 100_000);
const asOf = dateArg(readArg("asOf") ?? process.env.CUNOTE_DOCUMENT_NORMALIZE_AS_OF) ?? new Date();
const write = hasFlag("write") || process.env.CUNOTE_DOCUMENT_NORMALIZE_WRITE === "true";
const skipMarkdown = hasFlag("skip-markdown") || process.env.CUNOTE_DOCUMENT_NORMALIZE_SKIP_MARKDOWN === "true";
const db = getCunoteDb();
const storage = skipMarkdown ? null : createR2ObjectStorageFromEnv();

try {
  const result = await normalizeGrantDocumentsFromDb({
    db,
    storage,
    status,
    source,
    sourceId,
    limit,
    offset,
    asOf,
    write,
    skipMarkdown,
  });
  console.log(JSON.stringify(result, null, 2));
} finally {
  await closeCunoteDb();
}

interface NormalizeGrantDocumentsFromDbInput {
  db: CunoteDb;
  storage: R2ObjectStorage | null;
  status: "open" | "active" | "all";
  source: GrantSource | undefined;
  sourceId: string | undefined;
  limit: number;
  offset: number;
  asOf: Date;
  write: boolean;
  skipMarkdown: boolean;
}

interface GrantDocumentNormalizationSummary {
  dryRun: boolean;
  status: "open" | "active" | "all";
  source: GrantSource | null;
  sourceId: string | null;
  selectedCount: number;
  changedCount: number;
  updatedCount: number;
  markdownReadCount: number;
  markdownFailureCount: number;
  extractedCount: number;
  normalizedDocumentCount: number;
  categoryCounts: Record<string, number>;
  preparationCounts: Record<string, number>;
  samples: Array<{
    source: GrantSource;
    sourceId: string;
    title: string;
    changed: boolean;
    documents: Array<{
      name: string;
      canonicalName: string | null;
      category: GrantDocumentCategory | null;
      preparationType: GrantDocumentPreparationType | null;
      sourceAttachment: string | null;
    }>;
  }>;
  markdownFailures: Array<{ source: GrantSource; sourceId: string; filename: string; message: string }>;
}

async function normalizeGrantDocumentsFromDb(
  input: NormalizeGrantDocumentsFromDbInput,
): Promise<GrantDocumentNormalizationSummary> {
  const rows = await readGrantRows(input);
  const attachmentRowsByGrant = await readAttachmentRowsByGrant(input.db, rows);
  const categoryCounts: Record<string, number> = {};
  const preparationCounts: Record<string, number> = {};
  const markdownFailures: Array<{ source: GrantSource; sourceId: string; filename: string; message: string }> = [];
  const samples: GrantDocumentNormalizationSummary["samples"] = [];
  let changedCount = 0;
  let updatedCount = 0;
  let markdownReadCount = 0;
  let extractedCount = 0;
  let normalizedDocumentCount = 0;

  for (const row of rows) {
    const attachments = attachmentRowsByGrant.get(grantKey(row.source, row.sourceId)) ?? [];
    const textSources: DocumentTextSource[] = [
      ...applyMethodTextSources(row.applyMethod),
      ...attachments.map((attachment) => ({
        text: attachment.filename,
        source: "portal" as const,
        sourceAttachment: attachment.filename,
        sourceField: "attachment_filename",
      })),
    ];

    if (!input.skipMarkdown && attachments.some((attachment) => attachment.markdownStorageKey)) {
      if (!input.storage) {
        for (const attachment of attachments.filter((candidate) => candidate.markdownStorageKey)) {
          markdownFailures.push({
            source: row.source,
            sourceId: row.sourceId,
            filename: attachment.filename,
            message: "R2 설정이 없어 markdown을 읽지 못했습니다.",
          });
        }
      } else {
        for (const attachment of attachments) {
          if (!attachment.markdownStorageKey) continue;
          try {
            const text = await input.storage.getObjectText(attachment.markdownStorageKey);
            markdownReadCount += 1;
            textSources.push({
              text,
              source: "portal",
              sourceAttachment: attachment.filename,
              sourceField: "attachment_markdown",
            });
          } catch (error) {
            markdownFailures.push({
              source: row.source,
              sourceId: row.sourceId,
              filename: attachment.filename,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }

    const normalized = normalizeGrantDocuments({
      documents: row.requiredDocuments as GrantRequiredDocument[] | null,
      textSources,
    });
    extractedCount += normalized.extractedCount;
    normalizedDocumentCount += normalized.normalizedCount;
    mergeCounts(categoryCounts, normalized.categoryCounts);
    mergeCounts(preparationCounts, normalized.preparationCounts);

    const nextRequiredDocuments = normalized.documents.length > 0 ? normalized.documents : null;
    const changed = stableJson(row.requiredDocuments ?? null) !== stableJson(nextRequiredDocuments);
    if (changed) {
      changedCount += 1;
      if (input.write) {
        await input.db
          .update(schema.grants)
          .set({ requiredDocuments: nextRequiredDocuments as unknown as Array<Record<string, unknown>> | null })
          .where(eq(schema.grants.id, row.id));
        updatedCount += 1;
      }
    }

    if (samples.length < 12 && (changed || normalized.documents.length > 0)) {
      samples.push({
        source: row.source,
        sourceId: row.sourceId,
        title: row.title,
        changed,
        documents: normalized.documents.slice(0, 12).map((document) => ({
          name: document.name,
          canonicalName: document.canonical_name ?? null,
          category: document.category ?? null,
          preparationType: document.preparation_type ?? null,
          sourceAttachment: document.source_attachment ?? null,
        })),
      });
    }
  }

  return {
    dryRun: !input.write,
    status: input.status,
    source: input.source ?? null,
    sourceId: input.sourceId ?? null,
    selectedCount: rows.length,
    changedCount,
    updatedCount,
    markdownReadCount,
    markdownFailureCount: markdownFailures.length,
    extractedCount,
    normalizedDocumentCount,
    categoryCounts,
    preparationCounts,
    samples,
    markdownFailures: markdownFailures.slice(0, 20),
  };
}

async function readGrantRows(input: NormalizeGrantDocumentsFromDbInput) {
  const conditions: SQL[] = [];
  if (input.status === "open") {
    conditions.push(eq(schema.grants.status, "open"));
    conditions.push(or(isNull(schema.grants.applyEnd), gte(schema.grants.applyEnd, activeGrantApplyEndCutoff(input.asOf)))!);
  } else if (input.status === "active") {
    conditions.push(inArray(schema.grants.status, ["open", "upcoming", "unknown"]));
    conditions.push(or(isNull(schema.grants.applyEnd), gte(schema.grants.applyEnd, activeGrantApplyEndCutoff(input.asOf)))!);
  }
  if (input.source) conditions.push(eq(schema.grants.source, input.source));
  if (input.sourceId) conditions.push(eq(schema.grants.sourceId, input.sourceId));

  return input.db
    .select({
      id: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
      applyEnd: schema.grants.applyEnd,
      applyMethod: schema.grants.applyMethod,
      requiredDocuments: schema.grants.requiredDocuments,
      updatedAt: schema.grants.updatedAt,
    })
    .from(schema.grants)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(schema.grants.applyEnd), desc(schema.grants.updatedAt))
    .limit(input.limit)
    .offset(input.offset);
}

type GrantRow = Awaited<ReturnType<typeof readGrantRows>>[number];
type AttachmentRow = {
  filename: string;
  markdownStorageKey: string | null;
};

async function readAttachmentRowsByGrant(db: CunoteDb, rows: GrantRow[]): Promise<Map<string, AttachmentRow[]>> {
  const sourceIdsBySource = new Map<GrantSource, Set<string>>();
  for (const row of rows) {
    const sourceIds = sourceIdsBySource.get(row.source) ?? new Set<string>();
    sourceIds.add(row.sourceId);
    sourceIdsBySource.set(row.source, sourceIds);
  }

  const rowsByGrant = new Map<string, AttachmentRow[]>();
  for (const [source, sourceIds] of sourceIdsBySource.entries()) {
    for (const sourceIdChunk of chunks([...sourceIds], 500)) {
      const attachments = await db
        .select({
          sourceId: schema.grantAttachmentArchives.sourceId,
          filename: schema.grantAttachmentArchives.filename,
          markdownStorageKey: schema.grantAttachmentArchives.markdownStorageKey,
        })
        .from(schema.grantAttachmentArchives)
        .where(and(
          eq(schema.grantAttachmentArchives.source, source),
          inArray(schema.grantAttachmentArchives.sourceId, sourceIdChunk),
        ));

      for (const attachment of attachments) {
        const key = grantKey(source, attachment.sourceId);
        const grantAttachments = rowsByGrant.get(key) ?? [];
        grantAttachments.push({
          filename: attachment.filename,
          markdownStorageKey: attachment.markdownStorageKey,
        });
        rowsByGrant.set(key, grantAttachments);
      }
    }
  }

  return rowsByGrant;
}

function applyMethodTextSources(value: Record<string, string | null> | null): DocumentTextSource[] {
  if (!value) return [];
  const text = Object.values(value).filter((item): item is string => typeof item === "string" && item.trim().length > 0).join("\n");
  return text ? [{ text, source: "portal", sourceField: "apply_method" }] : [];
}

function mergeCounts(target: Record<string, number>, source: Record<string, number>) {
  for (const [key, value] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function grantKey(source: GrantSource, sourceId: string): string {
  return `${source}:${sourceId}`;
}

function chunks<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner) => {
    if (!inner || typeof inner !== "object" || Array.isArray(inner)) return inner;
    return Object.fromEntries(Object.entries(inner).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function readEnum<T extends string>(value: string | undefined, allowed: readonly T[], fallback: T): T {
  if (!value) return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid value "${value}". Allowed: ${allowed.join(", ")}`);
}

function readOptionalEnum<T extends string>(value: string | undefined, allowed: readonly T[]): T | undefined {
  if (!value) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid value "${value}". Allowed: ${allowed.join(", ")}`);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Expected integer between ${min} and ${max}: ${value}`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function printHelp() {
  console.log([
    "Usage: pnpm normalize:grant-documents -- --status=open --limit=50 [--write]",
    "",
    "Options:",
    "  --status=open|active|all       대상 공고 범위 (default: open)",
    "  --source=kstartup|bizinfo      소스 제한",
    "  --sourceId=<id>                단일 source_id 제한",
    "  --limit=<n>                    처리 개수 (default: 50)",
    "  --offset=<n>                   offset",
    "  --asOf=<iso>                   현재 공고 판정 기준일",
    "  --skip-markdown                R2 markdown 본문 재추출 생략",
    "  --write                        DB required_documents 업데이트",
  ].join("\n"));
}
