// Phase 2 T7~T8: surface / document_artifacts upsert + extraction_status 전이.
// 계획: docs/phase2-conversion-server-implementation-plan.md (8.2 surface, 8.3 상태 전이)
//
// - surface upsert 키: (source, sourceId, type, sourceAttachment, sourceUrl)
//   = grant_application_surfaces_source_attachment_idx (schema.ts). 멱등.
// - artifact upsert 키: (surfaceId, kind, page) = document_artifacts_surface_kind_idx.
//   해당 인덱스는 unique 가 아니므로 애플리케이션에서 select→update/insert 로 멱등 upsert.
// - extraction_status 전이: pending -> preview_ready (succeeded/partial) | failed (job failed).

import { and, eq, isNull } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { GrantSource } from "@cunote/contracts";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { CONVERSION_CONVERTER_VERSION } from "./constants";
import type { ConversionArtifact } from "./conversionClient";

/** surface 타입: 파일 양식(hwp/hwpx/pdf/docx). 계획 8.2. */
export const FILE_TEMPLATE_SURFACE_TYPE = "file_template";

/** 변환 job 상태 → surface extraction_status 매핑 (계획 8.3). */
export type ConversionJobStatus = "queued" | "running" | "succeeded" | "partial" | "failed";

/** job 상태를 surface extraction_status 로 매핑. preview_ready 까지만 (fields_ready 는 Phase 4). */
export function mapJobStatusToExtractionStatus(
  status: ConversionJobStatus,
): "pending" | "preview_ready" | "failed" {
  if (status === "succeeded" || status === "partial") return "preview_ready";
  if (status === "failed") return "failed";
  return "pending";
}

export interface UpsertSurfaceInput {
  grantId: string;
  source: GrantSource;
  sourceId: string;
  /** 표시용 제목 (기본 filename). */
  title: string;
  /** hwp | hwpx | pdf | docx (detectConvertibleSurfaceFormat 결과). */
  format: string;
  /** 아카이브 storage_key (없으면 filename). unique 키의 일부. */
  sourceAttachment: string;
  /** 원본/아카이브 URL. unique 키의 일부. */
  sourceUrl: string | null;
  /** extraction 버전 (converterVersion). */
  extractionVersion?: string;
}

/**
 * surface 를 멱등 upsert 하고 surface id 를 반환한다 (계획 8.2).
 * 최초 생성 시 extraction_status='pending'. 재실행 시 상태를 되돌리지 않는다
 * (이미 preview_ready 인데 pending 으로 덮어쓰지 않음).
 */
export async function upsertApplicationSurface(
  db: CunoteDbSession,
  input: UpsertSurfaceInput,
): Promise<{ surfaceId: string; created: boolean }> {
  const type = FILE_TEMPLATE_SURFACE_TYPE;
  const extractionVersion = input.extractionVersion ?? CONVERSION_CONVERTER_VERSION;

  const existing = await db
    .select({ id: schema.grantApplicationSurfaces.id })
    .from(schema.grantApplicationSurfaces)
    .where(
      and(
        eq(schema.grantApplicationSurfaces.source, input.source),
        eq(schema.grantApplicationSurfaces.sourceId, input.sourceId),
        eq(schema.grantApplicationSurfaces.type, type),
        eq(schema.grantApplicationSurfaces.sourceAttachment, input.sourceAttachment),
        input.sourceUrl === null
          ? isNull(schema.grantApplicationSurfaces.sourceUrl)
          : eq(schema.grantApplicationSurfaces.sourceUrl, input.sourceUrl),
      ),
    )
    .limit(1);

  if (existing[0]) {
    // 이미 존재: 표시 메타만 갱신하고 상태는 유지 (pending 으로 되돌리지 않음).
    await db
      .update(schema.grantApplicationSurfaces)
      .set({
        grantId: input.grantId,
        title: input.title,
        format: input.format,
        extractionVersion,
        updatedAt: new Date(),
      })
      .where(eq(schema.grantApplicationSurfaces.id, existing[0].id));
    return { surfaceId: existing[0].id, created: false };
  }

  const id = randomUUID();
  await db.insert(schema.grantApplicationSurfaces).values({
    id,
    grantId: input.grantId,
    source: input.source,
    sourceId: input.sourceId,
    type,
    title: input.title,
    format: input.format,
    sourceUrl: input.sourceUrl,
    sourceAttachment: input.sourceAttachment,
    extractionStatus: "pending",
    extractionVersion,
  });
  return { surfaceId: id, created: true };
}

/**
 * 변환 서버 artifact 목록을 document_artifacts 로 멱등 upsert 한다 (계획 8.3).
 * (surfaceId, kind, page) 조합으로 기존 행이 있으면 update, 없으면 insert.
 */
export async function upsertDocumentArtifacts(
  db: CunoteDbSession,
  surfaceId: string,
  artifacts: ConversionArtifact[],
): Promise<{ inserted: number; updated: number }> {
  let inserted = 0;
  let updated = 0;

  for (const artifact of artifacts) {
    const page = artifact.page ?? null;
    const existing = await db
      .select({ id: schema.documentArtifacts.id })
      .from(schema.documentArtifacts)
      .where(
        and(
          eq(schema.documentArtifacts.surfaceId, surfaceId),
          eq(schema.documentArtifacts.kind, artifact.kind),
          page === null
            ? isNull(schema.documentArtifacts.page)
            : eq(schema.documentArtifacts.page, page),
        ),
      )
      .limit(1);

    const values = {
      kind: artifact.kind,
      page,
      storageKey: artifact.storageKey,
      url: artifact.url,
      contentType: artifact.contentType,
      sha256: artifact.sha256,
      metadata: (artifact.metadata ?? {}) as Record<string, unknown>,
    };

    if (existing[0]) {
      await db
        .update(schema.documentArtifacts)
        .set(values)
        .where(eq(schema.documentArtifacts.id, existing[0].id));
      updated += 1;
    } else {
      await db.insert(schema.documentArtifacts).values({ surfaceId, ...values });
      inserted += 1;
    }
  }

  return { inserted, updated };
}

/**
 * surface extraction_status 를 전이한다 (계획 8.3).
 * pending -> preview_ready | failed. 이미 fields_ready(Phase 4) 면 강등하지 않는다.
 */
export async function transitionSurfaceStatus(
  db: CunoteDbSession,
  surfaceId: string,
  next: "preview_ready" | "failed",
  extractionVersion?: string,
): Promise<void> {
  const rows = await db
    .select({ status: schema.grantApplicationSurfaces.extractionStatus })
    .from(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.id, surfaceId))
    .limit(1);
  const current = rows[0]?.status;
  // fields_ready 는 Phase 4 의 상위 상태이므로 강등하지 않는다.
  if (current === "fields_ready") return;

  await db
    .update(schema.grantApplicationSurfaces)
    .set({
      extractionStatus: next,
      ...(extractionVersion ? { extractionVersion } : {}),
      updatedAt: new Date(),
    })
    .where(eq(schema.grantApplicationSurfaces.id, surfaceId));
}
