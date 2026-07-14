import type {
  CompanyProfile,
  CriterionDimension,
  Eligibility,
  MatchCard,
  MatchingProfileAnswerRequest,
  MatchingProfileViewRow,
  ProductTeaserResult,
  RuleTraceChipResult,
  CriterionKind,
  SupportAmount,
  TeaserResult,
  WriteSupportLevel,
} from "@cunote/contracts";
import { WRITE_SUPPORT_LABELS } from "@cunote/contracts";
import {
  readLocalBusinessLookupSuggestions,
  recordBusinessLookupSuggestion,
  upsertBusinessLookupSuggestion,
  writeLocalBusinessLookupSuggestions,
} from "@/lib/client/businessLookupSuggestions";

/* ───────────────────────── storage keys / constants ───────────────────────── */

export const PENDING_TEASER_STORAGE_KEY = "cunote.pendingTeaserRequest";
export const TEASER_FALLBACK_MESSAGE = "매칭 결과를 불러오지 못했습니다.";
const KOREA_TIME_ZONE = "Asia/Seoul";

export type Status = "idle" | "loading" | "ready" | "error" | "empty";
export type ProfileFieldView = {
  key: CriterionDimension;
  label: string;
  value: string;
  available: boolean;
  status: MatchingProfileViewRow["status"];
  sourceLabel: string | null;
  asOf: string | null;
  completeness: MatchingProfileViewRow["completeness"];
  editMode: MatchingProfileViewRow["editMode"];
  action: MatchingProfileViewRow["action"];
};
export type RevenueUnit = "won" | "manwon" | "eok";

export interface ProfileInputDraft {
  value: string;
  secondaryValue: string;
  unit: RevenueUnit;
}

export const REGION_OPTIONS = [
  { label: "서울", value: "11" },
  { label: "부산", value: "26" },
  { label: "대구", value: "27" },
  { label: "인천", value: "28" },
  { label: "광주", value: "29" },
  { label: "대전", value: "30" },
  { label: "울산", value: "31" },
  { label: "세종", value: "36" },
  { label: "경기", value: "41" },
  { label: "강원", value: "42" },
  { label: "충북", value: "43" },
  { label: "충남", value: "44" },
  { label: "전북", value: "45" },
  { label: "전남", value: "46" },
  { label: "경북", value: "47" },
  { label: "경남", value: "48" },
  { label: "제주", value: "50" },
];

export const SIZE_OPTIONS = ["소상공인", "중소기업", "중견기업", "대기업"].map((value) => ({ label: value, value }));
export const BUSINESS_STATUS_OPTIONS = [
  { label: "정상", value: "active" },
  { label: "휴업", value: "suspended" },
  { label: "폐업", value: "closed" },
];
export const TARGET_TYPE_OPTIONS = ["개인사업자", "법인"].map((value) => ({ label: value, value }));
export const REVENUE_UNIT_OPTIONS: Array<{ label: string; value: RevenueUnit; multiplier: number }> = [
  { label: "만원", value: "manwon", multiplier: 10_000 },
  { label: "억원", value: "eok", multiplier: 100_000_000 },
  { label: "원", value: "won", multiplier: 1 },
];

export class TeaserError extends Error {
  readonly code: string | null;
  constructor(message: string, code: string | null) {
    super(message);
    this.name = "TeaserError";
    this.code = code;
  }
}

/* ───────────────────────── business lookup memory ───────────────────────── */

export async function rememberBusinessLookup(digits: string) {
  const result = await recordBusinessLookupSuggestion(digits);
  if (!result?.suggestion || result.authenticated) return;
  const localSuggestion = {
    ...result.suggestion,
    source: "local" as const,
    cacheSource: "client_storage" as const,
  };
  const next = upsertBusinessLookupSuggestion(readLocalBusinessLookupSuggestions(), localSuggestion);
  writeLocalBusinessLookupSuggestions(next);
}

/* ───────────────────────── profile fields ───────────────────────── */

