import { eq } from "drizzle-orm";
import type { NormalizedGrant } from "@cunote/contracts";
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
  const loaded = await repositories.grants.listActiveGrants({ limit: input.scanLimit, asOf: input.asOf });
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
