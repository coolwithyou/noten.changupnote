import type {
  ApplyMethodChannel,
  AuthoringMode,
  BenefitBadge,
  CriterionDimension,
  Grant,
  GrantBenefitFamily,
  GrantCriterion,
  GrantSource,
  GrantStatus,
  NormalizedGrant,
  WriteSupportLevel,
} from "@cunote/contracts";
import {
  APPLY_METHOD_CHANNELS,
  APPLY_METHOD_CHANNEL_LABELS,
  AUTHORING_MODES,
  AUTHORING_MODE_LABELS,
  CRITERION_DIMENSIONS,
  GRANT_BENEFIT_FAMILIES,
  WRITE_SUPPORT_LABELS,
} from "@cunote/contracts";
import { classifyApplyMethods, daysUntil, deriveGrantBenefits, deriveWriteSupport, normalizeSupportAmount } from "@cunote/core";

export type GrantArchiveView = "list" | "calendar" | "gantt";
export type GrantArchiveSort = "updated" | "deadline" | "start_date" | "title" | "confidence";
export type GrantArchiveCriterionOperator = "any" | "all";
export type GrantArchiveAttachmentConversionStatus = "converted" | "skipped" | "failed";
export type GrantArchiveApplicationStage =
  | "recommended"
  | "saved"
  | "preparing"
  | "submitted"
  | "selected"
  | "rejected"
  | "blocked"
  | "dismissed";

export interface GrantArchiveCriterionFilter {
  dimension: CriterionDimension;
  values?: string[];
  min?: number;
  max?: number;
  operator?: GrantArchiveCriterionOperator;
}

export interface GrantArchiveQuery {
  q?: string;
  sources?: GrantSource[];
  statuses?: GrantStatus[];
  agencyJurisdictions?: string[];
  agencyOperators?: string[];
  agencies?: string[];
  categoryL1?: string[];
  categoryL2?: string[];
  benefitFamilies?: GrantBenefitFamily[];
  applyMethods?: ApplyMethodChannel[];
  authoringModes?: AuthoringMode[];
  criterionFilters?: GrantArchiveCriterionFilter[];
  applyStartFrom?: string;
  applyStartTo?: string;
  applyEndFrom?: string;
  applyEndTo?: string;
  deadlineWithinDays?: number;
  hasRequiredDocuments?: boolean;
  hasDraftableDocuments?: boolean;
  hasArchivedAttachments?: boolean;
  attachmentConversionStatus?: GrantArchiveAttachmentConversionStatus;
  needsReview?: boolean;
  textOnly?: boolean;
  minConfidence?: number;
  view?: GrantArchiveView;
  sort?: GrantArchiveSort;
  cursor?: string | null;
  limit?: number;
}

export interface GrantArchiveConditionSummary {
  dimension: CriterionDimension;
  label: string;
  valueLabel: string;
  needsReview: boolean;
}

export interface GrantArchiveAttachmentSummary {
  archivedCount: number;
  convertedCount: number;
  failedCount: number;
  skippedCount: number;
}

export interface GrantArchiveItem {
  grantId: string;
  source: GrantSource;
  sourceId: string;
  title: string;
  url: string | null;
  agencyJurisdiction: string | null;
  agencyOperator: string | null;
  agencyPrimary: string | null;
  categoryL1: string | null;
  categoryL2: string | null;
  applyStart: string | null;
  applyEnd: string | null;
  status: GrantStatus;
  dDay: number | null;
  supportAmountLabel: string | null;
  benefits: BenefitBadge[];
  applyMethods: ApplyMethodChannel[];
  authoringMode: AuthoringMode;
  /**
   * 지원서 작성 도움 수준 — 매칭 카드와 같은 core 규칙(deriveWriteSupport)으로 파생.
   * 아카이브 목록은 보관본 배치 조회를 하지 않으므로 template_fill 승격 없이 ai_draft 까지만 표시한다.
   */
  writeSupport: WriteSupportLevel;
  conditionSummary: GrantArchiveConditionSummary[];
  requiredDocumentCount: number;
  draftableDocumentCount: number;
  archivedAttachmentCount: number;
  convertedAttachmentCount: number;
  failedAttachmentCount: number;
  skippedAttachmentCount: number;
  needsReviewCount: number;
  textOnlyCriteriaCount: number;
  overallConfidence: number;
  applicationStage: GrantArchiveApplicationStage | null;
  detailHref: string;
}

