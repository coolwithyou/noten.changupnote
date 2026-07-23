import type {
  ActionQueueItem,
  BenefitBadge,
  ChecklistSection,
  CompanyProfile,
  CriterionDimension,
  Grant,
  MatchCard,
  MatchRecommendationTier,
  MatchResult,
  NormalizedGrant,
  OpportunityBucket,
  RequiredDocument,
  RuleTraceChip,
  RuleTraceChipResult,
  SupportAmount,
  WriteSupportLevel,
} from "@cunote/contracts";
import { isDraftableDocument } from "../documents/preparation.js";

export interface MatchedGrant<TPayload = unknown> {
  item: NormalizedGrant<TPayload>;
  match: MatchResult;
}

export function toMatchCard<TPayload>(
  entry: MatchedGrant<TPayload>,
  options: { asOf?: Date } = {},
): MatchCard {
  const { grant } = entry.item;
  const grantId = grantKey(grant);
  const detailUrl = `/grants/${encodeURIComponent(grantId)}`;
  const reviewGate = entry.match.review_gate;
  // 자가신고 확인으로 해소·확정된 entry 수("본인 확인 기반" 보조 뱃지 근거). RuleTraceChip 은
  // 표시 요약이라 resolution 을 싣지 않으므로 원본 rule_trace 에서 센다. 0이면 필드를 싣지 않는다
  // (confirmationQuestionCount 관례와 동일).
  const userConfirmedCount = entry.match.rule_trace.filter(
    (trace) => trace.resolution === "confirmed_by_user",
  ).length;

  return {
    grantId,
    source: grant.source,
    sourceId: grant.source_id,
    title: grant.title,
    agency: grant.agency_operator ?? grant.agency_jurisdiction ?? null,
    status: grant.status,
    eligibility: entry.match.eligibility,
    bucket: bucketForMatch(entry.match),
    fitScore: entry.match.fit_score,
    quality: entry.match.quality,
    ...(entry.match.ranking ? { ranking: entry.match.ranking } : {}),
    supportAmount: normalizeSupportAmount(grant.support_amount),
    benefits: deriveGrantBenefits(grant),
    applyEnd: grant.apply_end ?? null,
    dDay: daysUntil(grant.apply_end ?? null, options.asOf),
    ruleTrace: entry.match.rule_trace.map((trace) => toRuleTraceChip(trace, options)),
    ...(userConfirmedCount > 0 ? { userConfirmedCount } : {}),
    matchConfidence: estimateMatchConfidence(entry.match),
    rulesetVer: entry.match.ruleset_ver,
    scoringVer: entry.match.scoring_ver,
    criteriaExtracted: entry.match.criteria_extracted !== false,
    recommendationTier: reviewGate?.tier ?? fallbackRecommendationTier(entry.match),
    scoreDisplay: reviewGate?.scoreDisplay ?? "numeric",
    reviewReasons: reviewGate?.reasons ?? [],
    authoringMode: grant.f_authoring_mode ?? "unknown",
    writeSupport: deriveWriteSupport(grant),
    detailUrl,
  };
}

/**
 * 지원서 작성 도움 수준 파생. core 는 보관본을 모르므로 template_fill 은 내지 않는다
 * (apps/web 서버가 HWPX 보관본 배치 조회로 ai_draft → template_fill 승격).
 *   - 작성형 서류가 추출됨 → ai_draft (웹폼 사업이라도 사업계획서 초안은 지원 가능)
 *   - 웹폼 직접 입력 사업 → web_form_guide
 *   - 그 외(서류 미추출 file_form 포함) → unknown: 서식 존재만으로 초안을 약속하면 상세에서 빈 화면이 된다
 */
export function deriveWriteSupport(grant: Grant): WriteSupportLevel {
  if (normalizeRequiredDocuments(grant).some(isDraftableDocument)) return "ai_draft";
  if (grant.f_authoring_mode === "web_form") return "web_form_guide";
  return "unknown";
}

