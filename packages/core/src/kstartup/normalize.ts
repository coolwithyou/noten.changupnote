import type {
  BizAgeCriterionValue,
  FounderAgeCriterionValue,
  FounderAgeRange,
  Grant,
  GrantCriterion,
  GrantRequiredDocument,
  GrantRaw,
  NormalizedGrant,
  RegionCriterionValue,
} from "@cunote/contracts";
import {
  KSTARTUP_NORMALIZER_VERSION,
  KSTARTUP_SOURCE,
  METRO_REGION_CODES,
  REGION_CODES,
  TEXT_HINTS,
} from "./constants.js";
import { normalizeGrantRequiredDocuments } from "../documents/taxonomy.js";
import { parseKStartupDate, statusFromApplyWindow } from "./date.js";
import type {
  KStartupAnnouncement,
  KStartupApiResponse,
  NormalizeKStartupOptions,
} from "./types.js";

export function normalizeKStartupPayload(
  payload: KStartupApiResponse | KStartupAnnouncement[],
  options: NormalizeKStartupOptions = {},
): NormalizedGrant<KStartupAnnouncement>[] {
  const rows = Array.isArray(payload) ? payload : payload.data;
  return rows.map((row) => normalizeKStartupAnnouncement(row, options));
}

export function normalizeKStartupAnnouncement(
  row: KStartupAnnouncement,
  options: NormalizeKStartupOptions = {},
): NormalizedGrant<KStartupAnnouncement> {
  const asOf = options.asOf ?? new Date();
  const collectedAt = options.collectedAt ?? new Date();
  const sourceId = String(row.pbanc_sn);
  const criteria = buildKStartupCriteria(row, sourceId);
  const grant = buildGrant(row, sourceId, criteria, asOf);
  const raw: GrantRaw<KStartupAnnouncement> = {
    source: KSTARTUP_SOURCE,
    source_id: sourceId,
    payload: row,
    collected_at: collectedAt.toISOString(),
    status: "normalized",
  };

  return { raw, grant, criteria };
}

export function buildKStartupCriteria(
  row: KStartupAnnouncement,
  sourceId = String(row.pbanc_sn),
): GrantCriterion[] {
  const criteria: GrantCriterion[] = [];
  const region = parseRegion(row.supt_regin);

  if (!region.nationwide) {
    criteria.push(makeCriterion(sourceId, "region", {
      dimension: "region",
      operator: "in",
      kind: "required",
      value: region,
      confidence: 0.98,
      source_field: "supt_regin",
      source_span: clean(row.supt_regin),
      raw_text: clean(row.supt_regin),
    }));
  }

  const metroExclusion = parseMetroExclusion(row.aply_excl_trgt_ctnt);
  if (metroExclusion) {
    criteria.push(makeCriterion(sourceId, "region-exclusion-metro", {
      dimension: "region",
      operator: "not_in",
      kind: "exclusion",
      value: metroExclusion,
      confidence: 0.9,
      source_field: "aply_excl_trgt_ctnt",
      source_span: "수도권 소재 기업 제외",
      raw_text: clean(row.aply_excl_trgt_ctnt),
    }));
  }

  const bizAge = parseBizAge(row.biz_enyy);
  if (bizAge.max_months !== null || bizAge.include_preliminary) {
    criteria.push(makeCriterion(sourceId, "biz-age", {
      dimension: "biz_age",
      operator: bizAge.max_months === null ? "in" : "lte",
      kind: "required",
      value: bizAge,
      confidence: 0.98,
      source_field: "biz_enyy",
      source_span: clean(row.biz_enyy),
      raw_text: clean(row.biz_enyy),
    }));
  }

  const founderAge = parseFounderAge(row.biz_trgt_age);
  if (founderAge) {
    criteria.push(makeCriterion(sourceId, "founder-age", {
      dimension: "founder_age",
      operator: "in",
      kind: "required",
      value: founderAge,
      confidence: 0.98,
      source_field: "biz_trgt_age",
      source_span: clean(row.biz_trgt_age),
      raw_text: clean(row.biz_trgt_age),
    }));
  }

  criteria.push(...buildScopedTextCriteria(row, sourceId));
  return criteria;
}

