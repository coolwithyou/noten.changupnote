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

// ── 업종(industry) 축 분류 — 정밀도 우선 ─────────────────────────────────
// 원칙: required-IN 구조화는 "확실히 긍정·단일 업종" 문맥일 때만. 조금이라도 애매하면 placeholder 유지.
// (placeholder 는 "확인 필요"로 남을 뿐 오탈락을 만들지 않지만, 오탐 IN 은 적격 회사를 하드 탈락시킨다.)
//
// 실측 코퍼스(dev DB kstartup 10,690건 dry-run)에서 관찰된 오탐 유형:
//   ① 나열 불릿의 제외 업종("지원제외업종: …음식점업…")을 required 로 역전
//   ② 다분야 나열의 한 항목("IT관련업, 제조업, 디자인업 등")을 단일 업종으로 하드 제약
//   ③ "전 분야 환영"·"업종 제한은 없으나" 등 실제 무제한을 특정 업종으로 구조화
//   ④ "호텔업은 가능"(예외 허용)·규모기준절("광업·제조업…10명 미만")·기술 서술("하드웨어·소프트웨어")

// 전업종(업종/분야 무제한) 감지 — 매치 시 업종 축을 제약하지 않도록 criterion 자체를 만들지 않는다.
// "전 분야"는 "안전 분야" 오인을 막기 위해 앞경계(문두/공백/여는괄호/쉼표)를 요구한다.
export const INDUSTRY_ANY_PATTERN =
  /(?:^|[\s,(])전\s*분야|모든\s*분야|(?:^|[\s,(])전\s*산업|분야\s*(?:제한\s*(?:은|이)?\s*)?(?:없|무관|불문|상관\s*없)|업종\s*(?:제한\s*(?:은|이)?\s*)?(?:없|무관|불문|상관\s*없)|모든\s*업종|(?:^|[\s,(])전\s*업종|전업종|모든\s*창업/;

interface IndustryRule {
  pattern: RegExp;
  codes: string[];
  labels: string[];
}

// 명시 업종 소수 룰 — 확실한 키워드만 KSIC 중분류/대분류 코드로 구조화한다. 애매하면 placeholder 유지.
// 순서 = 우선순위(구체적인 룰을 앞에). 첫 매치 하나만 채택한다.
export const INDUSTRY_RULES: IndustryRule[] = [
  { pattern: /소프트웨어|SW\s*기업/, codes: ["582", "62"], labels: ["소프트웨어업"] },
  { pattern: /정보통신업/, codes: ["J"], labels: ["정보통신업"] },
  { pattern: /음식점|외식업|요식업/, codes: ["56"], labels: ["음식점업"] },
  { pattern: /관광|숙박업|호텔업/, codes: ["55", "752"], labels: ["관광·숙박업"] },
  { pattern: /제조업|제조업체/, codes: ["C"], labels: ["제조업"] },
  { pattern: /건설업/, codes: ["F"], labels: ["건설업"] },
  { pattern: /도소매업|도매업|소매업/, codes: ["G"], labels: ["도매 및 소매업"] },
  { pattern: /농업|농생명|임업|어업/, codes: ["A"], labels: ["농업·임업·어업"] },
];

// 구조화 차단 어휘(윈도 기준) — 제외/제한/우대/가점/예외/우선순위/이벤트·부정 문맥.
// 이 중 하나라도 매치 키워드 주변 윈도(같은 줄 + 앞 1줄)에 있으면 구조화하지 않고 placeholder 폴백.
const INDUSTRY_NEGATIVE_PATTERN =
  /제외|제한|불가|불허|우대|가점|가산|해당\s*없|예외|허용|환영|이외|아닌|없는\s*자|없어야|없을|않아도|불문|무관|우선\s*(?:선발|선정|지원|모집|대상)|순위|관심\s*(?:이|을)?\s*(?:있|많)|관계자|참관|수강|교육생|이수|취업|누구나/;

// 하드웨어+소프트웨어 동시 언급(기술 무관 서술) — SW 룰 오탐 방지.
const HARDWARE_SOFTWARE_PATTERN =
  /하드웨어\s*[·,]?\s*(?:및|또는)?\s*소프트웨어|소프트웨어\s*[·,]?\s*(?:및|또는)?\s*하드웨어/;

// 접미 '업' 토큰 중 업종 의미가 아닌 일반어(창업/기업/사업/산업/영업 등).
// 정확 일치(단독어) + 접미(중소기업·청년창업 등 회사유형/행위 서술어)를 모두 제외한다.
const GENERIC_UP_TOKEN =
  /^(?:창업|기업|사업|산업|취업|졸업|작업|부업|분업|협업|동업|개업|폐업|휴업|조업|파업|실업|수업|종업|잔업|가업|생업|본업|현업|영업)$/;
const GENERIC_UP_SUFFIX = /(?:기업|기업체|사업|창업|산업|영업|취업|졸업|작업|기업소|생업)$/;

// 다분야 나열 판정을 위한 "업종성" 접미어 토큰인지.
function isIndustryUpToken(token: string): boolean {
  return !GENERIC_UP_TOKEN.test(token) && !GENERIC_UP_SUFFIX.test(token);
}

// 원문(줄바꿈·불릿 보존)을 항목 단위 세그먼트로 분해한다. clean()이 개행을 뭉개기 전에 구조를 살린다.
function segmentText(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .flatMap((line) =>
      line.split(/(?=[▷▶►○◦∙※□▢◎●■◆]|[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]|\s[-–—]\s|\s\*\s)/),
    )
    .map((seg) => seg.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

// 윈도 안 서로 다른 업종성 '업' 토큰 개수 — 2개 이상이면 다분야 나열로 보고 구조화 차단.
function distinctIndustryUpTokens(text: string): number {
  const set = new Set<string>();
  for (const match of text.matchAll(/[가-힣]{2,}?업(?![가-힣])/g)) {
    if (isIndustryUpToken(match[0])) set.add(match[0]);
  }
  return set.size;
}

// 긍정 템플릿 — 키워드가 "지원대상 기업의 업종"을 뜻하는 구성일 때만 true.
function isPositiveIndustryContext(seg: string, rule: IndustryRule): boolean {
  const match = seg.match(rule.pattern);
  if (!match || match.index === undefined) return false;
  const keyword = match[0];
  const after = seg.slice(match.index + keyword.length, match.index + keyword.length + 14);
  const before = seg.slice(Math.max(0, match.index - 14), match.index);
  if (/^\s*등/.test(after)) return false; // "…업 등"(예시 나열)
  if (rule.labels[0] === "소프트웨어업") {
    // 접착 복합어(의료소프트웨어)와 목적어 서술(소프트웨어를 개선/활용)은 업종 제약이 아님
    if (/소프트웨어/.test(keyword) && /[가-힣]$/.test(before)) return false;
    if (/^\s*(?:을|를)\s*(?:개선|활용|도입|이용|사용|접목|보유)/.test(after)) return false;
  }
  if (/(?:을|를|은|는|이|가)?\s*영위/.test(after)) return true;
  if (/(?:관련\s*)?(?:창업|예비창업|기창업|초기창업)/.test(after)) return true;
  if (/(?:관련\s*)?(?:기업|사업체|소공인|스타트업|사업자(?!등록))/.test(after)) return true;
  if (
    /(?:관련\s*)?분야[가-힣\s]{0,10}(?:창업|예비|기업|사업자|모집|대상|소재|영위|희망|아이템|아이디어)/.test(after)
  ) {
    return true;
  }
  if (/(?:소재|지역|거주)/.test(before) && /(?:기업|사업체|스타트업|예비창업|창업자|분야)/.test(after)) {
    return true;
  }
  return false;
}

// 나열 신호 — 키워드가 쉼표/슬래시/가운뎃점/접속사로 이어진 다항목 나열의 한 원소인지.
function isIndustryListItem(seg: string, rule: IndustryRule): boolean {
  const match = seg.match(rule.pattern);
  if (!match || match.index === undefined) return false;
  const index = match.index;
  const keyword = match[0];
  const before = seg.slice(Math.max(0, index - 4), index);
  const after = seg.slice(index + keyword.length, index + keyword.length + 4);
  if (/,\s*$/.test(before) || /\s\/\s*$/.test(before)) return true; // 앞 쉼표/슬래시
  if (/^\s*,/.test(after) || /^\s*\/\s/.test(after)) return true; // 뒤 쉼표/슬래시
  if (/·\s*$/.test(before)) return true; // 가운뎃점 나열(선두 아님)
  if (/(?:및|또는)\s*$/.test(before)) return true; // 접속사 뒤 항목
  for (const paren of seg.matchAll(/\([^)]*\)/g)) {
    const start = paren.index ?? 0;
    if (index < start || index >= start + paren[0].length) continue;
    if (/[,·/]/.test(paren[0])) return true; // 괄호 안 나열
    if (/[A-Za-z]$/.test(seg.slice(0, start))) return true; // 영문 뒤 한글 역주(Agriculture(농업))
  }
  if (/및\s*[가-힣]+\s*(?:분야|기업|산업|콘텐츠|서비스업)/.test(seg)) return true;
  return false;
}

interface StructuredIndustryHit {
  codes: string[];
  labels: string[];
  span: string;
}

// 신청대상 원문에서 구조화 가능한 단일 명시 업종을 탐지. 실패 시 매치된(있다면) 룰 라벨만 반환.
function detectStructuredIndustry(
  applyRaw: string,
): { hit: StructuredIndustryHit } | { hit: null; matchedRuleLabel: string | null } {
  const segments = segmentText(applyRaw);
  let matchedRuleLabel: string | null = null;
  for (const rule of INDUSTRY_RULES) {
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg || !rule.pattern.test(seg)) continue;
      if (matchedRuleLabel === null) matchedRuleLabel = rule.labels[0] ?? null;
      const window = [segments[i - 1], seg].filter(Boolean).join(" ");
      if (INDUSTRY_RULES.filter((r) => r.pattern.test(window)).length >= 2) continue; // 복수 업종
      if (distinctIndustryUpTokens(window) >= 2) continue; // 다분야 나열
      if (INDUSTRY_NEGATIVE_PATTERN.test(window)) continue; // 제외/우대/조건 문맥
      if (rule.labels[0] === "소프트웨어업" && HARDWARE_SOFTWARE_PATTERN.test(window)) continue;
      if (isIndustryListItem(seg, rule)) continue; // 나열 원소
      if (!isPositiveIndustryContext(seg, rule)) continue; // 긍정 템플릿 미충족
      return { hit: { codes: rule.codes, labels: rule.labels, span: seg } };
    }
  }
  return { hit: null, matchedRuleLabel };
}

export type IndustryOutcome = "structured" | "any" | "placeholder" | "none";
export interface IndustryClassification {
  outcome: IndustryOutcome;
  codes?: string[];
  labels?: string[];
  span?: string;
  /** 룰 키워드는 매치됐으나(placeholder) 가드/나열/템플릿으로 구조화가 차단된 경우의 라벨. 진단용. */
  matchedRuleLabel?: string | null;
}

// 업종 축 분류의 단일 원천(single source of truth). buildScopedTextCriteria 와 진단 CLI 가 함께 사용한다.
export function classifyKStartupIndustry(row: KStartupAnnouncement): IndustryClassification {
  const combined = [row.aply_trgt_ctnt, row.aply_excl_trgt_ctnt]
    .map(clean)
    .filter(Boolean)
    .join("\n");
  if (!combined || !TEXT_HINTS.industry.test(combined)) return { outcome: "none" };
  if (INDUSTRY_ANY_PATTERN.test(combined)) return { outcome: "any" };
  const result = detectStructuredIndustry(row.aply_trgt_ctnt ?? "");
  if (result.hit) {
    return {
      outcome: "structured",
      codes: result.hit.codes,
      labels: result.hit.labels,
      span: result.hit.span,
    };
  }
  return {
    outcome: "placeholder",
    span: firstSentenceWith(combined, TEXT_HINTS.industry),
    matchedRuleLabel: result.matchedRuleLabel,
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

  // 업종 축 — 정밀도 우선 분류(전업종=criterion 없음 / 단일 명시 업종=구조화 / 그 외=placeholder).
  // 명시 업종 감지는 신청대상 원문에만 실행한다(제외대상의 "…업 등은 제외" 역전을 방지).
  const industry = classifyKStartupIndustry(row);
  if (industry.outcome === "structured") {
    // 룰 기반 구조화 — 검수 전이므로 confidence 0.6, needs_review 유지(확정 취급 금지).
    criteria.push(makeCriterion(sourceId, "industry-rule", {
      dimension: "industry",
      operator: "in",
      kind: "required",
      value: {
        codes: industry.codes ?? [],
        labels: industry.labels ?? [],
        industries: industry.labels ?? [],
      },
      confidence: 0.6,
      source_field: "aply_trgt_ctnt",
      source_span: industry.span ?? "",
      raw_text: text,
      needs_review: true,
    }));
  } else if (industry.outcome === "placeholder") {
    criteria.push(makeCriterion(sourceId, "industry-text", {
      dimension: "industry",
      operator: "text_only",
      kind: "required",
      value: { note: "K-Startup 신청대상 상세의 업종/분야 조건 확인 필요" },
      confidence: 0.55,
      source_field: "aply_trgt_ctnt",
      source_span: industry.span ?? firstSentenceWith(text, TEXT_HINTS.industry),
      raw_text: text,
      needs_review: true,
    }));
  }
  // outcome "any"(전업종) | "none"(업종 힌트 없음) → 업종 criterion 없음

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
