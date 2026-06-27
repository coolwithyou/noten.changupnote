import type {
  ActionQueueItem,
  ChecklistSection,
  CompanyProfile,
  CriterionDimension,
  Grant,
  MatchCard,
  MatchResult,
  NormalizedGrant,
  OpportunityBucket,
  RequiredDocument,
  RuleTraceChip,
  RuleTraceChipResult,
  SupportAmount,
} from "@cunote/contracts";

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
    supportAmount: normalizeSupportAmount(grant.support_amount),
    applyEnd: grant.apply_end ?? null,
    dDay: daysUntil(grant.apply_end ?? null, options.asOf),
    ruleTrace: entry.match.rule_trace.map((trace) => toRuleTraceChip(trace, options)),
    matchConfidence: estimateMatchConfidence(entry.match),
    rulesetVer: entry.match.ruleset_ver,
    scoringVer: entry.match.scoring_ver,
    detailUrl,
  };
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
    if (document.source_span) normalized.sourceSpan = document.source_span;
    if (document.note) normalized.note = document.note;
    return normalized;
  });
}

export function normalizeSupportAmount(value: Grant["support_amount"]): SupportAmount {
  if (isSupportAmount(value)) return value;
  return {
    min: null,
    max: amountFromRecord(value),
    unit: "KRW",
    per: "기업",
  };
}

export function supportAmountMax(value: Grant["support_amount"]): number {
  return normalizeSupportAmount(value).max ?? 0;
}

export function daysUntil(value: string | null, asOf = new Date()): number | null {
  if (!value) return null;
  const target = parseDate(value);
  if (!target) return null;
  const today = new Date(Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate()));
  return Math.ceil((target.getTime() - today.getTime()) / 86_400_000);
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

export function sortMatchedGrants<TPayload>(entries: MatchedGrant<TPayload>[]): MatchedGrant<TPayload>[] {
  return [...entries].sort((a, b) => compareMatch(a.match, b.match));
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

function compareMatch(a: MatchResult, b: MatchResult): number {
  const rank: Record<MatchResult["eligibility"], number> = {
    eligible: 0,
    conditional: 1,
    ineligible: 2,
  };
  return rank[a.eligibility] - rank[b.eligibility] || b.fit_score - a.fit_score;
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

function isSupportAmount(value: Grant["support_amount"]): value is SupportAmount {
  return Boolean(
    value &&
      typeof value === "object" &&
      "unit" in value &&
      value.unit === "KRW" &&
      "per" in value,
  );
}

function amountFromRecord(value: Grant["support_amount"]): number | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  for (const key of ["max", "max_krw", "amount", "value"]) {
    const candidate = record[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) return candidate;
  }
  return null;
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