export interface GrantArchiveResult {
  generatedAt: string;
  total: number;
  cursor: string | null;
  hasMore: boolean;
  items: GrantArchiveItem[];
}

export interface GrantArchiveFacetOption {
  value: string;
  label: string;
  count: number;
  selected: boolean;
}

export interface GrantArchiveCriterionFacet {
  dimension: CriterionDimension;
  label: string;
  count: number;
  needsReviewCount: number;
  textOnlyCount: number;
  values: GrantArchiveFacetOption[];
}

export interface GrantArchiveFacets {
  generatedAt: string;
  total: number;
  filteredTotal: number;
  sources: GrantArchiveFacetOption[];
  statuses: GrantArchiveFacetOption[];
  benefits: GrantArchiveFacetOption[];
  applyMethods: GrantArchiveFacetOption[];
  authoringModes: GrantArchiveFacetOption[];
  agencyJurisdictions: GrantArchiveFacetOption[];
  agencyOperators: GrantArchiveFacetOption[];
  agencies: GrantArchiveFacetOption[];
  categoryL1: GrantArchiveFacetOption[];
  categoryL2: GrantArchiveFacetOption[];
  criteria: GrantArchiveCriterionFacet[];
  quality: {
    hasRequiredDocuments: number;
    hasDraftableDocuments: number;
    hasArchivedAttachments: number;
    needsReview: number;
    textOnly: number;
  };
  dateRange: {
    earliestApplyStart: string | null;
    latestApplyStart: string | null;
    earliestApplyEnd: string | null;
    latestApplyEnd: string | null;
  };
}

export interface GrantArchiveEntry {
  grant: Grant;
  criteria: GrantCriterion[];
  attachments?: GrantArchiveAttachmentSummary;
  applicationStage?: GrantArchiveApplicationStage | null;
}

const DEFAULT_LIMIT = 40;
const MAX_LIMIT = 100;
const GRANT_ARCHIVE_SOURCES = ["kstartup", "bizinfo", "bizinfo_event"] as const satisfies GrantSource[];
const GRANT_ARCHIVE_STATUSES = ["upcoming", "open", "closed", "unknown"] as const satisfies GrantStatus[];
const DRAFTABLE_PREPARATION_TYPES = new Set(["write"]);
const DIMENSION_LABELS: Record<CriterionDimension, string> = {
  region: "지역",
  biz_age: "업력",
  industry: "업종",
  size: "기업 규모",
  revenue: "매출",
  employees: "임직원",
  founder_age: "대표자 연령",
  founder_trait: "대표자 특성",
  certification: "인증",
  prior_award: "기수혜",
  ip: "지식재산",
  target_type: "신청 대상",
  business_status: "사업 상태",
  tax_compliance: "세금 체납",
  credit_status: "신용 상태",
  sanction: "제재·참여제한",
  financial_health: "재무 건전성",
  insured_workforce: "고용보험 피보험자",
  investment: "투자 유치",
  premises: "사업장·입지",
  export_performance: "수출 실적",
  other: "기타",
};

export function buildGrantArchiveResult(input: {
  entries: Array<NormalizedGrant | GrantArchiveEntry>;
  query?: GrantArchiveQuery;
  asOf?: Date;
}): GrantArchiveResult {
  const query = normalizeArchiveQuery(input.query);
  const asOf = input.asOf ?? new Date();
  const projected = input.entries
    .map((entry) => projectArchiveItem(toArchiveEntry(entry), asOf))
    .filter((item) => matchesArchiveQuery(item, query))
    .sort((a, b) => compareArchiveItems(a, b, query.sort));
  const offset = cursorOffset(query.cursor);
  const paged = projected.slice(offset, offset + query.limit);
  const nextOffset = offset + paged.length;

  return {
    generatedAt: asOf.toISOString(),
    total: projected.length,
    cursor: nextOffset < projected.length ? String(nextOffset) : null,
    hasMore: nextOffset < projected.length,
    items: paged,
  };
}

