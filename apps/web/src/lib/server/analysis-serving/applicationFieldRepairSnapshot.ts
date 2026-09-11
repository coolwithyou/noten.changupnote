import { and, eq, inArray } from "drizzle-orm";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { sha256Canonical } from "./promotionReleaseContract";

export interface ApplicationFieldRepairSurfaceSnapshot {
  id: string;
  grantId: string;
  templateId: string | null;
  source: string;
  sourceId: string;
  type: string;
  title: string;
  format: string;
  sourceUrl: string | null;
  sourceAttachment: string | null;
  archiveSha256: string | null;
  extractionStatus: string;
  extractionVersion: string | null;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationFieldRepairFieldSnapshot {
  id: string;
  grantId: string;
  source: string;
  sourceId: string;
  documentCategory: string;
  documentName: string;
  sourceAttachment: string | null;
  fieldKey: string;
  label: string;
  section: string | null;
  fieldType: string;
  required: boolean;
  sourceSpan: string | null;
  mappedCompanyField: string | null;
  fillStrategy: string;
  confidence: number;
  parserVersion: string;
  surfaceId: string | null;
  position: Record<string, unknown> | null;
  visualEvidence: Record<string, unknown> | null;
  textEvidence: Record<string, unknown> | null;
  reviewRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationFieldRepairDraftBindingSnapshot {
  id: string;
  surfaceId: string | null;
  updatedAt: string;
  stateSha256: string;
}

export interface ApplicationFieldRepairSnapshot {
  schema: "analysis-lab-application-field-repair-snapshot-v1";
  grantId: string;
  surfaces: ApplicationFieldRepairSurfaceSnapshot[];
  fields: ApplicationFieldRepairFieldSnapshot[];
  drafts: ApplicationFieldRepairDraftBindingSnapshot[];
}

/** field/surface와 사용자 draft 불변 digest를 한 DB snapshot에서 canonical하게 읽는다. */
export async function loadApplicationFieldRepairSnapshot(
  db: CunoteDbSession,
  grantId: string,
): Promise<ApplicationFieldRepairSnapshot> {
  return (await loadApplicationFieldRepairSnapshots(db, [grantId])).get(grantId) ?? emptySnapshot(grantId);
}

/** serving hydration에서 repair grant 전체를 고정 4 query로 읽어 N+1을 만들지 않는다. */
export async function loadApplicationFieldRepairSnapshots(
  db: CunoteDbSession,
  grantIds: readonly string[],
): Promise<Map<string, ApplicationFieldRepairSnapshot>> {
  const exactGrantIds = [...new Set(grantIds)].sort();
  if (exactGrantIds.length === 0) return new Map();
  const [surfaceRows, fieldRows, draftRows] = await Promise.all([
    db.select().from(schema.grantApplicationSurfaces)
      .where(inArray(schema.grantApplicationSurfaces.grantId, exactGrantIds)),
    db.select().from(schema.grantDocumentFields)
      .where(inArray(schema.grantDocumentFields.grantId, exactGrantIds)),
    db.select().from(schema.grantDocumentDrafts)
      .where(inArray(schema.grantDocumentDrafts.grantId, exactGrantIds)),
  ]);
  const sourcePairs = [...new Map(surfaceRows.map((row) => [
    `${row.source}:${row.sourceId}`,
    { source: row.source, sourceId: row.sourceId },
  ])).values()];
  const archiveRows = sourcePairs.length === 0
    ? []
    : await db.select({
      source: schema.grantAttachmentArchives.source,
      sourceId: schema.grantAttachmentArchives.sourceId,
      storageKey: schema.grantAttachmentArchives.storageKey,
      sha256: schema.grantAttachmentArchives.sha256,
    }).from(schema.grantAttachmentArchives).where(
      sourcePairs.length === 1
        ? and(
          eq(schema.grantAttachmentArchives.source, sourcePairs[0]!.source),
          eq(schema.grantAttachmentArchives.sourceId, sourcePairs[0]!.sourceId),
        )
        : inArray(schema.grantAttachmentArchives.sourceId, sourcePairs.map((row) => row.sourceId)),
    );
  const archiveShaByKey = new Map(archiveRows.map((row) => [
    `${row.source}:${row.sourceId}:${row.storageKey ?? ""}`,
    row.sha256,
  ]));
  return new Map(exactGrantIds.map((grantId) => [grantId, {
    schema: "analysis-lab-application-field-repair-snapshot-v1",
    grantId,
    surfaces: surfaceRows.filter((row) => row.grantId === grantId).map((row) => ({
      id: row.id,
      grantId: row.grantId,
      templateId: row.templateId,
      source: row.source,
      sourceId: row.sourceId,
      type: row.type,
      title: row.title,
      format: row.format,
      sourceUrl: row.sourceUrl,
      sourceAttachment: row.sourceAttachment,
      archiveSha256: archiveShaByKey.get(
        `${row.source}:${row.sourceId}:${row.sourceAttachment ?? ""}`,
      ) ?? null,
      extractionStatus: row.extractionStatus,
      extractionVersion: row.extractionVersion,
      confidence: row.confidence,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    fields: fieldRows.filter((row) => row.grantId === grantId).map((row) => ({
      ...row,
      position: row.position ?? null,
      visualEvidence: row.visualEvidence ?? null,
      textEvidence: row.textEvidence ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    })).sort((left, right) => left.id.localeCompare(right.id)),
    drafts: draftRows.filter((row) => row.grantId === grantId).map((row) => ({
      id: row.id,
      surfaceId: row.surfaceId,
      updatedAt: row.updatedAt.toISOString(),
      stateSha256: sha256Canonical({
        ...row,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      }),
    })).sort((left, right) => left.id.localeCompare(right.id)),
  } satisfies ApplicationFieldRepairSnapshot]));
}

export function applicationFieldRepairSnapshotSha256(
  snapshot: ApplicationFieldRepairSnapshot,
): string {
  return sha256Canonical(snapshot);
}

/**
 * 제품 readiness가 비교하는 application projection. 사용자 draft는 정상적으로 계속 바뀌므로
 * serving drift 판정에서 제외하고, surface/source archive/field projection만 봉인한다.
 */
export function applicationFieldRepairServingStateSha256(
  snapshot: ApplicationFieldRepairSnapshot,
): string {
  return sha256Canonical({
    schema: "analysis-lab-application-field-repair-serving-state-v1",
    grantId: snapshot.grantId,
    surfaces: snapshot.surfaces,
    fields: snapshot.fields,
  });
}

function emptySnapshot(grantId: string): ApplicationFieldRepairSnapshot {
  return {
    schema: "analysis-lab-application-field-repair-snapshot-v1",
    grantId,
    surfaces: [],
    fields: [],
    drafts: [],
  };
}
