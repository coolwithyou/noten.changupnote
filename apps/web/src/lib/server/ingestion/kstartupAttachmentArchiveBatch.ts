import { and, eq, inArray } from "drizzle-orm";
import type { GrantRaw, NormalizedGrant } from "@cunote/contracts";
import type { KStartupAnnouncement } from "@cunote/core";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createDrizzleRepositories } from "../repositories/drizzle";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import { archiveGrantAttachments } from "./grantAttachmentArchive";
import { buildGrantArchiveAttachmentReceipts } from "./grantArchiveWriteReceipt";
import {
  mergeArchivedKStartupAttachments,
  selectKStartupAttachmentsForArchive,
} from "./kstartupAttachmentSelection";
import { publishKStartupGrants } from "./kstartupPublisher";

export type KStartupAttachmentArchiveEntry = NormalizedGrant<KStartupAnnouncement>;

export interface KStartupAttachmentArchiveCandidate {
  entry: KStartupAttachmentArchiveEntry;
  selected: Array<{ filename: string; url: string | null }>;
}

export interface KStartupAttachmentArchiveRecoveryRow {
  sourceId: string;
  filename: string;
  sourceUri: string;
  archiveUrl: string | null;
  storageKey: string | null;
  contentType: string | null;
  bytes: number | null;
  sha256: string | null;
  fetchedAt: Date | null;
  conversionStatus: string | null;
  markdownUrl: string | null;
  markdownStorageKey: string | null;
  markdownSha256: string | null;
  markdownBytes: number | null;
  converter: string | null;
  convertedAt: Date | null;
  conversionError: string | null;
}

/**
 * grant_raw.attachments가 후속 수집에서 빈 배열로 덮였더라도, 명시 복구 대상은
 * grant_attachment_archives의 원본 URL/보관 상태를 되살려 다시 아카이브할 수 있게 한다.
 * 일반 활성 배치에서는 호출하지 않아 현재 detail에서 사라진 과거 첨부를 임의로 복원하지 않는다.
 */
export function mergeKStartupAttachmentArchiveRecoveryRows(
  entries: readonly KStartupAttachmentArchiveEntry[],
  archiveRows: readonly KStartupAttachmentArchiveRecoveryRow[],
): KStartupAttachmentArchiveEntry[] {
  const rowsBySourceId = new Map<string, KStartupAttachmentArchiveRecoveryRow[]>();
  for (const row of archiveRows) {
    rowsBySourceId.set(row.sourceId, [...(rowsBySourceId.get(row.sourceId) ?? []), row]);
  }
  return entries.map((entry) => {
    const recovered = (rowsBySourceId.get(entry.grant.source_id) ?? []).map(toRawAttachment);
    if (recovered.length === 0) return entry;
    return {
      ...entry,
      raw: {
        ...entry.raw,
        attachments: mergeArchivedKStartupAttachments(entry.raw.attachments, recovered),
      },
    };
  });
}

export interface PlanKStartupAttachmentArchiveBatchOptions {
  sourceIds?: readonly string[];
  prioritySourceIds?: readonly string[];
  maxGrants: number;
  maxTotalAttachments: number;
  maxAttachmentsPerGrant: number;
}

/** 전역 grant/attachment 예산을 모두 지키는 결정적 K-Startup 첨부 복구 계획. */
export function planKStartupAttachmentArchiveBatch(
  entries: readonly KStartupAttachmentArchiveEntry[],
  options: PlanKStartupAttachmentArchiveBatchOptions,
): {
  totalCandidateCount: number;
  candidates: KStartupAttachmentArchiveCandidate[];
  selectedAttachmentCount: number;
} {
  const sourceIdFilter = new Set(options.sourceIds ?? []);
  const prioritySourceIds = new Set(options.prioritySourceIds ?? []);
  const uncapped = entries
    .filter((entry) => entry.grant.source === "kstartup")
    .filter((entry) => sourceIdFilter.size === 0 || sourceIdFilter.has(entry.grant.source_id))
    .map((entry) => ({
      entry,
      selected: selectKStartupAttachmentsForArchive(
        (entry.raw.attachments ?? []).filter((attachment) => !attachment.storage_key || !attachment.sha256),
        options.maxAttachmentsPerGrant,
      ),
    }))
    .filter((candidate) => candidate.selected.length > 0)
    .sort((left, right) =>
      Number(prioritySourceIds.has(right.entry.grant.source_id)) -
        Number(prioritySourceIds.has(left.entry.grant.source_id)) ||
      hardTextOnlyCount(right.entry.criteria) - hardTextOnlyCount(left.entry.criteria) ||
      right.selected.length - left.selected.length ||
      left.entry.grant.source_id.localeCompare(right.entry.grant.source_id));

  const candidates: KStartupAttachmentArchiveCandidate[] = [];
  let remainingAttachments = Math.max(0, options.maxTotalAttachments);
  for (const candidate of uncapped) {
    if (candidates.length >= Math.max(0, options.maxGrants) || remainingAttachments <= 0) break;
    const selected = candidate.selected.slice(0, remainingAttachments);
    if (selected.length === 0) continue;
    candidates.push({ entry: candidate.entry, selected });
    remainingAttachments -= selected.length;
  }

  return {
    totalCandidateCount: uncapped.length,
    candidates,
    selectedAttachmentCount: candidates.reduce((sum, candidate) => sum + candidate.selected.length, 0),
  };
}

