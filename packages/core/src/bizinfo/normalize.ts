import type {
  BizAgeCriterionValue,
  Grant,
  GrantCriterion,
  GrantRequiredDocument,
  GrantRaw,
  ListCriterionValue,
  NormalizedGrant,
  RegionCriterionValue,
} from "@cunote/contracts";
import {
  buildBizInfoProgramExtractionInput,
  htmlToText,
  normalizeBizInfoUrl,
} from "./extraction-input.js";
import { normalizeGrantRequiredDocuments } from "../documents/taxonomy.js";
import { classifyGrantAudience } from "../audience/classify.js";
import { classifyApplyMethods } from "../grants/apply-method.js";
import { classifyAuthoringMode } from "../grants/authoring-mode.js";
import { resolveGrantAgencyPrimary } from "../grants/agency.js";
import { projectGrantIndustryTags } from "../grants/industry-projection.js";
import type { BizInfoAttachmentMarkdown, BizInfoProgram } from "./types.js";

// v3: 결격 축 구조화(v2)에 industry value alias→tags 정규화와 prompt canonical key를 추가.
export const BIZINFO_NORMALIZER_VERSION = "bizinfo-llm-criteria-v3";

export function normalizeBizInfoProgram(
  program: BizInfoProgram,
  criteria: GrantCriterion[],
  options: {
    asOf?: Date;
    attachmentMarkdowns?: BizInfoAttachmentMarkdown[];
    attachments?: GrantRaw<BizInfoProgram>["attachments"];
    collectedAt?: Date;
    model?: string | null;
    requiredDocuments?: GrantRequiredDocument[];
  } = {},
): NormalizedGrant<BizInfoProgram> {
  const input = buildBizInfoProgramExtractionInput(program, options.attachmentMarkdowns
    ? { attachmentMarkdowns: options.attachmentMarkdowns }
    : {});
  const applyPeriod = parseBizInfoApplyPeriod(input.metadata.apply_period);
  const projection = deriveProjection(criteria);
  const asOf = options.asOf ?? new Date();
  const raw: GrantRaw<BizInfoProgram> = {
    source: "bizinfo",
    source_id: program.pblancId,
    payload: program,
    attachments: options.attachments ?? (input.metadata.attachments.length > 0 ? input.metadata.attachments : null),
    collected_at: (options.collectedAt ?? new Date()).toISOString(),
    status: criteria.length > 0 ? "normalized" : "extracted",
  };

  const applyMethod = {
    text: input.metadata.application_method,
  };
  const applyMethods = classifyApplyMethods(applyMethod);
  // bizinfo 는 첨부 수집이 상시(1,485건 백필)이므로 attachmentsKnown=true. 목록이 비어도 "수집됐으나 없음"으로 본다.
  const attachmentList = options.attachments ?? input.metadata.attachments;
  const authoringMode = classifyAuthoringMode({
    attachmentFilenames: attachmentList.map((attachment) => attachment.filename),
    attachmentsKnown: true,
    applyMethods,
    applyMethodTexts: [applyMethod.text].filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ),
  });

  const grant: Grant = {
    source: "bizinfo",
    source_id: program.pblancId,
    title: input.title,
    url: normalizeBizInfoUrl(program.pblancUrl),
    agency_jurisdiction: input.metadata.jurisdiction_agency,
    agency_operator: input.metadata.operating_agency,
    agency_primary: resolveGrantAgencyPrimary({
      source: "bizinfo",
      jurisdiction: input.metadata.jurisdiction_agency,
      operator: input.metadata.operating_agency,
    }),
    category_l1: input.metadata.category_l1,
    category_l2: input.metadata.category_l2,
    apply_start: applyPeriod.start,
    apply_end: applyPeriod.end,
    apply_method: applyMethod,
    support_amount: null,
    required_documents: normalizeGrantRequiredDocuments(mergeRequiredDocuments(
      parseBizInfoRequiredDocuments(input.metadata.application_method),
      options.requiredDocuments,
    )),
    status: statusFromPeriod(applyPeriod.start, applyPeriod.end, asOf),
    audience: classifyGrantAudience({ source: "bizinfo", title: input.title, payload: program }).audience,
    f_regions: projection.f_regions,
    f_industries: projection.f_industries,
    f_biz_age_min_months: projection.f_biz_age_min_months,
    f_biz_age_max_months: projection.f_biz_age_max_months,
    f_sizes: projection.f_sizes,
    f_founder_traits: projection.f_founder_traits,
    f_required_certs: projection.f_required_certs,
    f_apply_methods: applyMethods,
    f_authoring_mode: authoringMode,
    overall_confidence: projection.overall_confidence,
    model_ver: options.model ?? null,
    prompt_ver: BIZINFO_NORMALIZER_VERSION,
    parser_version: BIZINFO_NORMALIZER_VERSION,
    updated_at: null,
  };

  return { raw, grant, criteria };
}

