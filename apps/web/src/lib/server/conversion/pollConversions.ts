// Phase 2 T8: 변환 job 폴링 → document_artifacts upsert + extraction_status 전이 (계획 8.3).
//
// 설계 노트:
//   surface 스키마에 jobId 컬럼이 없다 (변환 서버 job 은 인메모리·임시). 대신 캐시 키가
//   sha256 + converterVersion 이므로, pending surface 마다 변환 job 을 (재)등록한다.
//   - 이미 완료된 원본이면 POST 가 cached:true + artifacts 를 즉시 반환한다.
//   - 아직이면 queued 로 돌아오고, GET 폴링으로 succeeded/partial/failed 까지 기다린다.
//   이 흐름은 T8 폴링이자 동시에 재조정 스윕(계획 2장)이다: 큐 유실·후크 누락·재시작을 회복한다.

import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import type { GrantSource } from "@cunote/contracts";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { kstDayStartUtc } from "../analysis-lab/notice-period";
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
  extractionStatus?: "pending" | "failed";
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
  /** 승인된 복구에서만 failed surface도 같은 content identity로 다시 조정한다. */
  includeFailed?: boolean;
  /** Automatic supply sweep only: exclude expired/hidden inventory before LIMIT. */
  currentOpenOnly?: boolean;
  asOf?: Date;
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
  const grants = schema.grants;

  const conditions = [
    options.includeFailed
      ? inArray(surfaces.extractionStatus, ["pending", "failed"])
      : eq(surfaces.extractionStatus, "pending"),
    eq(surfaces.type, FILE_TEMPLATE_SURFACE_TYPE),
  ];
  if (options.source) conditions.push(eq(surfaces.source, options.source));
  if (options.sourceIds?.length) conditions.push(inArray(surfaces.sourceId, options.sourceIds));
  if (options.grantId) conditions.push(eq(surfaces.grantId, options.grantId));
  if (options.currentOpenOnly) {
    const today = kstDayStartUtc(options.asOf ?? new Date());
    conditions.push(eq(grants.status, "open"));
    conditions.push(eq(grants.servingState, "visible"));
    conditions.push(gte(grants.applyEnd, today));
    conditions.push(or(isNull(grants.applyStart), lte(grants.applyStart, today))!);
    // A corrected announcement leaves historical surfaces behind. Once the raw
    // snapshot has a complete set of archived attachment identities, only those belong
    // to automatic current supply. Preserve legacy/unarchived diagnostics when
    // no authoritative storage-key manifest exists; a missing SHA is not proof
    // that a current attachment was replaced.
    conditions.push(sql`not exists (
      select 1 from grant_raw current_raw
      where current_raw.source = ${surfaces.source}
        and current_raw.source_id = ${surfaces.sourceId}
        and ${surfaces.sourceAttachment} is not null
        and ${surfaces.sourceAttachment} <> ${surfaces.title}
        and exists (
          select 1 from jsonb_array_elements(
            case when jsonb_typeof(current_raw.attachments) = 'array'
              then current_raw.attachments else '[]'::jsonb end
          ) attachment
          where nullif(attachment->>'storage_key', '') is not null
        )
        and not exists (
          select 1 from jsonb_array_elements(
            case when jsonb_typeof(current_raw.attachments) = 'array'
              then current_raw.attachments else '[]'::jsonb end
          ) attachment
          where nullif(attachment->>'storage_key', '') is null
        )
        and not (current_raw.attachments @> jsonb_build_array(
          jsonb_build_object('storage_key', ${surfaces.sourceAttachment})
        ))
    )`);
  }
  if (staleMs > 0) {
    conditions.push(lt(surfaces.updatedAt, new Date(Date.now() - staleMs)));
  }

  const rows = await db
    .select({
      surfaceId: surfaces.id,
      extractionStatus: surfaces.extractionStatus,
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
    .leftJoin(grants, eq(grants.id, surfaces.grantId))
    .leftJoin(
      archives,
      and(
        eq(archives.source, surfaces.source),
        eq(archives.sourceId, surfaces.sourceId),
        or(
          eq(archives.storageKey, surfaces.sourceAttachment),
          and(
            or(isNull(surfaces.sourceAttachment), eq(surfaces.sourceAttachment, surfaces.title)),
            eq(archives.filename, surfaces.title),
          ),
        ),
      ),
    )
    .where(and(...conditions))
    .orderBy(...(options.currentOpenOnly
      ? [
          sql<number>`case when ${surfaces.title} ~* '공고|모집요강|사업안내' then 0 else 1 end`,
          asc(surfaces.updatedAt), asc(grants.applyEnd), asc(surfaces.id),
        ]
      : [asc(surfaces.updatedAt), asc(surfaces.id)]))
    .limit(limit);

  // R2 아카이브분은 presigned GET URL 로 공급한다 — 저장된 archive_url(S3 엔드포인트)은
  // SigV4 없이 400 이라 변환 서버가 다운로드하지 못한다 (2026-07-08 실측). 폴링 시점마다
  // 새로 서명하므로 만료 걱정이 없다. R2 env 미설정이면 기존 폴백(archiveUrl ?? sourceUrl).
  const storage = createR2ObjectStorageFromEnv();
  return Promise.all(
    rows.map(async (row) => ({
      surfaceId: row.surfaceId,
      extractionStatus: row.extractionStatus === "failed" ? "failed" : "pending",
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
  /** Stop starting another status request after this time; one in-flight HTTP call may finish later. */
  deadlineAtMs?: number;
  /** Explicit failed-surface recovery starts a new remote job after the previous terminal failure. */
  forceRetry?: boolean;
}

/** The converter deduplicates active work by jobId, while its SHA cache covers completed work. */
export function conversionJobId(job: PendingSurfaceJob): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([job.surfaceId, job.sha256, CONVERSION_CONVERTER_VERSION]))
    .digest("hex");
  return `surface-${digest}`;
}

/**
 * pending surface 1건을 변환 서버에 (재)등록하고 완료까지 폴링한 뒤
 * document_artifacts upsert + extraction_status 전이한다 (T8, 계획 8.3).
 */
export async function pollAndPersistSurfaceJob(
  db: CunoteDb,
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

  try {
    if (!job.sourceObjectUrl || !job.sha256) {
      await markPendingAttempt(db, job.surfaceId);
      return { ...base, message: "archive_url 또는 sha256 누락 — 첨부 미매칭" };
    }

    const maxAttempts = options.maxAttempts ?? 120;
    const intervalMs = options.intervalMs ?? 250;
    const jobId = options.forceRetry ? randomUUID() : conversionJobId(job);

    // Remote registration and polling must not hold a database transaction.
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

    if (!isTerminal(finalStatus)) {
      for (let i = 0; i < maxAttempts; i += 1) {
        if (options.deadlineAtMs !== undefined && Date.now() >= options.deadlineAtMs) break;
        const status = await client.getJob(jobId);
        if (!status) {
          await markPendingAttempt(db, job.surfaceId);
          return { ...base, outcome: "pending", message: "job 조회 404 (인메모리 유실 가능)" };
        }
        finalStatus = status.status;
        if (isTerminal(finalStatus)) break;
        const waitMs = options.deadlineAtMs === undefined
          ? intervalMs : Math.min(intervalMs, Math.max(0, options.deadlineAtMs - Date.now()));
        if (waitMs > 0) await sleep(waitMs);
      }
    }

    if (!isTerminal(finalStatus)) {
      await markPendingAttempt(db, job.surfaceId);
      return { ...base, outcome: "pending", jobStatus: finalStatus, message: "폴링 타임아웃" };
    }

    if (finalStatus === "failed") {
      await db.transaction(async (tx) => {
        const session = tx as unknown as CunoteDbSession;
        await lockAndVerifySurfaceSource(session, job);
        await transitionSurfaceStatus(session, job.surfaceId, "failed", CONVERSION_CONVERTER_VERSION);
      });
      return { ...base, outcome: "failed", jobStatus: finalStatus };
    }

    // A terminal response without artifacts cannot establish preview readiness.
    if (artifacts.length === 0) {
      const artifactsResponse = await client.getArtifacts(jobId);
      artifacts = artifactsResponse?.artifacts ?? [];
    }
    if (artifacts.length === 0) {
      await markPendingAttempt(db, job.surfaceId);
      return { ...base, outcome: "pending", jobStatus: finalStatus,
        message: "변환 완료 응답에 artifact가 없어 재조정 대기" };
    }

    return await db.transaction(async (tx) => {
      const session = tx as unknown as CunoteDbSession;
      await lockAndVerifySurfaceSource(session, job);
      const upsert = await upsertDocumentArtifacts(session, job.surfaceId, artifacts);
      const nextExtractionStatus = mapJobStatusToExtractionStatus(finalStatus);
      if (nextExtractionStatus !== "pending") {
        await transitionSurfaceStatus(session, job.surfaceId, nextExtractionStatus, CONVERSION_CONVERTER_VERSION);
      }
      return { ...base, outcome: "preview_ready" as const, jobStatus: finalStatus,
        artifactsInserted: upsert.inserted, artifactsUpdated: upsert.updated };
    });
  } catch (error) {
    // A transient provider error must not pin the first page of pending jobs forever.
    await markPendingAttempt(db, job.surfaceId).catch(() => undefined);
    throw error;
  }
}

async function lockAndVerifySurfaceSource(db: CunoteDbSession, job: PendingSurfaceJob): Promise<void> {
  // Only persistence holds the lock. Concurrent pollers cannot insert duplicate
  // artifact kinds or publish an old source after the surface was rebound.
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${job.surfaceId}, 0))`);
  const [surface] = await db.select({
    source: schema.grantApplicationSurfaces.source,
    sourceId: schema.grantApplicationSurfaces.sourceId,
    sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
    sourceUrl: schema.grantApplicationSurfaces.sourceUrl,
  }).from(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.id, job.surfaceId)).limit(1);
  if (!surface || surface.source !== job.source || surface.sourceId !== job.sourceId
    || surface.sourceAttachment !== job.sourceAttachment || surface.sourceUrl !== job.sourceUrl) {
    throw new Error("Conversion surface source changed during remote polling");
  }
  const archives = await db.select({
    storageKey: schema.grantAttachmentArchives.storageKey,
    sha256: schema.grantAttachmentArchives.sha256,
  }).from(schema.grantAttachmentArchives).where(and(
    eq(schema.grantAttachmentArchives.source, job.source),
    eq(schema.grantAttachmentArchives.sourceId, job.sourceId),
    job.sourceAttachment && job.sourceAttachment !== job.filename
      ? eq(schema.grantAttachmentArchives.storageKey, job.sourceAttachment)
      : eq(schema.grantAttachmentArchives.filename, job.filename),
  ));
  const exact = job.sourceAttachment
    ? archives.filter((item) => item.storageKey === job.sourceAttachment) : [];
  const bound = exact.length === 1 ? exact[0]
    : exact.length === 0 && archives.length === 1
      && (!job.sourceAttachment || job.sourceAttachment === job.filename) ? archives[0] : null;
  if (!bound || bound.sha256 !== job.sha256) {
    throw new Error("Conversion archived source SHA changed during remote polling");
  }
}

async function markPendingAttempt(db: CunoteDb, surfaceId: string): Promise<void> {
  await db.update(schema.grantApplicationSurfaces)
    .set({ updatedAt: new Date() })
    .where(and(eq(schema.grantApplicationSurfaces.id, surfaceId),
      eq(schema.grantApplicationSurfaces.extractionStatus, "pending")));
}

function isTerminal(status: string): boolean {
  return status === "succeeded" || status === "partial" || status === "failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