export function buildProfileFields(teaser: ProductTeaserResult): ProfileFieldView[] {
  return teaser.profileView.rows.map((row) => ({
    key: row.dimension,
    label: PROFILE_DIMENSION_LABELS[row.dimension],
    value: row.displayValue ?? "",
    available: row.status !== "unknown",
    status: row.status,
    sourceLabel: row.sourceLabel,
    asOf: row.asOf,
    completeness: row.completeness,
    editMode: row.editMode,
    action: row.action,
  }));
}

const PROFILE_DIMENSION_LABELS: Record<CriterionDimension, string> = {
  region: "소재 지역",
  biz_age: "업력",
  industry: "업종",
  size: "기업 규모",
  revenue: "연 매출",
  employees: "상시근로자",
  founder_age: "대표자 연령",
  founder_trait: "대표자 특성",
  certification: "인증·확인서",
  prior_award: "지원사업 수혜 이력",
  ip: "지식재산권",
  target_type: "사업자 유형",
  business_status: "영업 상태",
  tax_compliance: "세금 체납·결격",
  credit_status: "신용 상태",
  sanction: "제재·참여 제한",
  financial_health: "재무 건전성",
  insured_workforce: "고용보험 인력",
  investment: "투자 유치",
  premises: "사업장 요건",
  export_performance: "수출 실적",
  other: "기타 조건",
};

export function evidenceCheckedNote(evidence: TeaserResult["companyEvidence"]): string | null {
  if (!evidence || evidence.provider !== "popbill" || !evidence.checkedAt) return null;
  const checked = new Date(evidence.checkedAt);
  if (Number.isNaN(checked.getTime())) return null;
  const formatted = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(checked);
  const days = Math.floor((Date.now() - checked.getTime()) / 86_400_000);
  const staleSuffix = days >= 30 ? ` (${days}일 전)` : "";
  return `국세청·팝빌 정보 확인일 ${formatted}${staleSuffix}`;
}

export function sparseRegistryNotice(
  evidence: TeaserResult["companyEvidence"],
): { title: string; body: string } | null {
  if (!evidence || evidence.provider !== "popbill") return null;
  const fields = new Map(evidence.fields.map((field) => [field.key, field]));
  const checkedKeys = ["corp_name", "region", "biz_age", "industry"];
  const missingCheckedKeys = checkedKeys.filter((key) => !fields.get(key)?.available);
  const hasBusinessStatus = Boolean(fields.get("business_status")?.available);
  const providerSucceeded = evidence.resultMessage === "성공";
  if (!providerSucceeded || !hasBusinessStatus || missingCheckedKeys.length < 3) return null;

  return {
    title: "기관 데이터에 법인 기본정보가 아직 반영되지 않았을 수 있어요",
    body: "팝빌 조회는 성공했지만 상호, 소재지, 개업일, 업종 같은 기본 항목이 비어 있습니다. 설립 직후 법인은 국세청·연계기관 데이터 반영까지 시간이 걸릴 수 있어요. 사업자등록증이나 법인등기부 기준으로 빈 항목을 입력하면 매칭 정확도가 올라갑니다.",
  };
}

/* ───────────────────────── profile input drafts ───────────────────────── */

export function initialProfileInputDraft(fieldKey: string, currentValue?: string): ProfileInputDraft {
  const value = currentValue?.trim() ?? "";
  if (fieldKey === "founder_age") {
    return { value: founderBirthYearDraftValue(value), secondaryValue: "", unit: "manwon" };
  }
  if (fieldKey === "employees") {
    return { value: digitsOnly(value), secondaryValue: "", unit: "manwon" };
  }
  if (fieldKey === "revenue") return revenueDraftValue(value);
  if (fieldKey === "biz_age" || fieldKey === "bizAge") return bizAgeDraftValue(value);
  return {
    value: value || (fieldKey === "size" ? "중소기업" : fieldKey === "business_status" ? "정상" : ""),
    secondaryValue: "",
    unit: "manwon",
  };
}