export function parseBizInfoApplyPeriod(value: string | null | undefined): {
  start: string | null;
  end: string | null;
} {
  const text = htmlToText(value);
  const dates = [...text.matchAll(/\d{4}[-.]\d{1,2}[-.]\d{1,2}/g)]
    .map((match) => normalizeDate(match[0]))
    .filter(Boolean);
  return {
    start: dates[0] ?? null,
    end: dates[1] ?? dates[0] ?? null,
  };
}

const BIZINFO_DOCUMENT_PATTERNS: Array<{
  name: string;
  source: GrantRequiredDocument["source"];
  pattern: RegExp;
}> = [
  { name: "신청서", source: "portal", pattern: /(?:수요기업\s*)?신청서/ },
  { name: "사업자등록증", source: "self", pattern: /사업자등록증/ },
  { name: "재무제표", source: "self", pattern: /재무제표/ },
];

export function parseBizInfoRequiredDocuments(value: string | null | undefined): GrantRequiredDocument[] | null {
  const text = htmlToText(value);
  if (!text) return null;
  const documents = new Map<string, GrantRequiredDocument>();

  for (const pattern of BIZINFO_DOCUMENT_PATTERNS) {
    if (!pattern.pattern.test(text)) continue;
    documents.set(pattern.name, {
      name: pattern.name,
      required: true,
      source: pattern.source,
      source_span: firstSentenceWith(text, pattern.pattern),
    });
  }

  return documents.size > 0 ? [...documents.values()] : null;
}

function deriveProjection(criteria: GrantCriterion[]) {
  const regions = criteria
    .filter((criterion) => criterion.dimension === "region" && criterion.kind === "required")
    .flatMap((criterion) => (criterion.value as RegionCriterionValue).regions ?? []);
  const bizAge = criteria.find((criterion) => criterion.dimension === "biz_age");
  const bizAgeValue = bizAge?.value as BizAgeCriterionValue | undefined;
  const industryTags = projectGrantIndustryTags(criteria);
  const sizes = criteria
    .filter((criterion) => criterion.dimension === "size")
    .flatMap((criterion) => (criterion.value as ListCriterionValue).sizes ?? []);
  const traits = criteria
    .filter((criterion) => criterion.dimension === "founder_trait")
    .flatMap((criterion) => (criterion.value as ListCriterionValue).traits ?? []);
  const certs = criteria
    .filter((criterion) => criterion.dimension === "certification" && criterion.kind === "required")
    .flatMap((criterion) => (criterion.value as ListCriterionValue).certs ?? []);

  return {
    f_regions: unique(regions),
    f_industries: unique(industryTags),
    f_biz_age_min_months: bizAgeValue?.min_months ?? null,
    f_biz_age_max_months: bizAgeValue?.max_months ?? null,
    f_sizes: unique(sizes),
    f_founder_traits: unique(traits),
    f_required_certs: unique(certs),
    overall_confidence: criteria.length
      ? Math.round((criteria.reduce((sum, criterion) => sum + criterion.confidence, 0) / criteria.length) * 100) / 100
      : 0,
  };
}

function statusFromPeriod(start: string | null, end: string | null, asOf: Date): Grant["status"] {
  const startDate = parseDate(start);
  const endDate = parseDate(end);
  const today = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  if (startDate && today < startDate) return "upcoming";
  if (endDate && today > endDate) return "closed";
  if (startDate || endDate) return "open";
  return "unknown";
}

function normalizeDate(value: string): string | null {
  const parts = value.split(/[-.]/).map((part) => Number(part));
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month || !day) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseDate(value: string | null): Date | null {
  if (!value) return null;
  const parts = value.split("-").map((part) => Number(part));
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function firstSentenceWith(text: string, pattern: RegExp): string {
  const normalized = htmlToText(text);
  const parts = normalized.split(/[\r\n.。]+/).map((part) => part.trim()).filter(Boolean);
  return parts.find((part) => pattern.test(part)) ?? normalized.slice(0, 120);
}

function mergeRequiredDocuments(
  ...groups: Array<GrantRequiredDocument[] | null | undefined>
): GrantRequiredDocument[] | null {
  const documents = new Map<string, GrantRequiredDocument>();
  for (const group of groups) {
    for (const document of group ?? []) {
      const name = document.name.trim();
      if (!name || documents.has(name)) continue;
      documents.set(name, { ...document, name });
    }
  }
  return documents.size > 0 ? [...documents.values()] : null;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
