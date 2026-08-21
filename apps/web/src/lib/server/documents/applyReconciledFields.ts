/**
 * Reconciled 필드 반영 경로 (Phase 4 [F5] · 마스터 설계 §8.6 · 11장 백필 전략).
 *
 * reconcileFieldCandidates() 출력(`ReconciledField[]`)을 grant_document_fields 로 upsert 하고
 * surface 의 extraction_status 를 `fields_ready` 로 전이한다.
 *
 *   - upsert 키: (surfaceId, fieldKey). unique 인덱스가 없어 앱측 select→update/insert.
 *   - parserVersion = `reconcile-v0` (§11 — reconciliation 도입분 표식).
 *   - 기존 legacy 경로(grantDocumentFields.ts, parser_version=grant-document-field-extraction-v1)는
 *     무변경 — 마스터 11장 백필 전략 3(legacy 읽기 유지).
 */
import { eq } from "drizzle-orm";
import type { ReconciledField } from "@cunote/core";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";

export const RECONCILE_PARSER_VERSION = "reconcile-v0";

export interface ApplyReconciledFieldsResult {
  surfaceId: string;
  grantId: string;
  inserted: number;
  updated: number;
  extractionStatus: string;
}

export interface ApplyReconciledFieldsInput {
  db: CunoteDbSession;
  surfaceId: string;
  fields: ReconciledField[];
  /** 저장 provenance. 생략하면 기존 review/reconcile 경로 버전을 유지한다. */
  parserVersion?: string;
  /** 자동 분석기의 surface 상태 provenance. 기존 리뷰 경로는 생략해 현재 값을 보존한다. */
  extractionVersion?: string;
  /** 0~1 필드 커버리지 신뢰도. 기존 리뷰 경로는 생략해 현재 값을 보존한다. */
  extractionConfidence?: number;
  /** field 에 documentCategory/documentName 이 없을 때의 기본값. */
  defaults?: { documentCategory?: string; documentName?: string };
}

/**
 * Reconciler가 source SHA에 결속한 구조 위치를 DB JSONB에 손실 없이 보존한다.
 * page/bbox만 남기면 동일 라벨의 occurrence tie-break가 사라져 다시 ambiguous가 된다.
 */
export function serializeReconciledFieldPosition(
  position: ReconciledField["position"],
): Record<string, unknown> | null {
  return position ? { ...position } : null;
}

interface SurfaceContext {
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  sourceAttachment: string | null;
}

async function loadSurfaceContext(
  db: CunoteDbSession,
  surfaceId: string,
): Promise<SurfaceContext> {
  const rows = await db
    .select({
      grantId: schema.grantApplicationSurfaces.grantId,
      source: schema.grantApplicationSurfaces.source,
      sourceId: schema.grantApplicationSurfaces.sourceId,
      title: schema.grantApplicationSurfaces.title,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
    })
    .from(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.id, surfaceId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error(`surface 를 찾을 수 없습니다: ${surfaceId}`);
  return row;
}

export async function applyReconciledFields(
  input: ApplyReconciledFieldsInput,
): Promise<ApplyReconciledFieldsResult> {
  const { db, surfaceId, fields } = input;
  const parserVersion = input.parserVersion?.trim() || RECONCILE_PARSER_VERSION;
  const ctx = await loadSurfaceContext(db, surfaceId);

  // (surfaceId, fieldKey) 기존 행 조회 → fieldKey 별 id 맵.
  const existingRows = await db
    .select({ id: schema.grantDocumentFields.id, fieldKey: schema.grantDocumentFields.fieldKey })
    .from(schema.grantDocumentFields)
    .where(eq(schema.grantDocumentFields.surfaceId, surfaceId));
  const existingByKey = new Map<string, string>();
  for (const row of existingRows) existingByKey.set(row.fieldKey, row.id);

  let inserted = 0;
  let updated = 0;

  for (const field of fields) {
    const documentCategory = field.documentCategory ?? input.defaults?.documentCategory ?? "other";
    const documentName = field.documentName ?? input.defaults?.documentName ?? ctx.title;
    const position = serializeReconciledFieldPosition(field.position);

    const values = {
      grantId: ctx.grantId,
      source: ctx.source as (typeof schema.grantDocumentFields.$inferInsert)["source"],
      sourceId: ctx.sourceId,
      documentCategory,
      documentName,
      sourceAttachment: ctx.sourceAttachment,
      fieldKey: field.fieldKey,
      label: field.label,
      section: field.section,
      fieldType: field.fieldType,
      required: field.required,
      sourceSpan: field.sourceSpan,
      mappedCompanyField: field.mappedCompanyField,
      fillStrategy: field.fillStrategy,
      confidence: field.confidence,
      parserVersion,
      surfaceId,
      position,
      visualEvidence: field.visualEvidence,
      textEvidence: field.textEvidence,
      reviewRequired: field.reviewRequired,
    };

    const existingId = existingByKey.get(field.fieldKey);
    if (existingId) {
      await db
        .update(schema.grantDocumentFields)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(schema.grantDocumentFields.id, existingId));
      updated += 1;
    } else {
      await db.insert(schema.grantDocumentFields).values(values);
      inserted += 1;
    }
  }

  // surface extraction_status → fields_ready (Phase 4 상위 상태).
  const surfaceUpdate: Partial<typeof schema.grantApplicationSurfaces.$inferInsert> = {
    extractionStatus: "fields_ready",
    updatedAt: new Date(),
  };
  if (input.extractionVersion) surfaceUpdate.extractionVersion = input.extractionVersion;
  if (typeof input.extractionConfidence === "number") {
    surfaceUpdate.confidence = Math.min(1, Math.max(0, input.extractionConfidence));
  }
  await db
    .update(schema.grantApplicationSurfaces)
    .set(surfaceUpdate)
    .where(eq(schema.grantApplicationSurfaces.id, surfaceId));

  return {
    surfaceId,
    grantId: ctx.grantId,
    inserted,
    updated,
    extractionStatus: "fields_ready",
  };
}
