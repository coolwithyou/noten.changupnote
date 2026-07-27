import { eq } from "drizzle-orm";
import type { BizInfoProgram } from "@cunote/core";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createDrizzleRepositories } from "../repositories/drizzle";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import {
  archiveGrantAttachments,
  type GrantImageOcrAdapter,
} from "./grantAttachmentArchive";
import { buildGrantArchiveAttachmentReceipts } from "./grantArchiveWriteReceipt";
import { publishBizInfoGrants } from "./bizinfoPublisher";
import {
  mergeArchivedKStartupAttachments,
  selectKStartupAttachmentsForArchive,
} from "./kstartupAttachmentSelection";

export interface RunBizInfoAttachmentArchiveBatchInput {
  db: CunoteDb;
  storage: R2ObjectStorage | null;
  scanLimit: number;
  asOf: Date;
  write: boolean;
  convertHwp: boolean;
  maxGrants: number;
  maxTotalAttachments: number;
  maxAttachmentsPerGrant: number;
  reprocessMissingMarkdown?: boolean;
  archiveMaxEntries?: number;
  sourceIds?: readonly string[];
  imageOcr?: GrantImageOcrAdapter | null;
  imageOcrName?: string;
  collectedAt?: Date;
  fetchTimeoutMs?: number;
  maxAttachmentBytes?: number;
  /** 이 시각 이후에는 새 grant 처리를 시작하지 않는다. */
  deadlineAtMs?: number;
}

export interface BizInfoAttachmentArchiveBatchResult {
  generatedAt: string;
  asOf: string;
  mode: "write" | "dry-run";
  source: "bizinfo";
  scanLimit: number;
  loadedGrantCount: number;
  totalCandidateCount: number;
  batchCandidateCount: number;
  selectedAttachmentCount: number;
  maxGrants: number;
  maxTotalAttachments: number;
  maxAttachmentsPerGrant: number;
  imageOcr: string;
  sourceIds: string[];
  candidates: Array<{ sourceId: string; title: string; selectedFilenames: string[] }>;
  preservedLastPage: number | null;
  deadlineReached: boolean;
  succeededCount: number;
  failedCount: number;
  results: Array<Record<string, unknown>>;
}

/**
 * 활성 Bizinfo 원본 첨부를 bounded batch로 R2에 보관하고 기존 publisher 계약으로
 * archive/surface 상태를 갱신한다. CLI와 독립 input-preparation worker가 같은 코어를
 * 사용해 수동 백필과 상시 실행의 선택·쓰기 의미가 갈라지지 않게 한다.
 */
