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
  /** field 에 documentCategory/documentName 이 없을 때의 기본값. */
  defaults?: { documentCategory?: string; documentName?: string };
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
    const position = field.position
      ? ({ page: field.position.page, bbox: field.position.bbox } as Record<string, unknown>)
      : null;

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
      parserVersion: RECONCILE_PARSER_VERSION,
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
  await db
    .update(schema.grantApplicationSurfaces)
    .set({ extractionStatus: "fields_ready", updatedAt: new Date() })
    .where(eq(schema.grantApplicationSurfaces.id, surfaceId));

  return {
    surfaceId,
    grantId: ctx.grantId,
    inserted,
    updated,
    extractionStatus: "fields_ready",
  };
}