export function buildGrantArchiveFacets(input: {
  entries: Array<NormalizedGrant | GrantArchiveEntry>;
  query?: GrantArchiveQuery;
  asOf?: Date;
}): GrantArchiveFacets {
  const query = normalizeArchiveQuery(input.query);
  const asOf = input.asOf ?? new Date();
  const projected = input.entries.map((entry) => projectArchiveItem(toArchiveEntry(entry), asOf));
  const filtered = projected.filter((item) => matchesArchiveQuery(item, query));

  return {
    generatedAt: asOf.toISOString(),
    total: projected.length,
    filteredTotal: filtered.length,
    sources: facetOptions(
      countBy(filtered, (item) => item.source),
      selectedSet(query.sources),
      GRANT_ARCHIVE_SOURCES.map((source) => ({ value: source, label: sourceLabel(source) })),
    ),
    statuses: facetOptions(
      countBy(filtered, (item) => item.status),
      selectedSet(query.statuses),
      GRANT_ARCHIVE_STATUSES.map((status) => ({ value: status, label: statusLabel(status) })),
    ),
    benefits: facetOptions(
      countMany(filtered, (item) => item.benefits.map((benefit) => benefit.family)),
      selectedSet(query.benefitFamilies),
      GRANT_BENEFIT_FAMILIES.map((family) => ({ value: family, label: benefitFamilyLabel(family) })),
    ),
    applyMethods: facetOptions(
      countMany(filtered, (item) => item.applyMethods),
      selectedSet(query.applyMethods),
      APPLY_METHOD_CHANNELS.map((channel) => ({ value: channel, label: applyMethodChannelLabel(channel) })),
    ),
    authoringModes: facetOptions(
      countBy(filtered, (item) => item.authoringMode),
      selectedSet(query.authoringModes),
      AUTHORING_MODES.map((mode) => ({ value: mode, label: authoringModeLabel(mode) })),
    ),
    agencyJurisdictions: facetOptions(
      countOptional(filtered, (item) => item.agencyJurisdiction),
      selectedSet(query.agencyJurisdictions),
    ),
    agencyOperators: facetOptions(
      countOptional(filtered, (item) => item.agencyOperator),
      selectedSet(query.agencyOperators),
    ),
    // 주관기관(distinct 약 3,600개)은 페이로드 폭주 방지를 위해 상위 50개로 캡한다.
    // facetOptions가 selected를 최우선 정렬하므로 선택된 값은 캡과 무관하게 항상 포함된다.
    agencies: facetOptions(
      countOptional(filtered, (item) => item.agencyPrimary),
      selectedSet(query.agencies),
    ).slice(0, 50),
    categoryL1: facetOptions(
      countOptional(filtered, (item) => item.categoryL1),
      selectedSet(query.categoryL1),
    ),
    categoryL2: facetOptions(
      countOptional(filtered, (item) => item.categoryL2),
      selectedSet(query.categoryL2),
    ),
    criteria: criterionFacets(filtered, query),
    quality: {
      hasRequiredDocuments: filtered.filter((item) => item.requiredDocumentCount > 0).length,
      hasDraftableDocuments: filtered.filter((item) => item.draftableDocumentCount > 0).length,
      hasArchivedAttachments: filtered.filter((item) => item.archivedAttachmentCount > 0).length,
      needsReview: filtered.filter((item) => item.needsReviewCount > 0).length,
      textOnly: filtered.filter((item) => item.textOnlyCriteriaCount > 0).length,
    },
    dateRange: dateRangeFacet(filtered),
  };
}

export function normalizeArchiveQuery(query: GrantArchiveQuery = {}): Required<Pick<GrantArchiveQuery, "limit" | "sort">> & GrantArchiveQuery {
  return {
    ...query,
    q: cleanText(query.q),
    limit: clampLimit(query.limit),
    sort: query.sort ?? "deadline",
  };
}

