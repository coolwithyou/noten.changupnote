// Phase 2 T7: 아카이브 완료 후크 — surface upsert + 변환 job 등록 (계획 8.1~8.2).
//
// normalizedGrantPublisher 가 grant_attachment_archives 를 upsert 한 뒤 이 후크를 호출한다.
// grantId / DB 세션이 확보된 지점이므로 여기서 surface(=NOT NULL grantId FK)를 만든다.
//
// 원칙(계획 8.1):
//   - fire-and-forget. 변환 실패가 아카이브를 롤백하지 않는다.
//   - storage_key + sha256 이 확보된 첨부만 surface 를 만든다.
//   - CONVERSION_SERVER_URL/SECRET 미설정이면 job 등록만 no-op (보관 완료 surface 는 pending 유지).
//   - 캐시 히트(cached:true)면 job 없이 artifact upsert + 상태 전이까지 즉시 수행한다.
//   - 개별 첨부 실패는 warning 으로 삼키고 다음 첨부로 진행한다.

import { randomUUID } from "node:crypto";
import type { GrantSource } from "@cunote/contracts";
import type { CunoteDbSession } from "../db/client";
import { createR2ObjectStorageFromEnv } from "../storage/r2ObjectStorage";
import {
  detectConvertibleSurfaceFormat,
  type ConvertibleSurfaceFormat,
} from "../ingestion/grantAttachmentArchive";
import { CONVERSION_CONVERTER_VERSION, CONVERSION_REQUESTED_ARTIFACTS } from "./constants";
import {
  createConversionClientFromEnv,
  type ConversionClient,
} from "./conversionClient";
import {
  mapJobStatusToExtractionStatus,
  transitionSurfaceStatus,
  upsertApplicationSurface,
  upsertDocumentArtifacts,
} from "./surfaceConversion";

/** 아카이브된 첨부 1건 (surface/변환 대상 후보). */
export interface ArchivedAttachmentRef {
  filename: string;
  /** R2 아카이브 storage_key. sha256과 함께 있어야 surface를 등록한다. */
  storageKey: string | null;
  /** R2 아카이브 공개 URL (변환 서버가 다운로드). */
  archiveUrl: string | null;
  /** 원본 URL (fallback). */
  sourceUri: string | null;
  /** 원본 파일 sha256 (캐시 키의 일부). */
  sha256: string | null;
  /**
   * 아카이브 시점 매직 바이트로 확정한 surface 포맷(설계 결정 6, 확장자 위장 교정).
   *  - 생략(undefined): 바이트 검출 없음 → filename 확장자로 폴백(byte-less/구 호출부 하위호환).
   *  - null: 바이트 검출 결과 변환 대상이 아님 → skip(확장자로 되살리지 않는다).
   *  - "hwp"|"hwpx"|"pdf"|"docx": 확정 포맷.
   */
  detectedFormat?: ConvertibleSurfaceFormat | null;
}

export interface RegisterAttachmentConversionsInput {
  grantId: string;
  source: GrantSource;
  sourceId: string;
  attachments: ArchivedAttachmentRef[];
  /** 변환 클라이언트 주입 (미주입 시 env 에서 생성; 없으면 no-op). */
  client?: ConversionClient | null;
}

export interface RegisterAttachmentConversionsResult {
  surfacesUpserted: number;
  jobsEnqueued: number;
  cacheHits: number;
  skipped: number;
  warnings: string[];
}

/**
 * 변환 대상 첨부에 대해 surface 를 만들고 변환 job 을 등록한다 (T7).
 * 모든 실패는 warnings 로 수집하고 절대 throw 하지 않는다 (아카이브 보호).
 */