export function toRuleTraceChip(
  trace: MatchResult["rule_trace"][number],
  options: { asOf?: Date } = {},
): RuleTraceChip {
  const result: RuleTraceChipResult = trace.operator === "text_only" ? "text_only" : trace.result;
  const action = actionForTrace(result, trace.dimension);
  const chip: RuleTraceChip = {
    dimension: trace.dimension,
    kind: trace.kind,
    result,
    label: trace.message,
    checklistSection: checklistSectionFor(result, trace.kind),
  };
  const companyValue = summarizeCompanyValue(trace.company_value);
  const unlock = unlockForTrace(trace, options.asOf);
  if (companyValue) chip.companyValue = companyValue;
  if (trace.source_span) chip.sourceSpan = trace.source_span;
  if (action) chip.action = action;
  if (unlock) chip.unlock = unlock;
  return chip;
}

export function normalizeRequiredDocuments(grant: Grant): RequiredDocument[] {
  return (grant.required_documents ?? []).map((document) => {
    const normalized: RequiredDocument = {
      name: document.name,
      required: document.required,
      source: document.source,
    };
    if (document.category) normalized.category = document.category;
    if (document.preparation_type) normalized.preparationType = document.preparation_type;
    if (document.canonical_name) normalized.canonicalName = document.canonical_name;
    if (document.template_required !== undefined) normalized.templateRequired = document.template_required;
    if (document.source_attachment) normalized.sourceAttachment = document.source_attachment;
    if (document.source_span) normalized.sourceSpan = document.source_span;
    if (document.note) normalized.note = document.note;
    if (document.confidence !== undefined) normalized.confidence = document.confidence;
    return normalized;
  });
}

export function normalizeSupportAmount(value: Grant["support_amount"]): SupportAmount {
  if (!value || typeof value !== "object") {
    return { min: null, max: null, unit: "KRW", per: "기업" };
  }

  const record = value as Record<string, unknown>;
  const amount: SupportAmount = {
    min: amountFromRecord(record, ["min", "min_krw"]),
    max: amountFromRecord(record, ["max", "max_krw", "amount", "value"]),
    unit: "KRW",
    per: record.per === "건" ? "건" : "기업",
  };
  if (typeof record.label === "string" || record.label === null) amount.label = record.label;
  return amount;
}

export function supportAmountMax(value: Grant["support_amount"]): number {
  return normalizeSupportAmount(value).max ?? 0;
}

export function deriveGrantBenefits(grant: Grant): BenefitBadge[] {
  const benefits = new Map<BenefitBadge["family"], BenefitBadge>();
  const push = (benefit: BenefitBadge) => {
    const current = benefits.get(benefit.family);
    if (!current || compareBenefitStrength(benefit, current) < 0) {
      benefits.set(benefit.family, benefit);
    }
  };

  for (const benefit of grant.benefits ?? []) {
    push({
      family: benefit.family,
      label: benefit.label,
      source: benefit.source,
      confidence: benefit.confidence ?? STRUCTURED_BENEFIT_DEFAULT_CONFIDENCE,
    });
  }

  const amount = normalizeSupportAmount(grant.support_amount);
  if (hasPositiveSupportAmount(amount) || isBenefitBearingSupportLabel(amount.label)) {
    push({
      family: "funding",
      label: "자금",
      source: "support_amount",
      confidence: 0.88,
    });
  }

  const textSources = [
    { source: "title" as const, text: grant.title },
    { source: "category" as const, text: [grant.category_l1, grant.category_l2].filter(Boolean).join(" ") },
    { source: "apply_method" as const, text: Object.values(grant.apply_method ?? {}).filter(Boolean).join(" ") },
  ];

  for (const item of textSources) {
    const text = cleanText(item.text);
    if (!text) continue;
    for (const rule of BENEFIT_RULES) {
      const pattern = item.source === "title" ? rule.titlePattern : rule.contextPattern;
      if (pattern.test(text)) {
        push({
          family: rule.family,
          label: rule.label,
          source: item.source,
          confidence: item.source === "title" ? rule.titleConfidence : CONTEXT_BENEFIT_CONFIDENCE,
        });
      }
    }
  }

  return [...benefits.values()]
    .sort((a, b) => BENEFIT_FAMILY_RANK[a.family] - BENEFIT_FAMILY_RANK[b.family])
    .slice(0, MAX_BENEFITS);
}