export function benefitFamilyLabel(family: GrantBenefitFamily): string {
  if (family === "funding") return "자금지원";
  if (family === "loan") return "융자";
  if (family === "capability") return "역량강화";
  if (family === "space") return "공간";
  if (family === "market") return "판로/마케팅";
  if (family === "certification") return "인증/IP";
  return "네트워크";
}

export function criterionDimensionLabel(dimension: CriterionDimension): string {
  return DIMENSION_LABELS[dimension];
}

export function applyMethodChannelLabel(channel: ApplyMethodChannel): string {
  return APPLY_METHOD_CHANNEL_LABELS[channel];
}

export function authoringModeLabel(mode: AuthoringMode): string {
  return AUTHORING_MODE_LABELS[mode];
}

export function writeSupportLabel(level: WriteSupportLevel): string {
  return WRITE_SUPPORT_LABELS[level];
}

function toArchiveEntry(entry: NormalizedGrant | GrantArchiveEntry): GrantArchiveEntry {
  const archiveEntry: GrantArchiveEntry = {
    grant: entry.grant,
    criteria: entry.criteria,
    applicationStage: "applicationStage" in entry ? entry.applicationStage ?? null : null,
  };
  if ("attachments" in entry && entry.attachments) {
    archiveEntry.attachments = entry.attachments;
  }
  return archiveEntry;
}

function projectArchiveItem(entry: GrantArchiveEntry, asOf: Date): GrantArchiveItem {
  const grant = entry.grant;
  const requiredDocuments = Array.isArray(grant.required_documents) ? grant.required_documents : [];
  const draftableDocumentCount = requiredDocuments.filter((document) =>
    DRAFTABLE_PREPARATION_TYPES.has(String(document.preparation_type ?? ""))
  ).length;
  const attachments = entry.attachments ?? emptyAttachmentSummary();
  const applyStart = dateOnly(grant.apply_start);
  const applyEnd = dateOnly(grant.apply_end);

  return {
    grantId: grant.id ?? `${grant.source}:${grant.source_id}`,
    source: grant.source,
    sourceId: grant.source_id,
    title: grant.title,
    url: grant.url ?? null,
    agencyJurisdiction: grant.agency_jurisdiction ?? null,
    agencyOperator: grant.agency_operator ?? null,
    agencyPrimary: grant.agency_primary ?? null,
    categoryL1: grant.category_l1 ?? null,
    categoryL2: grant.category_l2 ?? null,
    applyStart,
    applyEnd,
    status: grant.status,
    dDay: daysUntil(applyEnd, asOf),
    supportAmountLabel: supportAmountLabel(grant.support_amount),
    benefits: deriveGrantBenefits(grant),
    applyMethods: resolveApplyMethods(grant),
    authoringMode: grant.f_authoring_mode ?? "unknown",
    writeSupport: deriveWriteSupport(grant),
    conditionSummary: summarizeConditions(entry.criteria),
    requiredDocumentCount: requiredDocuments.length,
    draftableDocumentCount,
    archivedAttachmentCount: attachments.archivedCount,
    convertedAttachmentCount: attachments.convertedCount,
    failedAttachmentCount: attachments.failedCount,
    skippedAttachmentCount: attachments.skippedCount,
    needsReviewCount: entry.criteria.filter((criterion) => criterion.needs_review).length,
    textOnlyCriteriaCount: entry.criteria.filter((criterion) => criterion.operator === "text_only").length,
    overallConfidence: grant.overall_confidence,
    applicationStage: entry.applicationStage ?? null,
    detailHref: `/grants/${encodeURIComponent(grant.id ?? `${grant.source}:${grant.source_id}`)}`,
  };
}

// 접수방법 채널 — 정규화된 f_apply_methods 를 우선 쓰고, 레거시 데이터(미백필)는 apply_method jsonb 를 즉석 분류한다.
function resolveApplyMethods(grant: Grant): ApplyMethodChannel[] {
  return grant.f_apply_methods ?? classifyApplyMethods(grant.apply_method);
}