function buildGrant(
  row: KStartupAnnouncement,
  sourceId: string,
  criteria: GrantCriterion[],
  asOf: Date,
): Grant {
  const applyStart = parseKStartupDate(row.pbanc_rcpt_bgng_dt);
  const applyEnd = parseKStartupDate(row.pbanc_rcpt_end_dt);
  const projection = deriveProjection(criteria);

  return {
    source: KSTARTUP_SOURCE,
    source_id: sourceId,
    title: decodeHtml(clean(row.biz_pbanc_nm) || clean(row.intg_pbanc_biz_nm) || sourceId),
    url: row.detl_pg_url ?? row.biz_gdnc_url ?? null,
    agency_jurisdiction: row.pbanc_ntrp_nm ?? null,
    agency_operator: row.biz_prch_dprt_nm ?? null,
    category_l1: row.sprv_inst ?? null,
    category_l2: row.supt_biz_clsfc ?? null,
    apply_start: applyStart,
    apply_end: applyEnd,
    apply_method: {
      online: row.aply_mthd_onli_rcpt_istc ?? null,
      email: row.aply_mthd_eml_rcpt_istc ?? null,
      fax: row.aply_mthd_fax_rcpt_istc ?? null,
      visit: row.aply_mthd_vst_rcpt_istc ?? null,
      postal: row.aply_mthd_pssr_rcpt_istc ?? null,
      other: row.aply_mthd_etc_istc ?? null,
    },
    support_amount: null,
    required_documents: normalizeGrantRequiredDocuments(extractKStartupRequiredDocuments(row)),
    status: statusFromApplyWindow(row.pbanc_rcpt_bgng_dt, row.pbanc_rcpt_end_dt, asOf),
    f_regions: projection.f_regions,
    f_industries: projection.f_industries,
    f_biz_age_min_months: projection.f_biz_age_min_months,
    f_biz_age_max_months: projection.f_biz_age_max_months,
    f_sizes: projection.f_sizes,
    f_founder_traits: projection.f_founder_traits,
    f_required_certs: projection.f_required_certs,
    overall_confidence: projection.overall_confidence,
    model_ver: null,
    prompt_ver: null,
    parser_version: KSTARTUP_NORMALIZER_VERSION,
    updated_at: null,
  };
}

export function parseRegion(value: string | null | undefined): RegionCriterionValue {
  const label = clean(value);
  if (!label || label === "전국") return { regions: [], labels: [], nationwide: true };
  return {
    regions: [REGION_CODES[label] ?? label],
    labels: [label],
    nationwide: false,
  };
}

export function parseBizAge(value: string | null | undefined): BizAgeCriterionValue {
  const labels = splitComma(value);
  const years = labels.flatMap((token) => {
    const hit = token.match(/(\d+)\s*년\s*미만/);
    return hit ? [Number(hit[1])] : [];
  });

  return {
    max_months: years.length > 0 ? Math.max(...years) * 12 : null,
    include_preliminary: labels.includes("예비창업자"),
    basis: "공고 기준일",
    labels,
  };
}

export function parseFounderAge(
  value: string | null | undefined,
): FounderAgeCriterionValue | null {
  const labels = splitComma(value);
  if (labels.length === 0) return null;

  const hasUnder20 = labels.some((label) => /20세\s*미만/.test(label));
  const has20To39 = labels.some((label) => /20세\s*이상.*39세\s*이하/.test(label));
  const has40Plus = labels.some((label) => /40세\s*이상/.test(label));
  if (hasUnder20 && has20To39 && has40Plus) return null;

  const ranges: FounderAgeRange[] = [];
  for (const label of labels) {
    if (/20세\s*미만/.test(label)) ranges.push({ min: null, max: 19, label });
    if (/20세\s*이상.*39세\s*이하/.test(label)) ranges.push({ min: 20, max: 39, label });
    if (/40세\s*이상/.test(label)) ranges.push({ min: 40, max: null, label });
  }

  if (ranges.length === 0) return null;
  return {
    ranges,
    labels,
    youth_only: has20To39 && !has40Plus,
  };
}

function parseMetroExclusion(value: string | null | undefined): RegionCriterionValue | null {
  const text = clean(value);
  if (!text || !/수도권/.test(text) || !/제외|불가|신청\s*불가/.test(text)) return null;
  return {
    regions: [...METRO_REGION_CODES],
    labels: ["서울", "인천", "경기"],
    region_group: "수도권",
    nationwide: false,
  };
}

function buildScopedTextCriteria(
  row: KStartupAnnouncement,
  sourceId: string,
): GrantCriterion[] {
  const text = [row.aply_trgt_ctnt, row.aply_excl_trgt_ctnt].map(clean).filter(Boolean).join("\n");
  const criteria: GrantCriterion[] = [];
  if (!text) return criteria;

  if (TEXT_HINTS.size.test(text)) {
    criteria.push(makeCriterion(sourceId, "size-text", {
      dimension: "size",
      operator: "text_only",
      kind: "required",
      value: { note: "K-Startup 신청대상 상세의 기업규모 조건 확인 필요" },
      confidence: 0.55,
      source_field: "aply_trgt_ctnt",
      source_span: firstSentenceWith(text, TEXT_HINTS.size),
      raw_text: text,
      needs_review: true,
    }));
  }

  if (TEXT_HINTS.industry.test(text)) {
    criteria.push(makeCriterion(sourceId, "industry-text", {
      dimension: "industry",
      operator: "text_only",
      kind: "required",
      value: { note: "K-Startup 신청대상 상세의 업종/분야 조건 확인 필요" },
      confidence: 0.55,
      source_field: "aply_trgt_ctnt",
      source_span: firstSentenceWith(text, TEXT_HINTS.industry),
      raw_text: text,
      needs_review: true,
    }));
  }

  if (TEXT_HINTS.certification.test(text)) {
    criteria.push(makeCriterion(sourceId, "certification-text", {
      dimension: "certification",
      operator: "text_only",
      kind: "required",
      value: { note: "인증/특허/연구소 보유 조건 확인 필요" },
      confidence: 0.5,
      source_field: "aply_trgt_ctnt",
      source_span: firstSentenceWith(text, TEXT_HINTS.certification),
      raw_text: text,
      needs_review: true,
    }));
  }

  if (TEXT_HINTS.priorAwardOrBadStanding.test(clean(row.aply_excl_trgt_ctnt))) {
    criteria.push(makeCriterion(sourceId, "exclusion-text", {
      dimension: "other",
      operator: "text_only",
      kind: "exclusion",
      value: { note: "제외대상 해당 여부 확인 필요" },
      confidence: 0.6,
      source_field: "aply_excl_trgt_ctnt",
      source_span: firstSentenceWith(clean(row.aply_excl_trgt_ctnt), TEXT_HINTS.priorAwardOrBadStanding),
      raw_text: clean(row.aply_excl_trgt_ctnt),
      needs_review: true,
    }));
  }

  return criteria;
}