export function daysUntil(value: string | null, asOf = new Date()): number | null {
  if (!value) return null;
  const target = calendarDateUtc(value);
  const today = calendarDateUtc(asOf);
  if (!target || !today) return null;
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

const KOREA_TIME_ZONE = "Asia/Seoul";

function calendarDateUtc(value: string | Date): Date | null {
  if (typeof value === "string") {
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
    if (dateOnly) {
      const date = new Date(Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])));
      return date.toISOString().slice(0, 10) === value.trim() ? date : null;
    }
  }

  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: KOREA_TIME_ZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(date);
  const read = (type: "year" | "month" | "day") =>
    Number(parts.find((part) => part.type === type)?.value ?? "0");
  return new Date(Date.UTC(read("year"), read("month") - 1, read("day")));
}

export interface MatchTransitionWindow {
  eligibleFrom: Date | null;
  eligibleUntil: Date | null;
}

export function calculateMatchTransitionWindow(
  match: MatchResult,
  options: { asOf?: Date } = {},
): MatchTransitionWindow {
  const asOf = options.asOf ?? new Date();
  const hardFails = match.rule_trace.filter((trace) =>
    trace.result === "fail" && (trace.kind === "required" || trace.kind === "exclusion")
  );
  const unlockDates = hardFails
    .filter(isUnlockableBizAgeTrace)
    .map((trace) => {
      const record = trace.company_value as Record<string, unknown>;
      return addMonthsUtcDate(asOf, (record.unlock_at_months as number) - (record.biz_age_months as number));
    });
  const lockDates = match.rule_trace
    .filter((trace) => trace.dimension === "biz_age" && trace.result === "pass")
    .map(bizAgeLockDate(asOf))
    .filter((value): value is Date => value !== null);

  return {
    eligibleFrom: hardFails.length > 0 && hardFails.length === unlockDates.length ? latestDate(unlockDates) : null,
    eligibleUntil: match.eligibility !== "ineligible" ? earliestDate(lockDates) : null,
  };
}

export function grantKey(grant: Pick<Grant, "id" | "source" | "source_id">): string {
  return grant.id ?? `${grant.source}:${grant.source_id}`;
}

// 같은 적격도 안에서는 지원서 작성을 도와줄 수 있는 사업을 먼저 보여준다(핵심 BM).
// 조건 확인도보다 앞선 3차 키 — 배지가 정렬 근거를 화면에서 설명한다.
const WRITE_SUPPORT_SORT_RANK: Record<WriteSupportLevel, number> = {
  template_fill: 0,
  ai_draft: 0,
  web_form_guide: 1,
  unknown: 2,
};

export function sortMatchedGrants<TPayload>(entries: MatchedGrant<TPayload>[]): MatchedGrant<TPayload>[] {
  const decorated = entries.map((entry, index) => ({
    entry,
    index,
    writeSupportRank: WRITE_SUPPORT_SORT_RANK[deriveWriteSupport(entry.item.grant)],
  }));
  decorated.sort((a, b) =>
    compareMatchedGrant(a.entry, b.entry, a.writeSupportRank, b.writeSupportRank) || a.index - b.index
  );
  return decorated.map((item) => item.entry);
}

export function countByEligibility(matches: MatchResult[]): {
  eligible: number;
  conditional: number;
  ineligible: number;
} {
  return matches.reduce(
    (acc, match) => {
      acc[match.eligibility] += 1;
      return acc;
    },
    { eligible: 0, conditional: 0, ineligible: 0 },
  );
}

export function companyAttributes(company: CompanyProfile) {
  return {
    region: company.region?.label ?? company.region?.code ?? null,
    size: company.size ?? null,
    bizAgeMonths: company.biz_age_months ?? null,
    industry: company.industries ?? [],
  };
}

export function companySummary(company: CompanyProfile) {
  return {
    name: company.name ?? null,
    region: company.region?.label ?? company.region?.code ?? null,
    size: company.size ?? null,
    bizAgeMonths: company.biz_age_months ?? null,
    industries: company.industries ?? [],
  };
}

