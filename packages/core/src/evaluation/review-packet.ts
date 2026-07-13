import type { GrantCriterion, GrantRequiredDocument, NormalizedGrant } from "@cunote/contracts";
import { resolveGrantExtractionManifest } from "../extraction/manifest.js";
import type { V3GrantAnnotation } from "./v3-annotations.js";

export interface MatchingV3GrantReviewTask {
  recordType: "grant_review_task";
  schemaVersion: "matching-v3-review-task-v1";
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  readiness: ReturnType<typeof resolveGrantExtractionManifest>["readiness"];
  warnings: ReturnType<typeof resolveGrantExtractionManifest>["warnings"];
  sourceFixture: string;
  sourceFields: Record<string, string | number | boolean | null>;
  attachments: Array<{
    filename: string;
    fetched: boolean;
    conversionStatus: "converted" | "skipped" | "failed" | "pending";
  }>;
  predictedCriteria: Array<{
    criterionId: string;
    dimension: GrantCriterion["dimension"];
    kind: GrantCriterion["kind"];
    operator: GrantCriterion["operator"];
    value: unknown;
    sourceSpan: string | null;
    sourceField: string | null;
    confidence: number;
    needsReview: boolean;
  }>;
  predictedRequiredDocuments?: Array<{
    name: string;
    required: boolean;
    source: GrantRequiredDocument["source"];
    sourceSpan: string | null;
    note: string | null;
  }>;
  annotationTemplate: V3GrantAnnotation;
  predictionProvenance?: {
    extractorVersion: string;
    model: string;
    inputSha256: string;
  };
}

const SOURCE_FIELD_ALLOWLIST: Record<string, string[]> = {
  kstartup: [
    "biz_pbanc_nm",
    "aply_trgt",
    "aply_trgt_ctnt",
    "aply_excl_trgt_ctnt",
    "prfn_matr",
    "supt_regin",
    "biz_enyy",
    "biz_trgt_age",
    "pbanc_ctnt",
  ],
  bizinfo: [
    "pblancNm",
    "trgetNm",
    "reqstBeginEndDe",
    "reqstMthPapersCn",
    "bsnsSumryCn",
    "pldirSportRealmLclasCodeNm",
    "pldirSportRealmMlsfcCodeNm",
    "jrsdInsttNm",
    "excInsttNm",
  ],
};

export function buildMatchingV3GrantReviewTask<TPayload>(
  entry: NormalizedGrant<TPayload>,
  options: {
    sourceFixture?: string;
    predictedCriteria?: GrantCriterion[];
    predictionProvenance?: MatchingV3GrantReviewTask["predictionProvenance"];
    predictedRequiredDocuments?: GrantRequiredDocument[];
  } = {},
): MatchingV3GrantReviewTask {
  const manifest = resolveGrantExtractionManifest(entry);
  const grantId = `${entry.grant.source}:${entry.grant.source_id}`;
  const sourceFixture = options.sourceFixture ?? `archive:${grantId}:${manifest.revision}`;
  const predictedCriteria = (options.predictedCriteria ?? entry.criteria).map((criterion, index) => ({
    criterionId: criterion.id ?? `${grantId}:predicted:${index + 1}`,
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value,
    sourceSpan: shortText(criterion.source_span) ?? null,
    sourceField: criterion.source_field?.trim() || null,
    confidence: criterion.confidence,
    needsReview: criterion.needs_review === true,
  }));

  return {
    recordType: "grant_review_task",
    schemaVersion: "matching-v3-review-task-v1",
    grantId,
    source: entry.grant.source,
    sourceId: entry.grant.source_id,
    title: entry.grant.title,
    readiness: manifest.readiness,
    warnings: manifest.warnings,
    sourceFixture,
    sourceFields: selectSourceFields(entry.grant.source, entry.raw.payload),
    attachments: (entry.raw.attachments ?? []).map((attachment) => ({
      filename: attachment.filename,
      fetched: Boolean(attachment.archive_url || attachment.storage_key || attachment.sha256),
      conversionStatus: attachment.conversion?.status ?? "pending",
    })),
    predictedCriteria,
    ...(options.predictedRequiredDocuments ? {
      predictedRequiredDocuments: options.predictedRequiredDocuments.map((document) => ({
        name: document.name,
        required: document.required,
        source: document.source,
        sourceSpan: shortText(document.source_span) ?? null,
        note: shortText(document.note) ?? null,
      })),
    } : {}),
    annotationTemplate: {
      recordType: "grant",
      schemaVersion: "matching-v3",
      grantId,
      source: entry.grant.source,
      sourceId: entry.grant.source_id,
      title: entry.grant.title,
      audience: "unknown",
      labelStatus: "draft",
      annotatorId: null,
      reviewerId: null,
      annotatedAt: null,
      reviewedAt: null,
      criteria: predictedCriteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        dimension: criterion.dimension,
        kind: criterion.kind,
        operator: criterion.operator,
        value: criterion.value,
        sourceSpan: criterion.sourceSpan,
        sourceField: criterion.sourceField,
        annotationConfidence: criterion.confidence,
        note: criterion.needsReview ? "PREDICTION_REQUIRES_REVIEW" : "PREDICTION_NOT_YET_REVIEWED",
      })),
      sourceFixture,
      sourceRevision: manifest.revision,
    },
    ...(options.predictionProvenance ? { predictionProvenance: options.predictionProvenance } : {}),
  };
}

function selectSourceFields(source: string, payload: unknown): Record<string, string | number | boolean | null> {
  if (!isRecord(payload)) return {};
  const fields = SOURCE_FIELD_ALLOWLIST[source] ?? [];
  const result: Record<string, string | number | boolean | null> = {};
  for (const field of fields) {
    const value = payload[field];
    if (typeof value === "string") result[field] = shortText(value);
    if (typeof value === "number" || typeof value === "boolean" || value === null) result[field] = value;
  }
  return result;
}

function shortText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length <= 4_000 ? text : `${text.slice(0, 3_999)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
