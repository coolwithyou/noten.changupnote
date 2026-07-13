// Phase 2 T8: 변환 job 폴링 → document_artifacts upsert + extraction_status 전이 (계획 8.3).
//
// 설계 노트:
//   surface 스키마에 jobId 컬럼이 없다 (변환 서버 job 은 인메모리·임시). 대신 캐시 키가
//   sha256 + converterVersion 이므로, pending surface 마다 변환 job 을 (재)등록한다.
//   - 이미 완료된 원본이면 POST 가 cached:true + artifacts 를 즉시 반환한다.
//   - 아직이면 queued 로 돌아오고, GET 폴링으로 succeeded/partial/failed 까지 기다린다.
//   이 흐름은 T8 폴링이자 동시에 재조정 스윕(계획 2장)이다: 큐 유실·후크 누락·재시작을 회복한다.

import { and, eq, inArray, lt, or } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { GrantSource } from "@cunote/contracts";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import { CONVERSION_CONVERTER_VERSION, CONVERSION_REQUESTED_ARTIFACTS } from "./constants";
import type { ConversionClient } from "./conversionClient";
import {
  FILE_TEMPLATE_SURFACE_TYPE,
  mapJobStatusToExtractionStatus,
  transitionSurfaceStatus,
  upsertDocumentArtifacts,
} from "./surfaceConversion";

/** 폴링 대상 surface 1건 (첨부 원본 sha256/URL 조인 결과). */
export interface PendingSurfaceJob {
  surfaceId: string;
  source: GrantSource;
  sourceId: string;
  filename: string;
  format: string;
  sourceAttachment: string | null;
  sourceUrl: string | null;
  /** 원본 파일 sha256 (grant_attachment_archives 에서 조인). */
  sha256: string | null;
  /** 변환 서버가 다운로드할 원본 URL. */
  sourceObjectUrl: string | null;
}

export interface CollectPendingOptions {
  /** 한 번에 처리할 최대 surface 수 (기본 50). */
  limit?: number;
  /** 재조정 스윕: updated_at 이 이 ms 이상 지난 pending 만 (기본 0 = 전부). */
  staleMs?: number;
  /** 특정 source 로 제한. */
  source?: GrantSource;
  /** priority report에서 선택한 공고 source_id만 처리한다. */
  sourceIds?: string[];
  /** 특정 grant 의 surface 로 제한 (on-demand 폴링용). */
  grantId?: string;
}

/**
 * pending surface + 대응 첨부(sha256/archive_url)를 조인해 폴링 대상을 모은다.
 * grant_application_surfaces.sourceAttachment == grant_attachment_archives.storageKey
 * 로 매칭한다 (T7 이 storageKey 를 sourceAttachment 로 넣었다).
 */
export async function collectPendingSurfaceJobs(
  db: CunoteDb,
  options: CollectPendingOptions = {},
): Promise<PendingSurfaceJob[]> {
  const limit = options.limit ?? 50;
  const staleMs = options.staleMs ?? 0;
  const surfaces = schema.grantApplicationSurfaces;
  const archives = schema.grantAttachmentArchives;

  const conditions = [
    eq(surfaces.extractionStatus, "pending"),
    eq(surfaces.type, FILE_TEMPLATE_SURFACE_TYPE),
  ];
  if (options.source) conditions.push(eq(surfaces.source, options.source));
  if (options.sourceIds?.length) conditions.push(inArray(surfaces.sourceId, options.sourceIds));
  if (options.grantId) conditions.push(eq(surfaces.grantId, options.grantId));
  if (staleMs > 0) {
    conditions.push(lt(surfaces.updatedAt, new Date(Date.now() - staleMs)));
  }

  const rows = await db
    .select({
      surfaceId: surfaces.id,
      source: surfaces.source,
      sourceId: surfaces.sourceId,
      filename: surfaces.title,
      format: surfaces.format,
      sourceAttachment: surfaces.sourceAttachment,
      sourceUrl: surfaces.sourceUrl,
      sha256: archives.sha256,
      archiveUrl: archives.archiveUrl,
      storageKey: archives.storageKey,
    })
    .from(surfaces)
    .leftJoin(
      archives,
      and(
        eq(archives.source, surfaces.source),
        eq(archives.sourceId, surfaces.sourceId),
        or(
          eq(archives.storageKey, surfaces.sourceAttachment),
          eq(archives.filename, surfaces.title),
        ),
      ),
    )
    .where(and(...conditions))
    .limit(limit);

  // R2 아카이브분은 presigned GET URL 로 공급한다 — 저장된 archive_url(S3 엔드포인트)은
  // SigV4 없이 400 이라 변환 서버가 다운로드하지 못한다 (2026-07-08 실측). 폴링 시점마다
  // 새로 서명하므로 만료 걱정이 없다. R2 env 미설정이면 기존 폴백(archiveUrl ?? sourceUrl).
  const storage = createR2ObjectStorageFromEnv();
  return Promise.all(
    rows.map(async (row) => ({
      surfaceId: row.surfaceId,
      source: row.source,
      sourceId: row.sourceId,
      filename: row.filename,
      format: row.format,
      sourceAttachment: row.sourceAttachment,
      sourceUrl: row.sourceUrl,
      sha256: row.sha256,
      sourceObjectUrl:
        storage && row.storageKey
          ? await storage.presignGetUrl(row.storageKey)
          : row.archiveUrl ?? row.sourceUrl,
    })),
  );
}