function summarizeConditions(criteria: GrantCriterion[]): GrantArchiveConditionSummary[] {
  const summaries = new Map<CriterionDimension, GrantArchiveConditionSummary>();
  for (const criterion of criteria) {
    if (summaries.has(criterion.dimension)) {
      const current = summaries.get(criterion.dimension);
      if (current && criterion.needs_review) current.needsReview = true;
      continue;
    }
    summaries.set(criterion.dimension, {
      dimension: criterion.dimension,
      label: criterionDimensionLabel(criterion.dimension),
      valueLabel: criterionValueLabel(criterion),
      needsReview: criterion.needs_review ?? false,
    });
  }
  return [...summaries.values()];
}

function matchesArchiveQuery(item: GrantArchiveItem, query: GrantArchiveQuery): boolean {
  if (query.q && !searchHaystack(item).includes(query.q)) return false;
  if (query.sources?.length && !query.sources.includes(item.source)) return false;
  if (query.statuses?.length && !query.statuses.includes(item.status)) return false;
  if (query.agencyJurisdictions?.length && !matchesOptional(item.agencyJurisdiction, query.agencyJurisdictions)) return false;
  if (query.agencyOperators?.length && !matchesOptional(item.agencyOperator, query.agencyOperators)) return false;
  if (query.agencies?.length && !matchesOptional(item.agencyPrimary, query.agencies)) return false;
  if (query.categoryL1?.length && !matchesOptional(item.categoryL1, query.categoryL1)) return false;
  if (query.categoryL2?.length && !matchesOptional(item.categoryL2, query.categoryL2)) return false;
  if (query.benefitFamilies?.length && !item.benefits.some((benefit) => query.benefitFamilies?.includes(benefit.family))) return false;
  if (query.applyMethods?.length && !item.applyMethods.some((channel) => query.applyMethods?.includes(channel))) return false;
  if (query.authoringModes?.length && !query.authoringModes.includes(item.authoringMode)) return false;
  if (!matchesCriterionFilters(item, query.criterionFilters ?? [])) return false;
  if (!matchesDateRange(item.applyStart, query.applyStartFrom, query.applyStartTo)) return false;
  if (!matchesDateRange(item.applyEnd, query.applyEndFrom, query.applyEndTo)) return false;
  if (query.deadlineWithinDays !== undefined && !matchesDeadline(item.dDay, query.deadlineWithinDays)) return false;
  if (query.hasRequiredDocuments !== undefined && (item.requiredDocumentCount > 0) !== query.hasRequiredDocuments) return false;
  if (query.hasDraftableDocuments !== undefined && (item.draftableDocumentCount > 0) !== query.hasDraftableDocuments) return false;
  if (query.hasArchivedAttachments !== undefined && (item.archivedAttachmentCount > 0) !== query.hasArchivedAttachments) return false;
  if (query.attachmentConversionStatus && !matchesAttachmentConversion(item, query.attachmentConversionStatus)) return false;
  if (query.needsReview !== undefined && (item.needsReviewCount > 0) !== query.needsReview) return false;
  if (query.textOnly !== undefined && (item.textOnlyCriteriaCount > 0) !== query.textOnly) return false;
  if (query.minConfidence !== undefined && item.overallConfidence < query.minConfidence) return false;
  return true;
}

function matchesCriterionFilters(item: GrantArchiveItem, filters: GrantArchiveCriterionFilter[]): boolean {
  return filters.every((filter) => {
    const conditions = item.conditionSummary.filter((condition) => condition.dimension === filter.dimension);
    if (conditions.length === 0) return false;
    const values = (filter.values ?? []).map((value) => cleanText(value)).filter(Boolean);
    if (values.length === 0) return true;
    const matchedCount = values.filter((value) =>
      conditions.some((condition) => cleanText(condition.valueLabel).includes(value))
    ).length;
    return filter.operator === "all" ? matchedCount === values.length : matchedCount > 0;
  });
}

function compareArchiveItems(a: GrantArchiveItem, b: GrantArchiveItem, sort: GrantArchiveSort | undefined): number {
  if (sort === "updated") return 0;
  if (sort === "start_date") return compareDateLike(a.applyStart, b.applyStart) || titleCompare(a, b);
  if (sort === "title") return titleCompare(a, b);
  if (sort === "confidence") return b.overallConfidence - a.overallConfidence || titleCompare(a, b);
  return compareDeadline(a, b) || titleCompare(a, b);
}