export async function registerAttachmentConversions(
  db: CunoteDbSession,
  input: RegisterAttachmentConversionsInput,
): Promise<RegisterAttachmentConversionsResult> {
  const warnings: string[] = [];
  let surfacesUpserted = 0;
  let jobsEnqueued = 0;
  let cacheHits = 0;
  let skipped = 0;

  // client 미주입이면 env 에서 시도. 둘 다 없으면 job 등록은 건너뛰되 surface 는 계속 만든다.
  const client =
    input.client !== undefined ? input.client : createConversionClientFromEnv();

  for (const attachment of input.attachments) {
    // 바이트로 확정된 포맷이 있으면 확장자보다 우선한다(위장 교정). detectedFormat 가 명시적으로 null 이면
    // "바이트 검사 결과 대상 아님"이므로 확장자로 되살리지 않고 skip 한다. 생략됐을 때만 확장자 폴백.
    const format =
      attachment.detectedFormat !== undefined
        ? attachment.detectedFormat
        : detectConvertibleSurfaceFormat(attachment.filename);
    if (!format) {
      skipped += 1;
      continue;
    }

    // surface는 변환 가능한 아카이브 객체의 표현이다. 원본 URL만 있는 첨부를 먼저
    // pending surface로 만들면 이후 아카이브가 누락돼도 영구 대기열처럼 보이므로,
    // 안정적인 객체 정체성(storageKey + sha256)이 확보된 뒤에만 등록한다.
    if (!attachment.storageKey || !attachment.sha256) {
      skipped += 1;
      warnings.push(
        `surface 등록 건너뜀 (${attachment.filename}): storage_key 또는 sha256 누락`,
      );
      continue;
    }

    const sourceAttachment = attachment.storageKey;
    const sourceUrl = attachment.archiveUrl ?? attachment.sourceUri ?? null;

    // 1) surface upsert (pending). 실패해도 다음 첨부로.
    let surfaceId: string;
    try {
      const upserted = await upsertApplicationSurface(db, {
        grantId: input.grantId,
        source: input.source,
        sourceId: input.sourceId,
        title: attachment.filename,
        format,
        sourceAttachment,
        sourceUrl,
        extractionVersion: CONVERSION_CONVERTER_VERSION,
      });
      surfaceId = upserted.surfaceId;
      surfacesUpserted += 1;
    } catch (error) {
      warnings.push(
        `surface upsert 실패 (${attachment.filename}): ${errorMessage(error)}`,
      );
      continue;
    }

    // 2) 변환 job 등록. client 없으면(env 미설정) 여기서 멈춤 — surface 는 pending 으로 남는다.
    if (!client) continue;

    // R2 아카이브분은 presigned GET URL 로 공급한다 — archive_url(S3 엔드포인트)은 SigV4 없이
    // 400 이라 변환 서버가 다운로드하지 못한다. presign 실패/미설정이면 기존 폴백 유지.
    let sourceObjectUrl = attachment.archiveUrl ?? attachment.sourceUri;
    if (attachment.storageKey) {
      try {
        const storage = createR2ObjectStorageFromEnv();
        if (storage) sourceObjectUrl = await storage.presignGetUrl(attachment.storageKey);
      } catch (error) {
        warnings.push(`presign 실패 (${attachment.filename}): ${errorMessage(error)} — archive_url 폴백`);
      }
    }
    if (!sourceObjectUrl) {
      warnings.push(
        `변환 job 등록 건너뜀 (${attachment.filename}): archive_url 또는 source_uri 누락`,
      );
      continue;
    }

    try {
      const response = await client.enqueueJob({
        jobId: randomUUID(),
        source: input.source,
        sourceId: input.sourceId,
        surfaceId,
        filename: attachment.filename,
        sourceObjectUrl,
        sha256: attachment.sha256,
        requestedArtifacts: [...CONVERSION_REQUESTED_ARTIFACTS],
      });

      if (response.cached && response.artifacts && response.artifacts.length > 0) {
        // 캐시 히트: job 없이 artifact upsert + 상태 전이 즉시 (계획 8.1).
        // 캐시는 터미널 상태만 저장하므로 매핑이 pending 인 경우는 없지만, 타입 좁힘을 위해 배제한다.
        await upsertDocumentArtifacts(db, surfaceId, response.artifacts);
        const nextExtractionStatus = mapJobStatusToExtractionStatus(response.status);
        if (nextExtractionStatus !== "pending") {
          await transitionSurfaceStatus(db, surfaceId, nextExtractionStatus, CONVERSION_CONVERTER_VERSION);
        }
        cacheHits += 1;
      } else {
        jobsEnqueued += 1;
      }
    } catch (error) {
      warnings.push(
        `변환 job 등록 실패 (${attachment.filename}): ${errorMessage(error)}`,
      );
    }
  }

  return { surfacesUpserted, jobsEnqueued, cacheHits, skipped, warnings };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