export function profileFieldDisplayLabel(field: ProfileFieldView): string {
  if (!field.available && field.key === "founder_age") return "대표자 생년";
  return field.label;
}

export function profileFieldAsOfLabel(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeZone: KOREA_TIME_ZONE,
  }).format(date);
}

export function profileInputDescription(fieldKey: string): string {
  if (fieldKey === "corp_name") return "사업자등록증 또는 법인등기부에 적힌 상호를 입력합니다.";
  if (fieldKey === "region") return "본점 또는 사업장 소재지를 시도 단위로 선택합니다.";
  if (fieldKey === "biz_age" || fieldKey === "bizAge") return "개업일 이후 지난 기간을 년과 개월로 나눠 입력합니다.";
  if (fieldKey === "size") return "중소기업확인서 또는 내부 기준에 맞는 기업규모를 선택합니다.";
  if (fieldKey === "industry") return "주요 업종이나 사업 분야를 쉼표로 구분해 입력합니다.";
  if (fieldKey === "business_status") return "현재 국세청 기준 영업상태를 선택합니다.";
  if (fieldKey === "target_type") return "사업자등록증 기준 개인사업자 또는 법인을 선택합니다.";
  if (fieldKey === "founder_age") return "대표자 출생연도 4자리만 입력합니다. 연령은 현재 연도 기준으로 계산해 반영합니다.";
  if (fieldKey === "certification") return "여성기업확인서, 벤처기업확인서처럼 보유한 인증·확인서를 입력합니다.";
  if (fieldKey === "founder_trait") return "여성·청년·장애인 기업 등 대표자 특성을 쉼표로 구분해 입력합니다.";
  if (fieldKey === "ip") return "특허·상표·디자인 등 보유 지식재산권을 쉼표로 구분해 입력합니다.";
  if (fieldKey === "employees") return "4대보험 또는 내부 인사 기준의 상시근로자 수를 입력합니다.";
  if (fieldKey === "revenue") return "최근 결산 또는 직전 연도 기준 연 매출 숫자와 단위를 나눠 입력합니다.";
  return "공고 자격 판정에 필요한 값을 입력합니다.";
}

export function profileInputPlaceholder(fieldKey: string): string {
  if (fieldKey === "corp_name") return "(주)바톤";
  if (fieldKey === "region") return "서울";
  if (fieldKey === "biz_age" || fieldKey === "bizAge") return "8";
  if (fieldKey === "size") return "중소기업";
  if (fieldKey === "business_status") return "정상";
  if (fieldKey === "target_type") return "개인사업자";
  if (fieldKey === "founder_age") return "1987";
  if (fieldKey === "certification") return "여성기업확인서, 벤처기업확인서";
  if (fieldKey === "founder_trait") return "여성기업, 청년창업자";
  if (fieldKey === "ip") return "특허, 상표";
  if (fieldKey === "employees") return "12";
  if (fieldKey === "revenue") return "12000";
  if (fieldKey === "industry") return "시각 디자인업, 전자상거래 소매업";
  return "입력";
}

export function profileInputSuggestions(fieldKey: string): string[] {
  if (fieldKey === "region") return REGION_OPTIONS.map((option) => option.label);
  if (fieldKey === "size") return SIZE_OPTIONS.map((option) => option.label);
  if (fieldKey === "business_status") return BUSINESS_STATUS_OPTIONS.map((option) => option.label);
  if (fieldKey === "target_type") return TARGET_TYPE_OPTIONS.map((option) => option.label);
  if (fieldKey === "certification") return ["여성기업확인서", "벤처기업확인서", "이노비즈", "메인비즈"];
  if (fieldKey === "founder_trait") return ["여성기업", "청년창업자", "장애인기업", "재창업자"];
  if (fieldKey === "ip") return ["특허", "실용신안", "상표", "디자인"];
  if (fieldKey === "industry") return ["시각 디자인업", "전자상거래 소매업", "소프트웨어 개발업", "정보통신업"];
  return [];
}

