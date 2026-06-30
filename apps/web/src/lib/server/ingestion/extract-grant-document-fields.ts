import { and, asc, desc, eq, gte, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { GrantDocumentCategory, GrantDocumentPreparationType, GrantSource, RequiredDocument } from "@cunote/contracts";
import { extractGrantDocumentFields, type ExtractedGrantDocumentField, type GrantDocumentFieldMarkdown } from "@cunote/core";
import { closeCunoteDb, getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { activeGrantApplyEndCutoff } from "../repositories/activeGrantFilter";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "../storage/r2ObjectStorage";

loadMonorepoEnv();

if (hasFlag("help")) {
  printHelp();
  process.exit(0);
}

const status = readEnum(readArg("status") ?? process.env.CUNOTE_DOCUMENT_FIELD_STATUS, ["open", "active", "all"], "open");
const source = readOptionalEnum(readArg("source") ?? process.env.CUNOTE_DOCUMENT_FIELD_SOURCE, ["kstartup", "bizinfo", "bizinfo_event"] as const);
const sourceId = readArg("sourceId") ?? process.env.CUNOTE_DOCUMENT_FIELD_SOURCE_ID;
const limit = boundedInteger(readArg("limit") ?? process.env.CUNOTE_DOCUMENT_FIELD_LIMIT, 50, 1, 5_000);
const offset = boundedInteger(readArg("offset") ?? process.env.CUNOTE_DOCUMENT_FIELD_OFFSET, 0, 0, 100_000);
const asOf = dateArg(readArg("asOf") ?? process.env.CUNOTE_DOCUMENT_FIELD_AS_OF) ?? new Date();
const write = hasFlag("write") || process.env.CUNOTE_DOCUMENT_FIELD_WRITE === "true";
const skipMarkdown = hasFlag("skip-markdown") || process.env.CUNOTE_DOCUMENT_FIELD_SKIP_MARKDOWN === "true";
const db = getCunoteDb();
const storage = skipMarkdown ? null : createR2ObjectStorageFromEnv();

try {
  const result = await extractGrantDocumentFieldsFromDb({
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

interface ExtractGrantDocumentFieldsFromDbInput {
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

interface GrantDocumentFieldExtractionSummary {
  dryRun: boolean;
  status: "open" | "active" | "all";
  source: GrantSource | null;
  sourceId: string | null;
  selectedCount: number;
  grantWithFieldCount: number;
  extractedFieldCount: number;
  writtenFieldCount: number;
  markdownReadCount: number;
  markdownFailureCount: number;
  categoryCounts: Record<string, number>;
  fillStrategyCounts: Record<string, number>;
  samples: Array<{
    source: GrantSource;
    sourceId: string;
    title: string;
    fieldCount: number;
    fields: Array<{
      documentName: string;
      label: string;
      fillStrategy: string;
      mappedCompanyField: string | null;
      sourceAttachment: string | null;
    }>;
  }>;
  markdownFailures: Array<{ source: GrantSource; sourceId: string; filename: string; message: string }>;
}

async function extractGrantDocumentFieldsFromDb(
  input: ExtractGrantDocumentFieldsFromDbInput,
): Promise<GrantDocumentFieldExtractionSummary> {
  const rows = await readGrantRows(input);
  const attachmentRowsByGrant = await readAttachmentRowsByGrant(input.db, rows);
  const categoryCounts: Record<string, number> = {};
  const fillStrategyCounts: Record<string, number> = {};
  const samples: GrantDocumentFieldExtractionSummary["samples"] = [];
  const markdownFailures: GrantDocumentFieldExtractionSummary["markdownFailures"] = [];
  let grantWithFieldCount = 0;
  let extractedFieldCount = 0;
  let writtenFieldCount = 0;
  let markdownReadCount = 0;

  for (const row of rows) {
    const attachments = attachmentRowsByGrant.get(grantKey(row.source, row.sourceId)) ?? [];
    const attachmentMarkdowns: GrantDocumentFieldMarkdown[] = [];
    if (!input.skipMarkdown) {
      if (!input.storage && attachments.some((attachment) => attachment.markdownStorageKey)) {
        for (const attachment of attachments.filter((candidate) => candidate.markdownStorageKey)) {
          markdownFailures.push({
            source: row.source,
            sourceId: row.sourceId,
            filename: attachment.filename,
            message: "R2 설정이 없어 markdown을 읽지 못했습니다.",
          });
        }
      } else if (input.storage) {
        for (const attachment of attachments) {
          if (!attachment.markdownStorageKey) continue;
          try {
            attachmentMarkdowns.push({
              filename: attachment.filename,
              markdown: await input.storage.getObjectText(attachment.markdownStorageKey),
            });
            markdownReadCount += 1;
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

    const documents = toRequiredDocuments(row.requiredDocuments);
    const fields = extractGrantDocumentFields({ documents, attachmentMarkdowns });
    if (fields.length > 0) grantWithFieldCount += 1;
    extractedFieldCount += fields.length;
    for (const field of fields) {
      categoryCounts[field.documentCategory] = (categoryCounts[field.documentCategory] ?? 0) + 1;
      fillStrategyCounts[field.fillStrategy] = (fillStrategyCounts[field.fillStrategy] ?? 0) + 1;
    }

    if (input.write) {
      await input.db
        .delete(schema.grantDocumentFields)
        .where(eq(schema.grantDocumentFields.grantId, row.id));
      if (fields.length > 0) {
        await input.db.insert(schema.grantDocumentFields).values(fields.map((field) => toGrantDocumentFieldInsert(row, field)));
        writtenFieldCount += fields.length;
      }
    }

    if (samples.length < 12 && fields.length > 0) {
      samples.push({
        source: row.source,
        sourceId: row.sourceId,
        title: row.title,
        fieldCount: fields.length,
        fields: fields.slice(0, 10).map((field) => ({
          documentName: field.documentName,
          label: field.label,
          fillStrategy: field.fillStrategy,
          mappedCompanyField: field.mappedCompanyField,
          sourceAttachment: field.sourceAttachment,
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
    grantWithFieldCount,
    extractedFieldCount,
    writtenFieldCount,
    markdownReadCount,
    markdownFailureCount: markdownFailures.length,
    categoryCounts,
    fillStrategyCounts,
    samples,
    markdownFailures: markdownFailures.slice(0, 20),
  };
}

async function readGrantRows(input: ExtractGrantDocumentFieldsFromDbInput) {
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

function toRequiredDocuments(value: Array<Record<string, unknown>> | null): RequiredDocument[] {
  if (!value) return [];
  return value.flatMap((document) => {
    const name = stringValue(document.name);
    if (!name) return [];
    const result: RequiredDocument = {
      name,
      required: booleanValue(document.required, true),
      source: readDocumentSource(document.source),
    };
    const category = readDocumentCategory(document.category);
    const preparationType = readPreparationType(document.preparation_type ?? document.preparationType);
    const canonicalName = stringValue(document.canonical_name ?? document.canonicalName);
    const sourceAttachment = stringValue(document.source_attachment ?? document.sourceAttachment);
    const sourceSpan = stringValue(document.source_span ?? document.sourceSpan);
    if (category) result.category = category;
    if (preparationType) result.preparationType = preparationType;
    if (canonicalName) result.canonicalName = canonicalName;
    if (document.template_required !== undefined || document.templateRequired !== undefined) {
      result.templateRequired = booleanValue(document.template_required ?? document.templateRequired, false);
    }
    if (sourceAttachment) result.sourceAttachment = sourceAttachment;
    if (sourceSpan) result.sourceSpan = sourceSpan;
    if (typeof document.confidence === "number") result.confidence = document.confidence;
    return [result];
  });
}

function toGrantDocumentFieldInsert(row: GrantRow, field: ExtractedGrantDocumentField): typeof schema.grantDocumentFields.$inferInsert {
  return {
    grantId: row.id,
    source: row.source,
    sourceId: row.sourceId,
    documentCategory: field.documentCategory,
    documentName: field.documentName,
    sourceAttachment: field.sourceAttachment,
    fieldKey: field.fieldKey,
    label: field.label,
    section: field.section,
    fieldType: field.fieldType,
    required: field.required,
    sourceSpan: field.sourceSpan,
    mappedCompanyField: field.mappedCompanyField,
    fillStrategy: field.fillStrategy,
    confidence: field.confidence,
    parserVersion: field.parserVersion,
    updatedAt: new Date(),
  };
}

function readDocumentSource(value: unknown): RequiredDocument["source"] {
  if (value === "portal" || value === "cert" || value === "self") return value;
  return "self";
}

function readDocumentCategory(value: unknown): GrantDocumentCategory | undefined {
  if (typeof value !== "string") return undefined;
  return [
    "application_form",
    "business_plan",
    "proposal_or_intro",
    "consent_or_pledge",
    "business_registration",
    "corporate_register",
    "company_confirmation",
    "financial_tax",
    "employment_insurance",
    "shareholder",
    "bank_account",
    "estimate_budget",
    "portfolio_catalog",
    "ip_certification",
    "recommendation",
    "performance_evidence",
    "other",
  ].includes(value) ? value as GrantDocumentCategory : undefined;
}

function readPreparationType(value: unknown): GrantDocumentPreparationType | undefined {
  if (value === "write" || value === "issue" || value === "attach" || value === "portal" || value === "other") return value;
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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
    "Usage: pnpm extract:grant-document-fields -- --status=open --limit=100 [--write]",
    "",
    "Options:",
    "  --status=open|active|all       대상 공고 범위 (default: open)",
    "  --source=kstartup|bizinfo      소스 제한",
    "  --sourceId=<id>                단일 source_id 제한",
    "  --limit=<n>                    처리 개수 (default: 50)",
    "  --offset=<n>                   offset",
    "  --asOf=<iso>                   현재 공고 판정 기준일",
    "  --skip-markdown                R2 markdown 본문 읽기 생략",
    "  --write                        grant_document_fields 교체 저장",
  ].join("\n"));
}
