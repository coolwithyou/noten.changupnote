/**
 * 사용자용 문서 Preview Viewer 서버 로더 (Phase 3, 마스터 설계 19장 · 기능 9.3/9.4).
 *
 * grantId → 지원사업 문서 표면(surfaces) + 페이지 이미지 artifact(page_image) + 필드(position 포함)
 * 를 한 번에 로드해 DTO 로 정규화한다. 좌표계는 §8.4(0~1, top-left)를 따르며 `parsePositionBbox`
 * 로 수렴시킨다.
 *
 * 기존 `grantDocumentFields.ts` 는 건드리지 않는다 — 이 로더는 position/좌표를 포함해 직접 SELECT 한다.
 * migrations 에 RLS 가 켜져 있지 않으므로 plain 커넥션으로 읽는다 (인증은 상위 라우트/페이지에서 이미 처리).
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { parsePositionBbox, parsePositionPage, type NormalizedBox } from "@/lib/documents/bbox";

export interface PreviewGrant {
  id: string;
  title: string;
  source: string;
  sourceId: string;
  status: string;
  agencyOperator: string | null;
}

export interface PreviewSurface {
  id: string;
  title: string;
  type: string;
  format: string;
  sourceAttachment: string | null;
  extractionStatus: string;
  /** 이 surface 에 속한 page_image artifact 수. */
  pageCount: number;
}

export interface PreviewPage {
  artifactId: string;
  surfaceId: string;
  /** 1-based 페이지 번호. */
  page: number;
  storageKey: string;
  width: number | null;
  height: number | null;
  dpi: number | null;
}

export interface PreviewField {
  id: string;
  surfaceId: string | null;
  documentName: string;
  documentCategory: string;
  section: string | null;
  fieldKey: string;
  label: string;
  fieldType: string;
  required: boolean;
  fillStrategy: string;
  confidence: number;
  sourceSpan: string | null;
  mappedCompanyField: string | null;
  /** position.page (1-based) — 좌표가 있으면 대개 함께 온다. */
  page: number | null;
  /** 0~1 정규화 박스. 좌표 미확인이면 null (P4 이전 대부분 null 이 정상). */
  box: NormalizedBox | null;
}

export interface GrantDocumentPreview {
  grant: PreviewGrant;
  surfaces: PreviewSurface[];
  pages: PreviewPage[];
  fields: PreviewField[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

/**
 * grantId 로 문서 Preview 데이터를 로드한다. grant 가 없으면 null.
 * surfaces 가 비어 있어도(변환 미가동) grant + 빈 배열로 반환해 빈 상태 안내를 렌더한다.
 */
export async function loadGrantDocumentPreview(input: {
  grantId: string;
}): Promise<GrantDocumentPreview | null> {
  if (!isUuid(input.grantId)) return null;

  const db = getCunoteDb();

  const grantRows = await db
    .select({
      id: schema.grants.id,
      title: schema.grants.title,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      status: schema.grants.status,
      agencyOperator: schema.grants.agencyOperator,
    })
    .from(schema.grants)
    .where(eq(schema.grants.id, input.grantId))
    .limit(1);

  const grantRow = grantRows[0];
  if (!grantRow) return null;

  const surfaceRows = await db
    .select({
      id: schema.grantApplicationSurfaces.id,
      title: schema.grantApplicationSurfaces.title,
      type: schema.grantApplicationSurfaces.type,
      format: schema.grantApplicationSurfaces.format,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
      extractionStatus: schema.grantApplicationSurfaces.extractionStatus,
    })
    .from(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.grantId, input.grantId))
    .orderBy(asc(schema.grantApplicationSurfaces.createdAt));

  const surfaceIds = surfaceRows.map((s) => s.id);

  const artifactRows = surfaceIds.length
    ? await db
        .select({
          id: schema.documentArtifacts.id,
          surfaceId: schema.documentArtifacts.surfaceId,
          page: schema.documentArtifacts.page,
          storageKey: schema.documentArtifacts.storageKey,
          metadata: schema.documentArtifacts.metadata,
        })
        .from(schema.documentArtifacts)
        .where(
          and(
            inArray(schema.documentArtifacts.surfaceId, surfaceIds),
            eq(schema.documentArtifacts.kind, "page_image"),
          ),
        )
        .orderBy(asc(schema.documentArtifacts.surfaceId), asc(schema.documentArtifacts.page))
    : [];

  const pages: PreviewPage[] = artifactRows.map((row) => {
    const metadata = (row.metadata ?? {}) as Record<string, unknown>;
    return {
      artifactId: row.id,
      surfaceId: row.surfaceId,
      page: typeof row.page === "number" && row.page >= 1 ? row.page : 1,
      storageKey: row.storageKey,
      width: numberOrNull(metadata.width),
      height: numberOrNull(metadata.height),
      dpi: numberOrNull(metadata.dpi),
    };
  });

  const pageCountBySurface = new Map<string, number>();
  for (const page of pages) {
    pageCountBySurface.set(page.surfaceId, (pageCountBySurface.get(page.surfaceId) ?? 0) + 1);
  }

  const surfaces: PreviewSurface[] = surfaceRows.map((row) => ({
    id: row.id,
    title: row.title,
    type: row.type,
    format: row.format,
    sourceAttachment: row.sourceAttachment,
    extractionStatus: row.extractionStatus,
    pageCount: pageCountBySurface.get(row.id) ?? 0,
  }));

  const fieldRows = await db
    .select({
      id: schema.grantDocumentFields.id,
      surfaceId: schema.grantDocumentFields.surfaceId,
      documentName: schema.grantDocumentFields.documentName,
      documentCategory: schema.grantDocumentFields.documentCategory,
      section: schema.grantDocumentFields.section,
      fieldKey: schema.grantDocumentFields.fieldKey,
      label: schema.grantDocumentFields.label,
      fieldType: schema.grantDocumentFields.fieldType,
      required: schema.grantDocumentFields.required,
      fillStrategy: schema.grantDocumentFields.fillStrategy,
      confidence: schema.grantDocumentFields.confidence,
      sourceSpan: schema.grantDocumentFields.sourceSpan,
      mappedCompanyField: schema.grantDocumentFields.mappedCompanyField,
      position: schema.grantDocumentFields.position,
    })
    .from(schema.grantDocumentFields)
    .where(eq(schema.grantDocumentFields.grantId, input.grantId))
    .orderBy(
      asc(schema.grantDocumentFields.documentName),
      asc(schema.grantDocumentFields.section),
      asc(schema.grantDocumentFields.fieldKey),
    );

  const fields: PreviewField[] = fieldRows.map((row) => ({
    id: row.id,
    surfaceId: row.surfaceId,
    documentName: row.documentName,
    documentCategory: row.documentCategory,
    section: row.section,
    fieldKey: row.fieldKey,
    label: row.label,
    fieldType: row.fieldType,
    required: row.required,
    fillStrategy: row.fillStrategy,
    confidence: row.confidence,
    sourceSpan: row.sourceSpan,
    mappedCompanyField: row.mappedCompanyField,
    page: parsePositionPage(row.position),
    box: parsePositionBbox(row.position),
  }));

  return {
    grant: {
      id: grantRow.id,
      title: grantRow.title,
      source: grantRow.source,
      sourceId: grantRow.sourceId,
      status: grantRow.status,
      agencyOperator: grantRow.agencyOperator,
    },
    surfaces,
    pages,
    fields,
  };
}