export function urgencyForDday(dDay: number | null): ActionQueueItem["urgency"] {
  if (dDay !== null && dDay <= 7) return "high";
  if (dDay !== null && dDay <= 21) return "medium";
  return "low";
}

function bucketForMatch(match: MatchResult): OpportunityBucket {
  const tier = match.review_gate?.tier ?? fallbackRecommendationTier(match);
  if (match.eligibility !== "ineligible" && tier !== "recommendable") return "conditional";
  if (match.eligibility === "eligible") return "now";
  if (match.eligibility === "conditional") return "conditional";
  if (isTimeUnlockableMatch(match)) return "soon";
  return "preparable";
}

function checklistSectionFor(result: RuleTraceChipResult, kind: RuleTraceChip["kind"]): ChecklistSection {
  if (result === "pass") return "satisfied";
  if (result === "text_only") return "document";
  if (kind === "preferred") return "preferred_miss";
  return "needs_check";
}

function actionForTrace(result: RuleTraceChipResult, dimension: CriterionDimension): RuleTraceChip["action"] | undefined {
  if (result === "unknown") {
    return {
      type: "progressive",
      target: dimension,
      label: "지금 확인",
    };
  }
  if (result === "text_only") {
    return {
      type: "external_link",
      target: "source",
      label: "원문 확인",
    };
  }
  if (result === "fail") {
    return {
      type: "prepare",
      target: dimension,
      label: "준비 조건 보기",
    };
  }
  return undefined;
}

function isTimeUnlockableMatch(match: MatchResult): boolean {
  const hardFails = match.rule_trace.filter((trace) =>
    trace.result === "fail" && (trace.kind === "required" || trace.kind === "exclusion")
  );
  return hardFails.length > 0 && hardFails.every(isUnlockableBizAgeTrace);
}