function compareDeadline(a: GrantArchiveItem, b: GrantArchiveItem): number {
  const left = a.dDay ?? Number.POSITIVE_INFINITY;
  const right = b.dDay ?? Number.POSITIVE_INFINITY;
  return left - right;
}

function compareDateLike(a: string | null, b: string | null): number {
  const left = a ? Date.parse(a) : Number.POSITIVE_INFINITY;
  const right = b ? Date.parse(b) : Number.POSITIVE_INFINITY;
  return left - right;
}

function titleCompare(a: GrantArchiveItem, b: GrantArchiveItem): number {
  return a.title.localeCompare(b.title, "ko-KR");
}

function criterionValueLabel(criterion: GrantCriterion): string {
  const value = criterion.value as Record<string, unknown>;
  const candidates = [
    listLabel(value.regions),
    listLabel(value.labels),
    listLabel(value.tags),
    listLabel(value.sizes),
    listLabel(value.traits),
    listLabel(value.certs),
    listLabel(value.programs),
    listLabel(value.targets),
    listLabel(value.types),
    value.nationwide ? "전국" : null,
    rangeLabel(value.min_months, value.max_months, "개월"),
    rangeLabel(value.min, value.max, ""),
    typeof value.note === "string" ? value.note : null,
  ];
  return candidates.find((candidate) => candidate && candidate.length > 0) ?? criterion.raw_text ?? criterion.source_span ?? "조건 확인";
}

export function supportAmountLabel(value: Grant["support_amount"]): string | null {
  const amount = normalizeSupportAmount(value);
  if (amount.label) return amount.label;
  if (typeof amount.max === "number" && amount.max > 0) return `${amount.max.toLocaleString("ko-KR")}원`;
  if (typeof amount.min === "number" && amount.min > 0) return `${amount.min.toLocaleString("ko-KR")}원 이상`;
  return null;
}

function listLabel(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const labels = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return labels.length > 0 ? labels.join(", ") : null;
}

function rangeLabel(min: unknown, max: unknown, unit: string): string | null {
  const minValue = typeof min === "number" ? min : null;
  const maxValue = typeof max === "number" ? max : null;
  if (minValue === null && maxValue === null) return null;
  if (minValue !== null && maxValue !== null) return `${minValue}-${maxValue}${unit}`;
  if (maxValue !== null) return `${maxValue}${unit} 이하`;
  return `${minValue}${unit} 이상`;
}

function matchesOptional(value: string | null, allowed: string[]): boolean {
  if (!value) return false;
  return allowed.includes(value);
}

function matchesDateRange(value: string | null, from: string | undefined, to: string | undefined): boolean {
  if (!from && !to) return true;
  if (!value) return false;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return false;
  if (from && timestamp < Date.parse(from)) return false;
  if (to && timestamp > Date.parse(to)) return false;
  return true;
}

function matchesDeadline(dDay: number | null, withinDays: number): boolean {
  return dDay !== null && dDay >= 0 && dDay <= withinDays;
}

function matchesAttachmentConversion(item: GrantArchiveItem, status: GrantArchiveAttachmentConversionStatus): boolean {
  if (status === "converted") return item.convertedAttachmentCount > 0;
  if (status === "failed") return item.failedAttachmentCount > 0;
  return item.skippedAttachmentCount > 0;
}

function searchHaystack(item: GrantArchiveItem): string {
  return cleanText([
    item.title,
    item.source,
    item.sourceId,
    item.agencyJurisdiction,
    item.agencyOperator,
    item.agencyPrimary,
    item.categoryL1,
    item.categoryL2,
    item.benefits.map((benefit) => `${benefit.family} ${benefit.label}`).join(" "),
    item.conditionSummary.map((condition) => `${condition.label} ${condition.valueLabel}`).join(" "),
  ].filter(Boolean).join(" "));
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function dateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  const direct = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (direct) return direct[1] ?? null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}