const DOCUMENT_PATTERNS: Array<{
  name: string;
  source: GrantRequiredDocument["source"];
  pattern: RegExp;
  note?: string;
}> = [
  { name: "신청서", source: "portal", pattern: /참가\s*신청서|신청서/ },
  {
    name: "계획서 및 제반서류",
    source: "self",
    pattern: /계획서.*제반서류|제반서류.*계획서/,
    note: "세부 양식은 공고문 확인",
  },
  { name: "사업자등록증", source: "self", pattern: /사업자등록증/ },
  { name: "법인등기부등본", source: "self", pattern: /법인\s*등기|법인등기부등본/ },
  { name: "룩북", source: "self", pattern: /룩북/ },
  { name: "라인시트", source: "self", pattern: /라인시트/ },
  { name: "쇼룸 계약서", source: "self", pattern: /쇼룸\s*계약서/ },
  { name: "트레이드쇼 참가결과", source: "self", pattern: /트레이드쇼\s*참가결과/ },
  { name: "매출/수출실적 증빙", source: "self", pattern: /매출\s*\/?\s*수출\s*실적|수출실적/ },
];

function extractKStartupRequiredDocuments(row: KStartupAnnouncement): GrantRequiredDocument[] | null {
  const fields = [
    { sourceField: "aply_trgt_ctnt", text: clean(row.aply_trgt_ctnt) },
    { sourceField: "aply_excl_trgt_ctnt", text: clean(row.aply_excl_trgt_ctnt) },
    { sourceField: "pbanc_ctnt", text: clean(row.pbanc_ctnt) },
  ].filter((field) => field.text);
  const documents = new Map<string, GrantRequiredDocument>();

  for (const field of fields) {
    for (const pattern of DOCUMENT_PATTERNS) {
      if (!pattern.pattern.test(field.text) || documents.has(pattern.name)) continue;
      const document: GrantRequiredDocument = {
        name: pattern.name,
        required: true,
        source: pattern.source,
        source_span: firstSentenceWith(field.text, pattern.pattern),
      };
      if (pattern.note) document.note = pattern.note;
      documents.set(pattern.name, document);
    }
  }

  return documents.size > 0 ? [...documents.values()] : null;
}

function deriveProjection(criteria: GrantCriterion[]) {
  const requiredRegionCriteria = criteria.filter(
    (criterion) => criterion.dimension === "region" && criterion.kind === "required",
  );
  const bizAge = criteria.find((criterion) => criterion.dimension === "biz_age");
  const bizAgeValue = bizAge?.value as BizAgeCriterionValue | undefined;

  return {
    f_regions: requiredRegionCriteria.flatMap((criterion) => {
      const value = criterion.value as RegionCriterionValue;
      return value.regions ?? [];
    }),
    f_industries: [] as string[],
    f_biz_age_min_months: bizAgeValue?.min_months ?? null,
    f_biz_age_max_months: bizAgeValue?.max_months ?? null,
    f_sizes: [] as string[],
    f_founder_traits: [] as string[],
    f_required_certs: [] as string[],
    overall_confidence: criteria.length
      ? round(criteria.reduce((sum, criterion) => sum + criterion.confidence, 0) / criteria.length)
      : 1,
  };
}

function makeCriterion(
  sourceId: string,
  suffix: string,
  criterion: Omit<GrantCriterion, "id" | "parser_version">,
): GrantCriterion {
  return {
    id: `${KSTARTUP_SOURCE}:${sourceId}:${suffix}`,
    parser_version: KSTARTUP_NORMALIZER_VERSION,
    ...criterion,
  };
}

function firstSentenceWith(text: string, pattern: RegExp): string {
  const normalized = clean(text);
  const parts = normalized.split(/[\r\n.。]+/).map((part) => part.trim()).filter(Boolean);
  return parts.find((part) => pattern.test(part)) ?? normalized.slice(0, 120);
}

function splitComma(value: string | null | undefined): string[] {
  return clean(value).split(",").map((part) => part.trim()).filter(Boolean);
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&#40;/g, "(")
    .replace(/&#41;/g, ")")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