function isUnlockableBizAgeTrace(trace: MatchResult["rule_trace"][number]): boolean {
  const value = trace.company_value;
  if (trace.dimension !== "biz_age" || trace.kind !== "required" || typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.biz_age_months === "number" &&
    typeof record.unlock_at_months === "number" &&
    record.biz_age_months < record.unlock_at_months;
}

function unlockForTrace(
  trace: MatchResult["rule_trace"][number],
  asOf = new Date(),
): RuleTraceChip["unlock"] | undefined {
  if (!isUnlockableBizAgeTrace(trace)) return undefined;
  const record = trace.company_value as Record<string, unknown>;
  const currentMonths = record.biz_age_months as number;
  const unlockAtMonths = record.unlock_at_months as number;
  const monthsUntilUnlock = Math.max(0, unlockAtMonths - currentMonths);
  return {
    kind: "time",
    detail: `${formatMonthCount(monthsUntilUnlock)} 후 업력 조건 충족 가능`,
    etaDate: addMonthsIsoDate(asOf, monthsUntilUnlock),
  };
}

function bizAgeLockDate(asOf: Date) {
  return (trace: MatchResult["rule_trace"][number]): Date | null => {
    const value = trace.company_value;
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (typeof record.biz_age_months !== "number" || typeof record.lock_after_months !== "number") {
      return null;
    }
    const monthsUntilLock = record.lock_after_months - record.biz_age_months;
    return monthsUntilLock > 0 ? addMonthsUtcDate(asOf, monthsUntilLock) : null;
  };
}

function compareMatchedGrant<TPayload>(
  a: MatchedGrant<TPayload>,
  b: MatchedGrant<TPayload>,
  aWriteSupportRank = 0,
  bWriteSupportRank = 0,
): number {
  const trustRank = recommendationTierRank(a.match) - recommendationTierRank(b.match);
  if (trustRank !== 0) return trustRank;

  const rank: Record<MatchResult["eligibility"], number> = {
    eligible: 0,
    conditional: 1,
    ineligible: 2,
  };
  return rank[a.match.eligibility] - rank[b.match.eligibility] ||
    extractionReadinessRank(a.match) - extractionReadinessRank(b.match) ||
    descendingNullable(a.match.ranking?.relevanceScore, b.match.ranking?.relevanceScore) ||
    descendingNullable(a.match.ranking?.priorityScore, b.match.ranking?.priorityScore) ||
    deadlineSortRank(a.item.grant.apply_end) - deadlineSortRank(b.item.grant.apply_end) ||
    aWriteSupportRank - bWriteSupportRank ||
    b.match.fit_score - a.match.fit_score ||
    // cursor pagination은 요청마다 DB row 순서가 달라도 동일한 정렬을 재현해야 한다.
    grantKey(a.item.grant).localeCompare(grantKey(b.item.grant));
}

function extractionReadinessRank(match: MatchResult): number {
  const rank: Record<MatchResult["quality"]["extractionReadiness"], number> = {
    reviewed: 0,
    structured_unreviewed: 1,
    partial: 2,
    unstructured: 3,
  };
  return rank[match.quality.extractionReadiness];
}

function descendingNullable(a: number | null | undefined, b: number | null | undefined): number {
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  return b - a;
}

function deadlineSortRank(value: string | null | undefined): number {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const time = parseDate(value)?.getTime();
  return time === undefined ? Number.MAX_SAFE_INTEGER : time;
}

function fallbackRecommendationTier(match: MatchResult): MatchRecommendationTier {
  if (match.eligibility === "ineligible") return "not_recommended";
  if (match.eligibility === "conditional") return "needs_profile_input";
  return "recommendable";
}

function recommendationTierRank(match: MatchResult): number {
  const tier = match.review_gate?.tier ?? fallbackRecommendationTier(match);
  const rank: Record<MatchRecommendationTier, number> = {
    recommendable: 0,
    needs_profile_input: 1,
    needs_core_review: 2,
    not_recommended: 3,
  };
  return rank[tier];
}

function estimateMatchConfidence(match: MatchResult): number {
  if (match.rule_trace.length === 0) return 0;
  const unknownCount = match.rule_trace.filter((trace) => trace.result === "unknown").length;
  const ratio = 1 - unknownCount / match.rule_trace.length;
  return Math.round(Math.max(0.3, ratio) * 100) / 100;
}

function summarizeCompanyValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map((item) => summarizeCompanyValue(item)).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.label === "string") return record.label;
    if (typeof record.code === "string") return record.code;
    if (typeof record.biz_age_months === "number") return `${record.biz_age_months}개월`;
    if (typeof record.founder_age === "number") return `${record.founder_age}세`;
  }
  return undefined;
}

function amountFromRecord(record: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
}

function cleanText(value: string | null | undefined): string | null {
  const text = value?.replace(/\s+/g, " ").trim();
  return text || null;
}

const BENEFIT_RULES: Array<{
  family: BenefitBadge["family"];
  label: string;
  titlePattern: RegExp;
  contextPattern: RegExp;
  titleConfidence: number;
}> = [
  {
    family: "funding",
    label: "자금",
    titlePattern: /지원금|사업화\s*자금|바우처|보조금|R&D|연구개발비?|개발비|시제품\s*(?:제작|개발)\s*지원|쿠폰/i,
    contextPattern: /지원금|자금|사업화|바우처|보조금|R&D|연구개발|개발비|시제품|비용|쿠폰/i,
    titleConfidence: 0.86,
  },
  {
    family: "loan",
    label: "융자",
    titlePattern: /융자|대출|(?:신용|기술|정책)?보증|이차보전/,
    contextPattern: /융자|대출|보증|이자|이차보전/,
    titleConfidence: 0.9,
  },
  {
    family: "capability",
    label: "역량",
    titlePattern: /교육|컨설팅|멘토링|액셀러레이팅|역량\s*강화|창업교육/,
    contextPattern: /교육|컨설팅|멘토링|액셀러레이팅|역량|육성|창업교육/,
    titleConfidence: 0.86,
  },
  {
    family: "space",
    label: "공간",
    titlePattern: /입주(?:기업|사|지원|공간|모집)?|(?:창업|업무|사무|보육)\s*공간/,
    contextPattern: /입주|공간|센터|사무|보육센터/,
    titleConfidence: 0.86,
  },
  {
    family: "market",
    label: "판로",
    titlePattern: /판로|수출|해외\s*진출|바이어|(?:전시회|박람회)\s*참가|팝업\s*스토어/,
    contextPattern: /판로|마케팅|홍보|전시|박람회|수출|글로벌|팝업|해외|바이어/,
    titleConfidence: 0.88,
  },
  {
    family: "certification",
    label: "인증",
    titlePattern: /인증|특허|지식재산|\bIP\b|인허가/i,
    contextPattern: /인증|특허|지식재산|IP|시험|검증|인허가/i,
    titleConfidence: 0.9,
  },
  {
    family: "network",
    label: "연결",
    titlePattern: /네트워킹|오픈\s*이노베이션|투자\s*유치|IR\s*(?:피칭|데모데이|투자)|데모데이|교류회/i,
    contextPattern: /네트워크|네트워킹|오픈이노베이션|행사|투자|IR|데모데이|연계|교류|협업/i,
    titleConfidence: 0.88,
  },
];

