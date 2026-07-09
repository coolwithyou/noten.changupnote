/**
 * 필드-문서 연결 공용 함수 (Apply Experience v2 · §6.3 / P2-3·P2-5 공유).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md §6.3.
 *
 * `grant_document_fields` 를 문서(draft)와 연결하는 단일 원천이다.
 * **연결 키: surfaceId 우선, 없으면 (source, sourceId, sourceAttachment) 폴백.**
 * 필드 패널·시드·진행률·HWPX 내보내기(label 충돌 감지)가 이 함수를 공유한다.
 */
import { and, eq } from "drizzle-orm";
import type { Grant } from "@cunote/contracts";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";

/** 연결된 필드의 표준 형태(패널·시드·진행률·충돌 감지 공용 부분집합). */
export interface ConnectedDocumentField {
  fieldId: string;
  label: string;
  section: string | null;
  fieldType: string;
  required: boolean;
  mappedCompanyField: string | null;
  position: Record<string, unknown> | null;
}

/**
 * 문서에 연결된 grant_document_fields 를 로드한다.
 * surfaceId 가 주어지면 그것을 우선하고, 없으면 (source, sourceId, sourceAttachment) 로 폴백한다.
 * 어느 키로도 특정할 수 없으면 빈 배열.
 */
export async function loadConnectedDocumentFields(input: {
  source: Grant["source"];
  sourceId: string;
  surfaceId?: string | null;
  sourceAttachment?: string | null;
}): Promise<ConnectedDocumentField[]> {
  const db = getCunoteDb();

  const where = input.surfaceId
    ? eq(schema.grantDocumentFields.surfaceId, input.surfaceId)
    : input.sourceAttachment
      ? and(
          eq(schema.grantDocumentFields.source, input.source),
          eq(schema.grantDocumentFields.sourceId, input.sourceId),
          eq(schema.grantDocumentFields.sourceAttachment, input.sourceAttachment),
        )
      : null;

  if (!where) return [];

  const rows = await db
    .select({
      fieldId: schema.grantDocumentFields.id,
      label: schema.grantDocumentFields.label,
      section: schema.grantDocumentFields.section,
      fieldType: schema.grantDocumentFields.fieldType,
      required: schema.grantDocumentFields.required,
      mappedCompanyField: schema.grantDocumentFields.mappedCompanyField,
      position: schema.grantDocumentFields.position,
    })
    .from(schema.grantDocumentFields)
    .where(where);

  return rows.map((row) => ({
    fieldId: row.fieldId,
    label: row.label,
    section: row.section,
    fieldType: row.fieldType,
    required: row.required,
    mappedCompanyField: row.mappedCompanyField,
    position: row.position,
  }));
}