export interface PollOneResult {
  surfaceId: string;
  filename: string;
  outcome: "preview_ready" | "failed" | "pending" | "skipped";
  artifactsInserted: number;
  artifactsUpdated: number;
  jobStatus?: string;
  message?: string;
}

export interface PollOptions {
  /** 폴링 최대 시도 횟수 (기본 120). */
  maxAttempts?: number;
  /** 폴링 간격 ms (기본 250). */
  intervalMs?: number;
}

/**
 * pending surface 1건을 변환 서버에 (재)등록하고 완료까지 폴링한 뒤
 * document_artifacts upsert + extraction_status 전이한다 (T8, 계획 8.3).
 */
export async function pollAndPersistSurfaceJob(
  db: CunoteDbSession,
  client: ConversionClient,
  job: PendingSurfaceJob,
  options: PollOptions = {},
): Promise<PollOneResult> {
  const base: PollOneResult = {
    surfaceId: job.surfaceId,
    filename: job.filename,
    outcome: "skipped",
    artifactsInserted: 0,
    artifactsUpdated: 0,
  };

  if (!job.sourceObjectUrl || !job.sha256) {
    return { ...base, message: "archive_url 또는 sha256 누락 — 첨부 미매칭" };
  }

  const maxAttempts = options.maxAttempts ?? 120;
  const intervalMs = options.intervalMs ?? 250;
  const jobId = randomUUID();

  // 1) 등록 (캐시 히트면 즉시 succeeded/partial + artifacts).
  const enqueued = await client.enqueueJob({
    jobId,
    source: job.source,
    sourceId: job.sourceId,
    surfaceId: job.surfaceId,
    filename: job.filename,
    sourceObjectUrl: job.sourceObjectUrl,
    sha256: job.sha256,
    requestedArtifacts: [...CONVERSION_REQUESTED_ARTIFACTS],
  });

  let finalStatus = enqueued.status;
  let artifacts = enqueued.cached ? enqueued.artifacts ?? [] : [];

  // 2) 아직 완료가 아니면 폴링.
  if (!isTerminal(finalStatus)) {
    for (let i = 0; i < maxAttempts; i += 1) {
      const status = await client.getJob(jobId);
      if (!status) {
        return { ...base, outcome: "pending", message: "job 조회 404 (인메모리 유실 가능)" };
      }
      finalStatus = status.status;
      if (isTerminal(finalStatus)) break;
      await sleep(intervalMs);
    }
  }

  if (!isTerminal(finalStatus)) {
    return { ...base, outcome: "pending", jobStatus: finalStatus, message: "폴링 타임아웃" };
  }

  if (finalStatus === "failed") {
    await transitionSurfaceStatus(db, job.surfaceId, "failed", CONVERSION_CONVERTER_VERSION);
    return { ...base, outcome: "failed", jobStatus: finalStatus };
  }

  // 3) succeeded/partial: artifacts 확보 (캐시 히트가 아니면 GET 으로 조회).
  if (artifacts.length === 0) {
    const artifactsResponse = await client.getArtifacts(jobId);
    artifacts = artifactsResponse?.artifacts ?? [];
  }

  const upsert = await upsertDocumentArtifacts(db, job.surfaceId, artifacts);
  // 이 지점의 finalStatus 는 succeeded|partial 뿐이라 매핑은 항상 preview_ready 지만,
  // 타입 좁힘을 위해 pending 을 명시적으로 배제한다 (pending 이면 전이 없음이 올바른 동작).
  const nextExtractionStatus = mapJobStatusToExtractionStatus(finalStatus);
  if (nextExtractionStatus !== "pending") {
    await transitionSurfaceStatus(db, job.surfaceId, nextExtractionStatus, CONVERSION_CONVERTER_VERSION);
  }

  return {
    ...base,
    outcome: "preview_ready",
    jobStatus: finalStatus,
    artifactsInserted: upsert.inserted,
    artifactsUpdated: upsert.updated,
  };
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "partial" || status === "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