const STRUCTURED_BENEFIT_DEFAULT_CONFIDENCE = 0.7;
const CONTEXT_BENEFIT_CONFIDENCE = 0.64;
const MAX_BENEFITS = 5;
const BENEFIT_FAMILY_ORDER: BenefitBadge["family"][] = [
  "funding",
  "loan",
  "capability",
  "space",
  "market",
  "certification",
  "network",
];
const BENEFIT_FAMILY_RANK = Object.fromEntries(
  BENEFIT_FAMILY_ORDER.map((family, index) => [family, index]),
) as Record<BenefitBadge["family"], number>;
const BENEFIT_SOURCE_RANK: Record<BenefitBadge["source"], number> = {
  structured: 0,
  support_amount: 1,
  title: 2,
  category: 3,
  apply_method: 4,
};
const SUPPORT_AMOUNT_BENEFIT_LABEL_PATTERN =
  /지원금|보조금|바우처|쿠폰|사업화\s*자금|사업비|개발비|연구비|상금|현금|\d[\d,.]*\s*(?:원|만원|천만원|백만원|억원)/i;

function compareBenefitStrength(a: BenefitBadge, b: BenefitBadge): number {
  const sourceRank = BENEFIT_SOURCE_RANK[a.source] - BENEFIT_SOURCE_RANK[b.source];
  if (sourceRank !== 0) return sourceRank;
  const confidenceRank = b.confidence - a.confidence;
  if (confidenceRank !== 0) return confidenceRank;
  if (a.label === b.label) return 0;
  return a.label < b.label ? -1 : 1;
}

function hasPositiveSupportAmount(amount: SupportAmount): boolean {
  return (amount.min ?? 0) > 0 || (amount.max ?? 0) > 0;
}

function isBenefitBearingSupportLabel(label: string | null | undefined): boolean {
  const text = cleanText(label);
  return text ? SUPPORT_AMOUNT_BENEFIT_LABEL_PATTERN.test(text) : false;
}

function parseDate(value: string): Date | null {
  const parts = value.split("-").map((part) => Number(part));
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (!year || !month || !day) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function addMonthsIsoDate(value: Date, months: number): string {
  return addMonthsUtcDate(value, months).toISOString().slice(0, 10);
}

function addMonthsUtcDate(value: Date, months: number): Date {
  const result = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  result.setUTCMonth(result.getUTCMonth() + months);
  return result;
}

function formatMonthCount(months: number): string {
  if (months <= 0) return "지금";
  const years = Math.floor(months / 12);
  const rest = months % 12;
  if (years === 0) return `${rest}개월`;
  if (rest === 0) return `${years}년`;
  return `${years}년 ${rest}개월`;
}

function latestDate(values: Date[]): Date | null {
  if (values.length === 0) return null;
  return values.reduce((latest, value) => value.getTime() > latest.getTime() ? value : latest);
}

function earliestDate(values: Date[]): Date | null {
  if (values.length === 0) return null;
  return values.reduce((earliest, value) => value.getTime() < earliest.getTime() ? value : earliest);
}
