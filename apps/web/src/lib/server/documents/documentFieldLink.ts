/**
 * 필드-문서 연결 공용 함수 (Apply Experience v2 · §6.3 / P2-3·P2-5 공유).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md §6.3.
 *
 * `grant_document_fields` 를 문서(draft)와 연결하는 단일 원천이다.
 * **연결 키: surfaceId 우선, 없으면 (source, sourceId, sourceAttachment) 폴백.**
 * 필드 패널·시드·진행률·HWPX 내보내기(label 충돌 감지)가 이 함수를 공유한다.
 *
 * **sourceAttachment 계약(중요)**: `grant_document_fields.sourceAttachment` 와
 * `grant_application_surfaces.source_attachment` 는 원본 파일명이 아니라 **R2 스토리지 키**다
 * (예: "grant-archive/bizinfo/PBLN_.../attachments/faf0ce1f...-공고.hwp" —
 * applyReconciledFields 가 surface 값을 복사하고, reviewDocsRepo 도
 * `attachment.storageKey === surface.sourceAttachment` 관례로 매칭한다).
 * 반면 draftable 문서(ApplySheet)의 `sourceAttachment` 는 **원본 파일명**이다.
 * 파일명→스토리지 키 해석의 단일 원천은 `grant_attachment_archives`(source, sourceId, filename)
 * 이며 아래 `resolveArchiveStorageKey` 가 그 조회다 — 폴백 키로 파일명을 그대로 넘기면 매칭되지 않는다.
 */
import { and, eq } from "drizzle-orm";
import type { Grant } from "@cunote/contracts";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";

/**
 * 첨부 원본 파일명 → R2 스토리지 키 해석 (단일 원천: grant_attachment_archives).
 * draftHwpxExport(원본 양식 로드)와 workspaceData(surface 매칭·필드 폴백 키)가 공유한다 — 사본 금지.
 * 행이 없으면 null, 행은 있으나 보관본 미업로드면 { storageKey: null }.
 */
export async function resolveArchiveStorageKey(input: {
  source: Grant["source"];
  sourceId: string;
  filename: string;
}): Promise<{ storageKey: string | null } | null> {
  const db = getCunoteDb();
  const [row] = await db
    .select({ storageKey: schema.grantAttachmentArchives.storageKey })
    .from(schema.grantAttachmentArchives)
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, input.source),
        eq(schema.grantAttachmentArchives.sourceId, input.sourceId),
        eq(schema.grantAttachmentArchives.filename, input.filename),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** 연결된 필드의 표준 형태(패널·시드·진행률·충돌 감지 공용 부분집합). */
export interface ConnectedDocumentField {
  fieldId: string;
  fieldKey: string;
  label: string;
  section: string | null;
  fieldType: string;
  required: boolean;
  sourceSpan: string | null;
  mappedCompanyField: string | null;
  fillStrategy: string;
  position: Record<string, unknown> | null;
  visualEvidence: Record<string, unknown> | null;
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
      fieldKey: schema.grantDocumentFields.fieldKey,
      label: schema.grantDocumentFields.label,
      section: schema.grantDocumentFields.section,
      fieldType: schema.grantDocumentFields.fieldType,
      required: schema.grantDocumentFields.required,
      sourceSpan: schema.grantDocumentFields.sourceSpan,
      mappedCompanyField: schema.grantDocumentFields.mappedCompanyField,
      fillStrategy: schema.grantDocumentFields.fillStrategy,
      position: schema.grantDocumentFields.position,
      visualEvidence: schema.grantDocumentFields.visualEvidence,
    })
    .from(schema.grantDocumentFields)
    .where(where);

  return rows.map((row) => ({
    fieldId: row.fieldId,
    fieldKey: row.fieldKey,
    label: row.label,
    section: row.section,
    fieldType: row.fieldType,
    required: row.required,
    sourceSpan: row.sourceSpan,
    mappedCompanyField: row.mappedCompanyField,
    fillStrategy: row.fillStrategy,
    position: row.position,
    visualEvidence: row.visualEvidence,
  }));
}