function cursorOffset(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  const parsed = Number(cursor);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function emptyAttachmentSummary(): GrantArchiveAttachmentSummary {
  return {
    archivedCount: 0,
    convertedCount: 0,
    failedCount: 0,
    skippedCount: 0,
  };
}

export function sourceLabel(source: GrantSource): string {
  if (source === "kstartup") return "K-Startup";
  if (source === "bizinfo") return "기업마당";
  return "기업마당 행사";
}

export function statusLabel(status: GrantStatus): string {
  if (status === "open") return "접수중";
  if (status === "upcoming") return "예정";
  if (status === "closed") return "마감";
  return "상태 미확인";
}

function selectedSet(values: string[] | undefined): Set<string> {
  return new Set(values ?? []);
}

function countBy<T>(items: T[], read: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) incrementCount(counts, read(item));
  return counts;
}

function countMany<T>(items: T[], read: (item: T) => string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const value of new Set(read(item))) incrementCount(counts, value);
  }
  return counts;
}

function countOptional<T>(items: T[], read: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = read(item);
    if (value) incrementCount(counts, value);
  }
  return counts;
}

function incrementCount(counts: Map<string, number>, value: string): void {
  counts.set(value, (counts.get(value) ?? 0) + 1);
}

function facetOptions(
  counts: Map<string, number>,
  selected: Set<string>,
  fixedOptions: Array<{ value: string; label: string }> = [],
): GrantArchiveFacetOption[] {
  const labels = new Map(fixedOptions.map((option) => [option.value, option.label]));
  for (const value of counts.keys()) labels.set(value, labels.get(value) ?? value);
  for (const value of selected) labels.set(value, labels.get(value) ?? value);

  return [...labels.entries()]
    .map(([value, label]) => ({
      value,
      label,
      count: counts.get(value) ?? 0,
      selected: selected.has(value),
    }))
    .sort((a, b) => Number(b.selected) - Number(a.selected) || b.count - a.count || a.label.localeCompare(b.label, "ko-KR"));
}

function criterionFacets(
  items: GrantArchiveItem[],
  query: GrantArchiveQuery,
): GrantArchiveCriterionFacet[] {
  return CRITERION_DIMENSIONS.map((dimension) => {
    const matchingConditions = items.flatMap((item) =>
      item.conditionSummary.filter((condition) => condition.dimension === dimension)
    );
    const selectedValues = selectedSet(query.criterionFilters
      ?.filter((filter) => filter.dimension === dimension)
      .flatMap((filter) => filter.values ?? []));

    return {
      dimension,
      label: criterionDimensionLabel(dimension),
      count: matchingConditions.length,
      needsReviewCount: matchingConditions.filter((condition) => condition.needsReview).length,
      textOnlyCount: items.filter((item) =>
        item.conditionSummary.some((condition) => condition.dimension === dimension) && item.textOnlyCriteriaCount > 0
      ).length,
      values: facetOptions(
        countBy(matchingConditions, (condition) => condition.valueLabel),
        selectedValues,
      ).slice(0, 12),
    };
  }).filter((facet) => facet.count > 0 || facet.values.length > 0);
}

function dateRangeFacet(items: GrantArchiveItem[]): GrantArchiveFacets["dateRange"] {
  return {
    earliestApplyStart: minDateString(items.map((item) => item.applyStart)),
    latestApplyStart: maxDateString(items.map((item) => item.applyStart)),
    earliestApplyEnd: minDateString(items.map((item) => item.applyEnd)),
    latestApplyEnd: maxDateString(items.map((item) => item.applyEnd)),
  };
}

function minDateString(values: Array<string | null>): string | null {
  return dateExtreme(values, "min");
}

function maxDateString(values: Array<string | null>): string | null {
  return dateExtreme(values, "max");
}

function dateExtreme(values: Array<string | null>, mode: "min" | "max"): string | null {
  let selected: string | null = null;
  let selectedTime = mode === "min" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if ((mode === "min" && time < selectedTime) || (mode === "max" && time > selectedTime)) {
      selected = value;
      selectedTime = time;
    }
  }
  return selected;
}