function founderBirthYearDraftValue(value: string): string {
  const fourDigitYear = value.match(/\b(19\d{2}|20\d{2})\b/)?.[1];
  if (fourDigitYear) return fourDigitYear;
  const age = firstDisplayNumber(value);
  if (age === null) return "";
  const birthYear = new Date().getFullYear() - age;
  return birthYear > 0 ? String(birthYear) : "";
}

function revenueDraftValue(value: string): ProfileInputDraft {
  const normalized = value.replace(/[, ]/g, "");
  const amount = normalized.match(/\d+(\.\d+)?/)?.[0] ?? "";
  if (!amount) return { value: "", secondaryValue: "", unit: "manwon" };
  if (normalized.includes("억")) return { value: amount, secondaryValue: "", unit: "eok" };
  if (normalized.includes("원") && !normalized.includes("만")) return { value: amount, secondaryValue: "", unit: "won" };
  return { value: amount, secondaryValue: "", unit: "manwon" };
}

function bizAgeDraftValue(value: string): ProfileInputDraft {
  const normalized = value.replace(/\s/g, "");
  const years = normalized.match(/(\d+)년/)?.[1] ?? "";
  const months = normalized.match(/(\d+)개월/)?.[1] ?? "";
  return { value: years, secondaryValue: months, unit: "manwon" };
}

export function profileInputMode(fieldKey: string): React.HTMLAttributes<HTMLInputElement>["inputMode"] {
  if (fieldKey === "founder_age" || fieldKey === "employees") return "numeric";
  if (fieldKey === "revenue") return "decimal";
  return "text";
}

export function profileInputText(fieldKey: string, value: string): string {
  if (fieldKey === "founder_age" || fieldKey === "employees") {
    return fieldKey === "founder_age" ? digitsOnly(value).slice(0, 4) : digitsOnly(value);
  }
  if (fieldKey === "revenue") return decimalNumberText(value);
  if (fieldKey === "biz_age" || fieldKey === "bizAge") return digitsOnly(value);
  return value;
}