export interface RunKStartupAttachmentArchiveBatchInput extends PlanKStartupAttachmentArchiveBatchOptions {
  db: CunoteDb;
  storage: R2ObjectStorage | null;
  scanLimit: number;
  asOf: Date;
  collectedAt?: Date;
  write: boolean;
  convertHwp: boolean;
  autoInstallPyhwp?: boolean;
  allowFailures?: boolean;
  fetchTimeoutMs?: number;
  maxAttachmentBytes?: number;
  /** 이 시각 이후에는 새 grant 처리를 시작하지 않는다. */
  deadlineAtMs?: number;
}

export interface KStartupAttachmentArchiveBatchResult {
  generatedAt: string;
  asOf: string;
  mode: "write" | "dry-run";
  scanLimit: number;
  loadedGrantCount: number;
  totalCandidateCount: number;
  batchCandidateCount: number;
  selectedAttachmentCount: number;
  maxGrants: number;
  maxTotalAttachments: number;
  maxAttachmentsPerGrant: number;
  sourceIds: string[];
  prioritySourceIds: string[];
  preservedLastPage: number | null;
  deadlineReached: boolean;
  succeededCount: number;
  failedCount: number;
  candidates: Array<{ sourceId: string; title: string; selectedFilenames: string[] }>;
  results: Array<Record<string, unknown>>;
}

