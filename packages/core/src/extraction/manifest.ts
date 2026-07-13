import type {
  GrantCriterion,
  GrantExtractionManifest,
  GrantExtractionWarningCode,
  GrantRaw,
  MatchExtractionReadiness,
  NormalizedGrant,
} from "@cunote/contracts";

export interface BuildGrantExtractionManifestOptions {
  sourceFieldsExpected?: string[];
  sourceFieldsSeen?: string[];
  sectionsExpected?: string[];
  sectionsDetected?: string[];
  attachmentsExpected?: number;
  extractorVersion?: string;
  completedAt?: string;
  reviewedAt?: string | null;
}

/**
 * raw/criteria의 현재 상태로 추출 완전성을 계산한다.
 * 부재를 성공으로 추정하지 않으며, 첨부는 archive와 conversion이 확인된 수만 센다.
 */
export function buildGrantExtractionManifest<TPayload>(
  entry: Pick<NormalizedGrant<TPayload>, "raw" | "grant" | "criteria">,
  options: BuildGrantExtractionManifestOptions = {},
): GrantExtractionManifest {
  const sourceFieldsSeen = unique(options.sourceFieldsSeen ?? inferSourceFields(entry.raw, entry.criteria));
  const sectionsDetected = unique(options.sectionsDetected ?? inferSections(entry.criteria));
  const attachments = entry.raw.attachments ?? [];
  const attachmentsExpected = nonNegativeInteger(options.attachmentsExpected ?? attachments.length);
  const attachmentsFetched = Math.min(
    attachmentsExpected,
    attachments.filter(isFetchedAttachment).length,
  );
  const attachmentsConverted = Math.min(
    attachmentsFetched,
    attachments.filter((attachment) => attachment.conversion?.status === "converted").length,
  );
  const attachmentsProcessed = Math.min(
    attachmentsFetched,
    attachments.filter((attachment) =>
      attachment.conversion?.status === "converted" ||
      attachment.conversion?.status === "skipped" ||
      attachment.conversion?.status === "failed").length,
  );
  const warnings = extractionWarnings({
    criteria: entry.criteria,
    sourceFieldsExpected: options.sourceFieldsExpected ?? [],
    sourceFieldsSeen,
    sectionsExpected: options.sectionsExpected ?? [],
    sectionsDetected,
    attachments,
    attachmentsExpected,
    attachmentsFetched,
    attachmentsConverted,
    attachmentsProcessed,
  });
  const reviewedAt = cleanText(options.reviewedAt);
  const readiness = extractionReadiness(entry.criteria, warnings, Boolean(reviewedAt));

  return {
    grantId: `${entry.grant.source}:${entry.grant.source_id}`,
    revision: entry.raw.raw_hash ?? entry.raw.collected_at ?? entry.grant.updated_at ?? "unknown",
    sourceFieldsSeen,
    attachmentsExpected,
    attachmentsFetched,
    attachmentsConverted,
    sectionsDetected,
    extractorVersion: cleanText(options.extractorVersion) ?? entry.grant.parser_version ?? entry.grant.model_ver ?? "unknown",
    completedAt: cleanText(options.completedAt) ?? entry.raw.collected_at ?? entry.grant.updated_at ?? new Date(0).toISOString(),
    warnings,
    readiness,
    ...(reviewedAt ? { reviewedAt } : {}),
  };
}

export function resolveGrantExtractionManifest<TPayload>(
  entry: NormalizedGrant<TPayload>,
): GrantExtractionManifest {
  return entry.extraction_manifest ?? buildGrantExtractionManifest(entry, sourceCompletenessOptions(entry));
}

function sourceCompletenessOptions<TPayload>(
  entry: NormalizedGrant<TPayload>,
): BuildGrantExtractionManifestOptions {
  const payload = isRecord(entry.raw.payload) ? entry.raw.payload : {};
  if (entry.grant.source === "kstartup" && Object.hasOwn(payload, "pbanc_sn")) {
    return {
      sourceFieldsExpected: [
        "aply_trgt_ctnt",
        "aply_excl_trgt_ctnt",
        "prfn_matr",
        "supt_regin",
        "biz_enyy",
        "biz_trgt_age",
      ],
      sectionsExpected: ["required"],
    };
  }
  if (entry.grant.source === "bizinfo" && Object.hasOwn(payload, "pblancId")) {
    return {
      sourceFieldsExpected: [
        "pblancNm",
        "trgetNm",
        "reqstBeginEndDe",
        "reqstMthPapersCn",
        "bsnsSumryCn",
      ],
      sectionsExpected: ["required"],
    };
  }
  return {};
}

function extractionWarnings(input: {
  criteria: GrantCriterion[];
  sourceFieldsExpected: string[];
  sourceFieldsSeen: string[];
  sectionsExpected: string[];
  sectionsDetected: string[];
  attachments: NonNullable<GrantRaw["attachments"]>;
  attachmentsExpected: number;
  attachmentsFetched: number;
  attachmentsConverted: number;
  attachmentsProcessed: number;
}): GrantExtractionWarningCode[] {
  const warnings: GrantExtractionWarningCode[] = [];
  if (input.criteria.length === 0) warnings.push("criteria_missing");
  if (input.criteria.some((criterion) => criterion.operator === "text_only")) {
    warnings.push("text_only_criterion_present");
  }
  if (input.criteria.some((criterion) => criterion.needs_review === true)) {
    warnings.push("criterion_review_required");
  }
  if (input.criteria.some((criterion) =>
    (criterion.kind === "required" || criterion.kind === "exclusion") &&
    !criterion.source_span?.trim() &&
    !criterion.source_field?.trim())) {
    warnings.push("hard_criterion_evidence_missing");
  }
  if (input.sourceFieldsExpected.some((field) => !input.sourceFieldsSeen.includes(field))) {
    warnings.push("source_field_missing");
  }
  if (input.sectionsExpected.some((section) => !input.sectionsDetected.includes(section))) {
    warnings.push("source_section_missing");
  }
  if (input.attachmentsFetched < input.attachmentsExpected) {
    warnings.push("attachment_fetch_incomplete");
  }
  if (input.attachments.some((attachment) => attachment.conversion?.status === "failed")) {
    warnings.push("attachment_conversion_failed");
  }
  if (input.attachmentsFetched > input.attachmentsProcessed) {
    warnings.push("attachment_conversion_incomplete");
  }
  return unique(warnings);
}

function extractionReadiness(
  criteria: GrantCriterion[],
  warnings: GrantExtractionWarningCode[],
  reviewed: boolean,
): MatchExtractionReadiness {
  if (criteria.length === 0) return "unstructured";
  if (warnings.length > 0) return "partial";
  return reviewed ? "reviewed" : "structured_unreviewed";
}

function inferSourceFields<TPayload>(raw: GrantRaw<TPayload>, criteria: GrantCriterion[]): string[] {
  const payload = raw.payload;
  const payloadFields = isRecord(payload) ? Object.keys(payload) : [];
  return unique([
    ...payloadFields,
    ...criteria.flatMap((criterion) => criterion.source_field ? [criterion.source_field] : []),
  ]);
}

function inferSections(criteria: GrantCriterion[]): string[] {
  return unique(criteria.map((criterion) => criterion.kind));
}

function isFetchedAttachment(attachment: NonNullable<GrantRaw["attachments"]>[number]): boolean {
  return Boolean(
    cleanText(attachment.archive_url) ||
    cleanText(attachment.storage_key) ||
    cleanText(attachment.sha256),
  );
}

function cleanText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