export function buildProfilePatch(
  fieldKey: string,
  draft: ProfileInputDraft,
): { profile: CompanyProfile } | { error: string } {
  const rawValue = draft.value.trim();
  const secondaryValue = draft.secondaryValue.trim();

  if (fieldKey === "corp_name") {
    const name = rawValue;
    if (!name) return { error: "상호를 입력해 주세요." };
    return { profile: { name } };
  }

  if (fieldKey === "region") {
    const option = REGION_OPTIONS.find((item) => item.label === rawValue || item.value === rawValue);
    if (!option) return { error: "소재지를 선택해 주세요." };
    return {
      profile: {
        region: { code: option.value, label: option.label },
        confidence: { region: 0.78 },
      },
    };
  }

  if (fieldKey === "biz_age" || fieldKey === "bizAge") {
    const years = rawValue ? parseNonNegativeInteger(rawValue) : 0;
    const months = secondaryValue ? parseNonNegativeInteger(secondaryValue) : 0;
    if (years === null || months === null) return { error: "업력은 년/개월 칸에 숫자만 입력해 주세요." };
    if (months > 11) return { error: "개월은 0부터 11까지 입력해 주세요." };
    const monthsTotal = years * 12 + months;
    if (monthsTotal <= 0) return { error: "업력은 1개월 이상으로 입력해 주세요." };
    return { profile: { biz_age_months: monthsTotal, confidence: { biz_age: 0.78 } } };
  }

  if (fieldKey === "size") {
    const option = SIZE_OPTIONS.find((item) => item.value === rawValue || item.label === rawValue);
    if (!option) return { error: "기업규모를 선택해 주세요." };
    return { profile: { size: option.value, confidence: { size: 0.76 } } };
  }

  if (fieldKey === "industry") {
    const industries = splitCommaList(rawValue);
    if (industries.length === 0) return { error: "업종을 한 개 이상 입력해 주세요." };
    return { profile: { industries, confidence: { industry: 0.72 } } };
  }

  if (fieldKey === "business_status") {
    const option = BUSINESS_STATUS_OPTIONS.find((item) => item.label === rawValue || item.value === rawValue);
    if (!option) return { error: "영업상태를 선택해 주세요." };
    return {
      profile: {
        business_status: { active: option.value === "active", label: option.label },
        confidence: { business_status: 0.82 },
      },
    };
  }

  if (fieldKey === "target_type") {
    const option = TARGET_TYPE_OPTIONS.find((item) => item.label === rawValue || item.value === rawValue);
    if (!option) return { error: "사업자 유형을 선택해 주세요." };
    return {
      profile: {
        target_types: [option.value],
        list_completeness: { target_type: "partial" },
        confidence: { target_type: 0.78 },
      },
    };
  }

  if (fieldKey === "founder_age") {
    const birthYear = parseBirthYear(rawValue);
    if (birthYear === null) return { error: "대표자 출생연도 4자리를 숫자로 입력해 주세요." };
    const age = new Date().getFullYear() - birthYear;
    if (age < 14 || age > 100) return { error: "대표자 연령은 만 14세부터 100세까지 입력해 주세요." };
    return { profile: { founder_age: age, confidence: { founder_age: 0.78 } } };
  }

  if (fieldKey === "certification") {
    const certs = splitCommaList(rawValue);
    if (certs.length === 0) return { error: "보유 인증·확인서를 한 개 이상 입력해 주세요." };
    return { profile: { certs, confidence: { certification: 0.68 } } };
  }

  if (fieldKey === "founder_trait") {
    const traits = splitCommaList(rawValue);
    if (traits.length === 0) return { error: "대표자 특성을 한 개 이상 입력해 주세요." };
    return { profile: { traits, confidence: { founder_trait: 0.68 } } };
  }

  if (fieldKey === "ip") {
    const ip = splitCommaList(rawValue);
    if (ip.length === 0) return { error: "지식재산권을 한 개 이상 입력해 주세요." };
    return { profile: { ip, confidence: { ip: 0.68 } } };
  }

  if (fieldKey === "employees") {
    const employees = parseNonNegativeInteger(rawValue);
    if (employees === null) return { error: "상시근로자 수를 숫자로 입력해 주세요." };
    return { profile: { employees_count: employees, confidence: { employees: 0.78 } } };
  }

  if (fieldKey === "revenue") {
    const revenue = parseRevenueKrw(rawValue, draft.unit);
    if (revenue === null) return { error: "연 매출 금액은 숫자로 입력하고 단위를 선택해 주세요." };
    return { profile: { revenue_krw: revenue, confidence: { revenue: 0.78 } } };
  }

  if (!rawValue) return { error: "값을 입력해 주세요." };
  return {
    profile: {
      other_conditions: { [fieldKey]: rawValue },
      confidence: { other: 0.4 },
    },
  };
}

export function buildProfileAnswer(
  field: CriterionDimension,
  draft: ProfileInputDraft,
): { answer: MatchingProfileAnswerRequest } | { error: string } {
  const result = buildProfilePatch(field, draft);
  if ("error" in result) return result;
  const profile = result.profile;
  const value = profileValueForAnswer(field, profile);
  if (value === undefined) return { error: "이 항목은 직접 입력으로 반영할 수 없습니다." };
  return { answer: { field, value } };
}

function profileValueForAnswer(field: CriterionDimension, profile: CompanyProfile): unknown {
  switch (field) {
    case "region": return profile.region;
    case "biz_age": return profile.biz_age_months;
    case "industry": return profile.industries;
    case "size": return profile.size;
    case "revenue": return profile.revenue_krw;
    case "employees": return profile.employees_count;
    case "founder_age": return profile.founder_age;
    case "founder_trait": return profile.traits;
    case "certification": return profile.certs;
    case "ip": return profile.ip;
    case "target_type": return profile.target_types;
    case "business_status": return profile.business_status;
    default: return undefined;
  }
}