/** CLI와 cron이 공유하는 bounded K-Startup 첨부 복구 실행기. */
export async function runKStartupAttachmentArchiveBatch(
  input: RunKStartupAttachmentArchiveBatchInput,
): Promise<KStartupAttachmentArchiveBatchResult> {
  if (input.write && !input.storage) throw new Error("R2 storage configuration is required for attachment archive write");
  const repositories = createDrizzleRepositories<KStartupAnnouncement>({ dialect: "drizzle", client: input.db });
  // 명시 sourceIds는 감사·복구 대상의 정확한 선택자다. 마감된 공고도 복구할 수 있어야 하므로
  // 활성 목록을 먼저 자른 뒤 필터링하지 않고, source key로 직접 조회한다.
  // sourceIds가 없는 일반 배치/cron은 기존 활성 공고 경계를 그대로 유지한다.
  const explicitlyLoaded = input.sourceIds && input.sourceIds.length > 0
    ? (await Promise.all(
      input.sourceIds.map((sourceId) => repositories.grants.findGrantById(`kstartup:${sourceId}`)),
    )).filter((entry): entry is KStartupAttachmentArchiveEntry => entry !== null)
    : await repositories.grants.listActiveGrants({ limit: input.scanLimit, asOf: input.asOf });
  const loaded = input.sourceIds && input.sourceIds.length > 0
    ? mergeKStartupAttachmentArchiveRecoveryRows(
      explicitlyLoaded,
      await input.db
        .select({
          sourceId: schema.grantAttachmentArchives.sourceId,
          filename: schema.grantAttachmentArchives.filename,
          sourceUri: schema.grantAttachmentArchives.sourceUri,
          archiveUrl: schema.grantAttachmentArchives.archiveUrl,
          storageKey: schema.grantAttachmentArchives.storageKey,
          contentType: schema.grantAttachmentArchives.contentType,
          bytes: schema.grantAttachmentArchives.bytes,
          sha256: schema.grantAttachmentArchives.sha256,
          fetchedAt: schema.grantAttachmentArchives.fetchedAt,
          conversionStatus: schema.grantAttachmentArchives.conversionStatus,
          markdownUrl: schema.grantAttachmentArchives.markdownUrl,
          markdownStorageKey: schema.grantAttachmentArchives.markdownStorageKey,
          markdownSha256: schema.grantAttachmentArchives.markdownSha256,
          markdownBytes: schema.grantAttachmentArchives.markdownBytes,
          converter: schema.grantAttachmentArchives.converter,
          convertedAt: schema.grantAttachmentArchives.convertedAt,
          conversionError: schema.grantAttachmentArchives.conversionError,
        })
        .from(schema.grantAttachmentArchives)
        .where(and(
          eq(schema.grantAttachmentArchives.source, "kstartup"),
          inArray(schema.grantAttachmentArchives.sourceId, input.sourceIds),
        )),
    )
    : explicitlyLoaded;
  const plan = planKStartupAttachmentArchiveBatch(loaded, input);
  const [cursor] = input.write
    ? await input.db
      .select({ lastPage: schema.sourceCursor.lastPage })
      .from(schema.sourceCursor)
      .where(eq(schema.sourceCursor.source, "kstartup"))
    : [];
  const preservedLastPage = cursor?.lastPage ?? (input.write ? 1 : null);
  const collectedAt = input.collectedAt ?? new Date();
  const results: Array<Record<string, unknown>> = [];
  let deadlineReached = false;

  if (input.write) {
    for (const candidate of plan.candidates) {
      if (input.deadlineAtMs !== undefined && Date.now() >= input.deadlineAtMs) {
        deadlineReached = true;
        break;
      }
      try {
        const bundle = await archiveGrantAttachments(candidate.selected, {
          source: "kstartup",
          sourceId: candidate.entry.grant.source_id,
          collectedAt,
          enabled: true,
          convertHwp: input.convertHwp,
          autoInstallPyhwp: input.autoInstallPyhwp ?? false,
          allowFailures: input.allowFailures ?? true,
          storage: input.storage,
          ...(input.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: input.fetchTimeoutMs } : {}),
          ...(input.maxAttachmentBytes !== undefined ? { maxAttachmentBytes: input.maxAttachmentBytes } : {}),
        });
        const archivedCount = bundle.attachments.filter((attachment) =>
          Boolean(attachment.storage_key && attachment.sha256)).length;
        if (archivedCount === 0) {
          results.push({
            sourceId: candidate.entry.grant.source_id,
            archivedCount: 0,
            convertedCount: bundle.convertedCount,
            failureCount: bundle.failureCount,
            published: false,
            failures: bundle.failures,
          });
          continue;
        }
        candidate.entry.raw.attachments = mergeArchivedKStartupAttachments(
          candidate.entry.raw.attachments,
          bundle.attachments,
        );
        const published = await publishKStartupGrants(input.db, [candidate.entry], {
          page: preservedLastPage ?? 1,
          collectedAt,
        });
        results.push({
          sourceId: candidate.entry.grant.source_id,
          archivedCount: bundle.archivedCount,
          convertedCount: bundle.convertedCount,
          failureCount: bundle.failureCount,
          published: true,
          conversionWarnings: published.conversionWarnings ?? [],
          ...buildGrantArchiveAttachmentReceipts({
            selectedFilenames: candidate.selected.map((attachment) => attachment.filename),
            bundle,
          }),
        });
      } catch (error) {
        results.push({
          sourceId: candidate.entry.grant.source_id,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    asOf: input.asOf.toISOString(),
    mode: input.write ? "write" : "dry-run",
    scanLimit: input.scanLimit,
    loadedGrantCount: loaded.length,
    totalCandidateCount: plan.totalCandidateCount,
    batchCandidateCount: plan.candidates.length,
    selectedAttachmentCount: plan.selectedAttachmentCount,
    maxGrants: input.maxGrants,
    maxTotalAttachments: input.maxTotalAttachments,
    maxAttachmentsPerGrant: input.maxAttachmentsPerGrant,
    sourceIds: [...(input.sourceIds ?? [])],
    prioritySourceIds: [...(input.prioritySourceIds ?? [])],
    preservedLastPage,
    deadlineReached,
    succeededCount: results.filter((result) => result.published === true).length,
    failedCount: results.filter((result) => "error" in result || result.published === false).length,
    candidates: plan.candidates.map((candidate) => ({
      sourceId: candidate.entry.grant.source_id,
      title: candidate.entry.grant.title,
      selectedFilenames: candidate.selected.map((attachment) => attachment.filename),
    })),
    results,
  };
}

function hardTextOnlyCount(criteria: Array<{ operator: string; kind: string }>): number {
  return criteria.filter((criterion) =>
    criterion.operator === "text_only" && (criterion.kind === "required" || criterion.kind === "exclusion")).length;
}

function toRawAttachment(
  row: KStartupAttachmentArchiveRecoveryRow,
): NonNullable<GrantRaw["attachments"]>[number] {
  const conversionStatus = row.conversionStatus === "converted" ||
    row.conversionStatus === "skipped" ||
    row.conversionStatus === "failed"
    ? row.conversionStatus
    : null;
  return {
    filename: row.filename,
    url: row.archiveUrl ?? row.sourceUri,
    source_uri: row.sourceUri || null,
    archive_url: row.archiveUrl,
    storage_key: row.storageKey,
    content_type: row.contentType,
    bytes: row.bytes,
    sha256: row.sha256,
    fetched_at: row.fetchedAt?.toISOString() ?? null,
    ...(conversionStatus ? {
      conversion: {
        status: conversionStatus,
        markdown_url: row.markdownUrl,
        markdown_storage_key: row.markdownStorageKey,
        markdown_sha256: row.markdownSha256,
        markdown_bytes: row.markdownBytes,
        converter: row.converter,
        converted_at: row.convertedAt?.toISOString() ?? null,
        error: row.conversionError,
      },
    } : {}),
  };
}