export async function runBizInfoAttachmentArchiveBatch(
  input: RunBizInfoAttachmentArchiveBatchInput,
): Promise<BizInfoAttachmentArchiveBatchResult> {
  if (input.write && !input.storage) {
    throw new Error("R2 storage configuration is required for attachment archive write");
  }
  const repositories = createDrizzleRepositories<BizInfoProgram>({
    dialect: "drizzle",
    client: input.db,
  });
  const requestedSourceIds = [...new Set(input.sourceIds ?? [])];
  const loaded = requestedSourceIds.length > 0
    ? (await Promise.all(requestedSourceIds.map((sourceId) =>
      repositories.grants.findGrantById(`bizinfo:${sourceId}`))))
      .flatMap((entry) => entry ? [entry] : [])
    : await repositories.grants.listActiveGrants({
      limit: input.scanLimit,
      asOf: input.asOf,
    });
  const sourceIdFilter = new Set(requestedSourceIds);
  const allCandidates = loaded
    .filter((entry) => entry.grant.source === "bizinfo")
    .filter((entry) => sourceIdFilter.size === 0 || sourceIdFilter.has(entry.grant.source_id))
    .map((entry) => ({
      entry,
      selected: selectKStartupAttachmentsForArchive(
        entry.raw.attachments ?? [],
        input.maxAttachmentsPerGrant,
        {
          includeImages: Boolean(input.imageOcr),
          ...(input.reprocessMissingMarkdown !== undefined
            ? { reprocessMissingMarkdown: input.reprocessMissingMarkdown }
            : {}),
        },
      ),
    }))
    .filter((candidate) => candidate.selected.length > 0)
    .sort((left, right) =>
      hardTextOnlyCount(right.entry.criteria) - hardTextOnlyCount(left.entry.criteria)
      || right.selected.length - left.selected.length
      || left.entry.grant.source_id.localeCompare(right.entry.grant.source_id));

  const candidates: typeof allCandidates = [];
  let remainingAttachments = Math.max(0, input.maxTotalAttachments);
  for (const candidate of allCandidates) {
    if (candidates.length >= input.maxGrants || remainingAttachments <= 0) break;
    const selected = candidate.selected.slice(0, remainingAttachments);
    if (selected.length === 0) continue;
    candidates.push({ ...candidate, selected });
    remainingAttachments -= selected.length;
  }

  const [cursor] = input.write
    ? await input.db
      .select({ lastPage: schema.sourceCursor.lastPage })
      .from(schema.sourceCursor)
      .where(eq(schema.sourceCursor.source, "bizinfo"))
    : [];
  const preservedLastPage = cursor?.lastPage ?? (input.write ? 1 : null);
  const collectedAt = input.collectedAt ?? new Date();
  const results: Array<Record<string, unknown>> = [];
  let deadlineReached = false;

  if (input.write) {
    for (const candidate of candidates) {
      if (input.deadlineAtMs !== undefined && Date.now() >= input.deadlineAtMs) {
        deadlineReached = true;
        break;
      }
      try {
        const bundle = await archiveGrantAttachments(candidate.selected, {
          source: "bizinfo",
          sourceId: candidate.entry.grant.source_id,
          collectedAt,
          enabled: true,
          convertHwp: input.convertHwp,
          autoInstallPyhwp: false,
          allowFailures: true,
          storage: input.storage,
          ...(input.imageOcr ? { imageOcr: input.imageOcr } : {}),
          ...(input.fetchTimeoutMs !== undefined
            ? { fetchTimeoutMs: input.fetchTimeoutMs }
            : {}),
          ...(input.maxAttachmentBytes !== undefined
            ? { maxAttachmentBytes: input.maxAttachmentBytes }
            : {}),
          ...(input.archiveMaxEntries !== undefined
            ? { archiveMaxEntries: input.archiveMaxEntries }
            : {}),
        });
        candidate.entry.raw.attachments = mergeArchivedKStartupAttachments(
          candidate.entry.raw.attachments,
          bundle.attachments,
        );
        const published = await publishBizInfoGrants(input.db, [candidate.entry], {
          page: preservedLastPage ?? 1,
          collectedAt,
        });
        results.push({
          sourceId: candidate.entry.grant.source_id,
          archivedCount: bundle.archivedCount,
          convertedCount: bundle.convertedCount,
          failureCount: bundle.failureCount,
          conversionWarnings: published.conversionWarnings ?? [],
          ...buildGrantArchiveAttachmentReceipts({
            selectedFilenames: candidate.selected.map((attachment) => attachment.filename),
            bundle,
          }),
        });
      } catch (error) {
        results.push({
          sourceId: candidate.entry.grant.source_id,
          error: error instanceof Error
            ? error.message.slice(0, 500)
            : String(error).slice(0, 500),
        });
      }
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    asOf: input.asOf.toISOString(),
    mode: input.write ? "write" : "dry-run",
    source: "bizinfo",
    scanLimit: input.scanLimit,
    loadedGrantCount: loaded.length,
    totalCandidateCount: allCandidates.length,
    batchCandidateCount: candidates.length,
    selectedAttachmentCount: candidates.reduce(
      (sum, candidate) => sum + candidate.selected.length,
      0,
    ),
    maxGrants: input.maxGrants,
    maxTotalAttachments: input.maxTotalAttachments,
    maxAttachmentsPerGrant: input.maxAttachmentsPerGrant,
    imageOcr: input.imageOcrName ?? (input.imageOcr ? "configured" : "none"),
    sourceIds: [...(input.sourceIds ?? [])],
    candidates: candidates.map((candidate) => ({
      sourceId: candidate.entry.grant.source_id,
      title: candidate.entry.grant.title,
      selectedFilenames: candidate.selected.map((attachment) => attachment.filename),
    })),
    preservedLastPage,
    deadlineReached,
    succeededCount: results.filter((result) => !("error" in result)).length,
    failedCount: results.filter((result) => "error" in result).length,
    results,
  };
}

function hardTextOnlyCount(criteria: Array<{ operator: string; kind: string }>): number {
  return criteria.filter((criterion) =>
    criterion.operator === "text_only"
    && (criterion.kind === "required" || criterion.kind === "exclusion")).length;
}
