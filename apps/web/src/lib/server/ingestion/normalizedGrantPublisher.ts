import { and, eq, notInArray } from "drizzle-orm";
import type { Grant, GrantCriterion, GrantRaw, GrantSource, NormalizedGrant } from "@cunote/contracts";
import type { CunoteDb, CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import {
  registerAttachmentConversions,
  type ArchivedAttachmentRef,
} from "../conversion/registerAttachmentConversions";
import { readDetectedSurfaceFormat } from "./grantAttachmentArchive";
import { hashGrantRawPayload } from "./grantRawHash";

export interface NormalizedGrantPublishPlan {
  source: GrantSource;
  rawCount: number;
  grantCount: number;
  criteriaCount: number;
  rawHashes: string[];
}

export interface NormalizedGrantPublishResult extends NormalizedGrantPublishPlan {
  publishedAt: string;
  /** T7 후크: surface 생성/변환 job 등록 중 발생한 경고 (아카이브는 성공). */
  conversionWarnings?: string[];
}

export function planNormalizedGrantPublication<TPayload>(
  source: GrantSource,
  entries: Array<NormalizedGrant<TPayload>>,
): NormalizedGrantPublishPlan {
  assertEntriesUseSource(source, entries);

  return {
    source,
    rawCount: entries.length,
    grantCount: entries.length,
    criteriaCount: entries.reduce((sum, entry) => sum + entry.criteria.length, 0),
    rawHashes: entries.map((entry) => hashGrantRawPayload(entry.raw.payload)),
  };
}

export async function publishNormalizedGrants<TPayload>(
  db: CunoteDb,
  entries: Array<NormalizedGrant<TPayload>>,
  options: {
    source: GrantSource;
    page?: number;
    collectedAt?: Date;
  },
): Promise<NormalizedGrantPublishResult> {
  const collectedAt = options.collectedAt ?? new Date();
  assertEntriesUseSource(options.source, entries);

  const conversionWarnings: string[] = [];

  return db.transaction(async (tx) => {
    for (const entry of entries) {
      await tx
        .insert(schema.grantRaw)
        .values({
          source: entry.raw.source,
          sourceId: entry.raw.source_id,
          payload: entry.raw.payload as unknown as Record<string, unknown>,
          attachments: rawAttachments(entry.raw.attachments),
          rawHash: hashGrantRawPayload(entry.raw.payload),
          collectedAt,
          status: "published",
        })
        .onConflictDoUpdate({
          target: [schema.grantRaw.source, schema.grantRaw.sourceId],
          set: {
            payload: entry.raw.payload as unknown as Record<string, unknown>,
            attachments: rawAttachments(entry.raw.attachments),
            rawHash: hashGrantRawPayload(entry.raw.payload),
            collectedAt,
            status: "published",
          },
        });

      const [grant] = await tx
        .insert(schema.grants)
        .values(grantInsertValues(entry.grant, collectedAt))
        .onConflictDoUpdate({
          target: [schema.grants.source, schema.grants.sourceId],
          set: grantUpdateValues(entry.grant, collectedAt),
        })
        .returning({ id: schema.grants.id });

      if (!grant) {
        throw new Error(`${options.source} grant publish failed: ${entry.grant.source_id}`);
      }

      await tx.delete(schema.grantCriteria).where(eq(schema.grantCriteria.grantId, grant.id));
      if (entry.criteria.length > 0) {
        await tx.insert(schema.grantCriteria).values(
          entry.criteria.map((criterion) => criterionInsertValues(grant.id, criterion)),
        );
      }

      const archivedAttachments = grantAttachmentArchiveRows(entry);
      if (archivedAttachments.length > 0) {
        await tx
          .delete(schema.grantAttachmentArchives)
          .where(and(
            eq(schema.grantAttachmentArchives.source, entry.raw.source),
            eq(schema.grantAttachmentArchives.sourceId, entry.raw.source_id),
            notInArray(
              schema.grantAttachmentArchives.sourceUri,
              archivedAttachments.map((attachment) => attachment.sourceUri ?? ""),
            ),
          ));
        for (const attachment of archivedAttachments) {
          await tx
            .insert(schema.grantAttachmentArchives)
            .values(attachment)
            .onConflictDoUpdate({
              target: [
                schema.grantAttachmentArchives.source,
                schema.grantAttachmentArchives.sourceId,
                schema.grantAttachmentArchives.filename,
                schema.grantAttachmentArchives.sourceUri,
              ],
              set: {
                archiveUrl: attachment.archiveUrl,
                storageKey: attachment.storageKey,
                contentType: attachment.contentType,
                bytes: attachment.bytes,
                sha256: attachment.sha256,
                fetchedAt: attachment.fetchedAt,
                conversionStatus: attachment.conversionStatus,
                markdownUrl: attachment.markdownUrl,
                markdownStorageKey: attachment.markdownStorageKey,
                markdownSha256: attachment.markdownSha256,
                markdownBytes: attachment.markdownBytes,
                converter: attachment.converter,
                convertedAt: attachment.convertedAt,
                conversionError: attachment.conversionError,
                updatedAt: collectedAt,
              },
            });
        }
      }

      // T7: 아카이브 완료 후크 — 변환 대상 첨부에 surface 생성 + 변환 job 등록 (계획 8.1~8.2).
      //   grantId 가 확보된 지점. 실패는 warning 으로 삼키고 아카이브(publish)는 성공 처리한다.
      try {
        const attachmentRefs = conversionAttachmentRefs(entry);
        if (attachmentRefs.length > 0) {
          const hook = await registerAttachmentConversions(tx as unknown as CunoteDbSession, {
            grantId: grant.id,
            source: entry.raw.source,
            sourceId: entry.raw.source_id,
            attachments: attachmentRefs,
          });
          conversionWarnings.push(...hook.warnings);
        }
      } catch (error) {
        // 후크 전체 실패도 아카이브를 막지 않는다.
        conversionWarnings.push(
          `변환 후크 실패 (${entry.raw.source_id}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    await tx
      .insert(schema.sourceCursor)
      .values({
        source: options.source,
        lastPage: options.page ?? 1,
        lastCollectedAt: collectedAt,
      })
      .onConflictDoUpdate({
        target: schema.sourceCursor.source,
        set: {
          lastPage: options.page ?? 1,
          lastCollectedAt: collectedAt,
        },
      });

    return {
      ...planNormalizedGrantPublication(options.source, entries),
      publishedAt: collectedAt.toISOString(),
      ...(conversionWarnings.length > 0 ? { conversionWarnings } : {}),
    };
  });
}

/**
 * publish 대상 grant 의 아카이브된 첨부에서 변환 후크 입력(sha256/archive_url)을 뽑는다.
 * archive_url + sha256 이 있는 첨부만 변환 서버가 다운로드·캐시할 수 있다.
 */
function conversionAttachmentRefs<TPayload>(
  entry: NormalizedGrant<TPayload>,
): ArchivedAttachmentRef[] {
  return (entry.raw.attachments ?? []).flatMap((attachment) => {
    const filename = textValue(attachment.filename);
    if (!filename) return [];
    // 아카이브 시점 매직 바이트 검출 결과가 첨부 JSON 에 실려 있으면 그대로 넘긴다.
    // 없으면(byte-less 경로) detectedFormat 를 생략해 registerAttachmentConversions 가 확장자로 폴백한다.
    const detectedFormat = readDetectedSurfaceFormat(attachment);
    return [{
      filename,
      storageKey: textValue(attachment.storage_key),
      archiveUrl: textValue(attachment.archive_url) ?? textValue(attachment.url),
      sourceUri: textValue(attachment.source_uri) ?? textValue(attachment.url),
      sha256: textValue(attachment.sha256),
      ...(detectedFormat !== undefined ? { detectedFormat } : {}),
    }];
  });
}

function grantInsertValues(grant: Grant, updatedAt: Date): typeof schema.grants.$inferInsert {
  return {
    ...grantUpdateValues(grant, updatedAt),
    source: grant.source,
    sourceId: grant.source_id,
  };
}

function grantUpdateValues(
  grant: Grant,
  updatedAt: Date,
): Omit<typeof schema.grants.$inferInsert, "id" | "source" | "sourceId"> {
  return {
    title: grant.title,
    url: grant.url ?? null,
    agencyJurisdiction: grant.agency_jurisdiction ?? null,
    agencyOperator: grant.agency_operator ?? null,
    agencyPrimary: grant.agency_primary ?? null,
    categoryL1: grant.category_l1 ?? null,
    categoryL2: grant.category_l2 ?? null,
    applyStart: dateValue(grant.apply_start),
    applyEnd: dateValue(grant.apply_end),
    applyMethod: grant.apply_method ?? null,
    supportAmount: (grant.support_amount ?? null) as Record<string, unknown> | null,
    benefits: (grant.benefits ?? null) as Array<Record<string, unknown>> | null,
    requiredDocuments: (grant.required_documents ?? null) as Array<Record<string, unknown>> | null,
    status: grant.status,
    fRegions: grant.f_regions,
    fIndustries: grant.f_industries,
    fBizAgeMinMonths: grant.f_biz_age_min_months ?? null,
    fBizAgeMaxMonths: grant.f_biz_age_max_months ?? null,
    fSizes: grant.f_sizes,
    fFounderTraits: grant.f_founder_traits,
    fRequiredCerts: grant.f_required_certs,
    fApplyMethods: grant.f_apply_methods ?? [],
    fAuthoringMode: grant.f_authoring_mode ?? "unknown",
    overallConfidence: grant.overall_confidence,
    modelVer: grant.model_ver ?? null,
    promptVer: grant.prompt_ver ?? null,
    parserVersion: grant.parser_version ?? null,
    updatedAt,
  };
}

function criterionInsertValues(
  grantId: string,
  criterion: GrantCriterion,
): typeof schema.grantCriteria.$inferInsert {
  return {
    grantId,
    // 계약 CriterionDimension(22축)을 DB criterion_dimension PG enum(현재 14값)에 기입.
    // 신규 8축 값은 P1 마이그레이션으로 enum에 추가될 때까지 DB 타입이 좁으므로 여기서 narrowing.
    // (P0 단계에선 신규 축 criteria를 생성하는 추출기가 아직 없어 실 데이터에 새 값이 들어오지 않음.)
    dimension: criterion.dimension as typeof schema.grantCriteria.$inferInsert["dimension"],
    operator: criterion.operator,
    value: criterion.value as Record<string, unknown>,
    kind: criterion.kind,
    weight: criterion.weight ?? null,
    confidence: criterion.confidence,
    sourceSpan: criterion.source_span ?? null,
    rawText: criterion.raw_text ?? null,
    sourceField: criterion.source_field ?? null,
    needsReview: criterion.needs_review ?? false,
    parserVersion: criterion.parser_version ?? null,
  };
}

function dateValue(value: string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function rawAttachments(
  value: GrantRaw["attachments"] | undefined | null,
): Array<Record<string, unknown>> | null {
  if (!value || value.length === 0) return null;
  return value as Array<Record<string, unknown>>;
}

function grantAttachmentArchiveRows<TPayload>(
  entry: NormalizedGrant<TPayload>,
): Array<typeof schema.grantAttachmentArchives.$inferInsert> {
  return (entry.raw.attachments ?? []).flatMap((attachment) => {
    const filename = textValue(attachment.filename);
    if (!filename) return [];
    const sourceUri = textValue(attachment.source_uri) ?? textValue(attachment.url) ?? "";
    const conversion = attachment.conversion;
    const row: typeof schema.grantAttachmentArchives.$inferInsert = {
      source: entry.raw.source,
      sourceId: entry.raw.source_id,
      filename,
      sourceUri,
      archiveUrl: textValue(attachment.archive_url) ?? textValue(attachment.url),
      storageKey: textValue(attachment.storage_key),
      contentType: textValue(attachment.content_type),
      bytes: numberValue(attachment.bytes),
      sha256: textValue(attachment.sha256),
      fetchedAt: dateValue(textValue(attachment.fetched_at)),
      conversionStatus: conversion?.status ?? null,
      markdownUrl: textValue(conversion?.markdown_url),
      markdownStorageKey: textValue(conversion?.markdown_storage_key),
      markdownSha256: textValue(conversion?.markdown_sha256),
      markdownBytes: numberValue(conversion?.markdown_bytes),
      converter: textValue(conversion?.converter),
      convertedAt: dateValue(textValue(conversion?.converted_at)),
      conversionError: textValue(conversion?.error),
    };
    return [row];
  });
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function assertEntriesUseSource<TPayload>(
  source: GrantSource,
  entries: Array<NormalizedGrant<TPayload>>,
): void {
  for (const entry of entries) {
    if (entry.raw.source !== source || entry.grant.source !== source) {
      throw new Error(
        `Normalized grant source mismatch: expected ${source}, got raw=${entry.raw.source}, grant=${entry.grant.source}, source_id=${entry.grant.source_id}`,
      );
    }
  }
}
