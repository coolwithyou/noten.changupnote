import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Grant, GrantCriterion, GrantSource, NormalizedGrant } from "@cunote/contracts";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";

export interface NormalizedGrantPublishPlan {
  source: GrantSource;
  rawCount: number;
  grantCount: number;
  criteriaCount: number;
  rawHashes: string[];
}

export interface NormalizedGrantPublishResult extends NormalizedGrantPublishPlan {
  publishedAt: string;
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
    rawHashes: entries.map((entry) => rawPayloadHash(entry.raw.payload)),
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

  return db.transaction(async (tx) => {
    for (const entry of entries) {
      await tx
        .insert(schema.grantRaw)
        .values({
          source: entry.raw.source,
          sourceId: entry.raw.source_id,
          payload: entry.raw.payload as unknown as Record<string, unknown>,
          rawHash: rawPayloadHash(entry.raw.payload),
          collectedAt,
          status: "published",
        })
        .onConflictDoUpdate({
          target: [schema.grantRaw.source, schema.grantRaw.sourceId],
          set: {
            payload: entry.raw.payload as unknown as Record<string, unknown>,
            rawHash: rawPayloadHash(entry.raw.payload),
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
    };
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
    categoryL1: grant.category_l1 ?? null,
    categoryL2: grant.category_l2 ?? null,
    applyStart: dateValue(grant.apply_start),
    applyEnd: dateValue(grant.apply_end),
    applyMethod: grant.apply_method ?? null,
    supportAmount: (grant.support_amount ?? null) as Record<string, unknown> | null,
    requiredDocuments: (grant.required_documents ?? null) as Array<Record<string, unknown>> | null,
    status: grant.status,
    fRegions: grant.f_regions,
    fIndustries: grant.f_industries,
    fBizAgeMinMonths: grant.f_biz_age_min_months ?? null,
    fBizAgeMaxMonths: grant.f_biz_age_max_months ?? null,
    fSizes: grant.f_sizes,
    fFounderTraits: grant.f_founder_traits,
    fRequiredCerts: grant.f_required_certs,
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
    dimension: criterion.dimension,
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

function rawPayloadHash(payload: unknown): string {
  return createHash("sha256").update(stableJsonStringify(payload)).digest("hex");
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map((item) => stableJsonStringify(item)).join(",")}]`;

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJsonStringify(record[key])}`)
    .join(",")}}`;
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