/* ───────────────────────── primitive helpers ───────────────────────── */

function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function toRevenueUnit(value: unknown): RevenueUnit {
  return REVENUE_UNIT_OPTIONS.some((option) => option.value === value) ? (value as RevenueUnit) : "manwon";
}

export function revenueUnitLabel(value: RevenueUnit): string {
  return REVENUE_UNIT_OPTIONS.find((option) => option.value === value)?.label ?? "만원";
}

export function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function firstDisplayNumber(value: string): number | null {
  const match = value.replace(/,/g, "").match(/\d+/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function decimalNumberText(value: string): string {
  const normalized = value.replace(/[^\d.]/g, "");
  const [integer = "", ...fractionParts] = normalized.split(".");
  if (fractionParts.length === 0) return integer;
  return `${integer}.${fractionParts.join("")}`;
}

function parseBirthYear(value: string): number | null {
  if (!/^\d{4}$/.test(value)) return null;
  const parsed = Number(value);
  const currentYear = new Date().getFullYear();
  if (!Number.isSafeInteger(parsed) || parsed < 1900 || parsed > currentYear) return null;
  return parsed;
}

function parseNonNegativeInteger(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) return null;
  return parsed;
}

function parseRevenueKrw(value: string, unit: RevenueUnit): number | null {
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const multiplier = REVENUE_UNIT_OPTIONS.find((option) => option.value === unit)?.multiplier ?? 10_000;
  return Math.round(parsed * multiplier);
}

/* ───────────────────────── match derivations / formatting ───────────────────────── */

export function eligibilityLabel(value: Eligibility): string {
  if (value === "eligible") return "적격";
  if (value === "conditional") return "조건부";
  return "미해당";
}

export function isRecommendableMatch(match: MatchCard): boolean {
  return recommendationTierForMatch(match) === "recommendable";
}

export function isReviewNeededMatch(match: MatchCard): boolean {
  const tier = recommendationTierForMatch(match);
  return tier === "needs_core_review" || tier === "needs_profile_input";
}

function recommendationTierForMatch(match: MatchCard): NonNullable<MatchCard["recommendationTier"]> {
  return (
    match.recommendationTier ??
    (match.eligibility === "eligible"
      ? "recommendable"
      : match.eligibility === "ineligible"
        ? "not_recommended"
        : "needs_profile_input")
  );
}

export function isWriteSupported(level: WriteSupportLevel): boolean {
  return level === "template_fill" || level === "ai_draft";
}

export function writeSupportLabel(level: WriteSupportLevel): string | null {
  if (level === "unknown") return null;
  return WRITE_SUPPORT_LABELS[level];
}

export function writeSupportNote(level: WriteSupportLevel): string {
  if (level === "template_fill") {
    return "원본 서식 파일을 확보했어요. 결과 저장 후 회사 정보로 채운 초안과 서식 파일까지 받아볼 수 있어요.";
  }
  if (level === "ai_draft") {
    return "필요 서류와 사업계획서 초안은 결과 저장 후 신청 준비 단계에서 회사 정보로 채워 안내해 드려요.";
  }
  if (level === "web_form_guide") {
    return "이 사업은 포털 웹폼에서 직접 입력해 신청해요. 항목별로 붙여 넣을 답변 초안과 회사 정보 복사를 도와드려요.";
  }
  return "작성 서류가 아직 분석되지 않았어요. 원문 공고를 함께 확인하며 신청 준비를 도와드려요.";
}

export function writeSupportCta(level: WriteSupportLevel): string {
  if (level === "template_fill") return "서식 채워서 준비하기";
  if (level === "ai_draft") return "지원서 초안 준비하기";
  if (level === "web_form_guide") return "신청 항목 안내 받기";
  return "이 사업 신청 준비하기";
}

export function criterionResultText(result: RuleTraceChipResult): string {
  if (result === "pass") return "충족";
  if (result === "text_only") return "원문 확인";
  if (result === "unknown") return "확인 필요";
  return "미해당";
}

export function criterionKindLabel(kind: CriterionKind): string {
  if (kind === "preferred") return "우대";
  if (kind === "exclusion") return "배제";
  return "필수";
}

export function formatAmount(amount: SupportAmount): string {
  if (amount.label) return amount.label;
  const max = amount.max ?? 0;
  if (max <= 0) return "금액 확인";
  return formatKrwAmount(max);
}

export function formatKrwAmount(value: number): string {
  if (value >= 100_000_000) return `${Math.round(value / 100_000_000).toLocaleString("ko-KR")}억원`;
  if (value >= 10_000) return `${Math.round(value / 10_000).toLocaleString("ko-KR")}만원`;
  return `${Math.max(0, Math.round(value)).toLocaleString("ko-KR")}원`;
}

export function formatDday(value: number | null): string {
  if (value === null) return "상시";
  if (value < 0) return "마감 확인";
  if (value === 0) return "D-Day";
  return `D-${value}`;
}

export function isUrgentDday(value: number | null): boolean {
  return value !== null && value >= 0 && value <= 7;
}

export function clampPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

export function maskBiz(digits: string): string {
  if (digits.length !== 10) return "사업자";
  return `${digits.slice(0, 3)}-**-${digits.slice(5, 7)}***`;
}

export function readyHeadlineCount(teaser: TeaserResult): {
  tone: "recommendable" | "review" | "none";
  count: number;
} {
  const recommendableCount =
    teaser.counts.recommendable ??
    (teaser.recommendableMatches ?? teaser.matches.filter(isRecommendableMatch)).length;
  const reviewNeededCount =
    teaser.counts.reviewNeeded ??
    (teaser.reviewNeededMatches ?? teaser.matches.filter(isReviewNeededMatch)).length;
  if (recommendableCount > 0) return { tone: "recommendable", count: recommendableCount };
  if (reviewNeededCount > 0) return { tone: "review", count: reviewNeededCount };
  return { tone: "none", count: 0 };
}

/** 히어로 요약 통계: 최고 조건 확인도(숫자 표시 가능한 매치 기준). */
export function bestFitScore(teaser: TeaserResult): number | null {
  const scored = teaser.matches.filter(
    (match) => match.criteriaExtracted !== false && match.scoreDisplay !== "hidden",
  );
  if (scored.length === 0) return null;
  return scored.reduce((best, match) => Math.max(best, clampPct(match.fitScore)), 0);
}

export function searchContextNote(context: TeaserResult["searchContext"]): string | null {
  if (!context) return null;
  const asOf = formatKoreanDateTime(context.asOf);
  if (!asOf) return null;
  const targetCount = context.evaluatedGrantCount.toLocaleString("ko-KR");
  const lastCollectedAt = formatKoreanDateTime(context.lastCollectedAt);
  const collectionNote = lastCollectedAt ? ` 마지막 공고 수집일은 ${lastCollectedAt}예요.` : "";
  return `${asOf} 기준 지원 가능 여부를 확인할 수 있는 공고 ${targetCount}건을 대상으로 검색했어요.${collectionNote}`;
}

function formatKoreanDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("ko-KR", {
    timeZone: KOREA_TIME_ZONE,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const byType = new Map(parts.map((part) => [part.type, part.value]));
  const month = Number(byType.get("month"));
  const day = Number(byType.get("day"));
  const hourRaw = Number(byType.get("hour"));
  const minute = Number(byType.get("minute"));
  if (!Number.isFinite(month) || !Number.isFinite(day) || !Number.isFinite(hourRaw) || !Number.isFinite(minute)) {
    return new Intl.DateTimeFormat("ko-KR", {
      timeZone: KOREA_TIME_ZONE,
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    }).format(date);
  }
  const hour = hourRaw === 24 ? 0 : hourRaw;
  const minuteLabel = minute > 0 ? ` ${minute}분` : "";
  return `${month}월 ${day}일 ${hour}시${minuteLabel}`;
}
