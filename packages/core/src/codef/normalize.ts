/**
 * CODEF 국세청 확정값 → CompanyProfile 정규화 (profile-from-popbill 대칭).
 *
 * 사업자등록증명(region/biz_age/industry/target_type)과 부가세과세표준(revenue),
 * 간편인증 입력 생년월일(founder_age)을 병합해 매칭 프로필을 만든다.
 *
 * 원천이 국세청 확정값이라 신뢰도가 높다: region/biz_age/industry/target_type/revenue 0.95,
 * founder_age(입력 생년월일 파생) 0.9. 값 형태는 profile-from-popbill과 정합을 유지한다.
 * 생년월일 원본은 저장하지 않고 만나이만 파생한다.
 */

import type { CompanyProfile, CriterionDimension } from "@cunote/contracts";
import { calculateBizAgeMonths, resolveRegionFromAddress } from "../company/profile-from-popbill.js";
import { splitIndustryEntries } from "../industry/ksic.js";
import type { CorporateRegistrationFacts } from "./products/corporate-registration.js";
import type { VatBaseFacts } from "./products/vat-base-certificate.js";

/** 국세청 확정값 신뢰도. */
const CODEF_CONFIRMED_CONFIDENCE = 0.95;
/** founder_age(입력 생년월일 파생) 신뢰도. */
const CODEF_FOUNDER_AGE_CONFIDENCE = 0.9;

/** buildCompanyProfileFromCodef 입력. */
export interface CodefCompanyProfileInput {
  /** 사업자등록증명 정규화 결과. */
  corporateRegistration?: CorporateRegistrationFacts | null;
  /** 부가세과세표준 정규화 결과. */
  vatBase?: VatBaseFacts | null;
  /** 간편인증 입력 생년월일 8자리 yyyyMMdd(founder_age 파생용, 원본은 저장 안 함). */
  birthDate8?: string | null;
  /** 성별(선택 1탭 입력) — facts에만 기록, 프로필 차원은 Phase B에서 결합. */
  gender?: "M" | "F" | null;
  /** 기준 시각(biz_age·나이 계산). 기본 now. */
  asOf?: Date;
}

/** buildCompanyProfileFromCodef 결과. */
export interface CodefCompanyProfileResult {
  profile: CompanyProfile;
  facts: {
    has_region: boolean;
    has_biz_age: boolean;
    has_industry: boolean;
    has_target_type: boolean;
    has_revenue: boolean;
    has_founder_age: boolean;
    masked_identity_no: string | null;
    joint_representative: string | null;
    gender: "M" | "F" | null;
  };
}

/**
 * CODEF 국세청 확정값을 병합해 CompanyProfile을 만든다(순수).
 */
export function buildCompanyProfileFromCodef(
  input: CodefCompanyProfileInput,
): CodefCompanyProfileResult {
  const asOf = input.asOf ?? new Date();
  const corp = input.corporateRegistration ?? null;

  const region = corp ? resolveRegionFromAddress(corp.resUserAddr) : null;
  const bizAgeMonths = corp ? calculateBizAgeMonths(corp.resOpenDate, asOf) : null;

  const { labels: industries, codes: industryCodes } = corp
    ? splitIndustryEntries(collectIndustryEntries(corp.resBusinessTypes, corp.resBusinessItems))
    : { labels: [] as string[], codes: [] as string[] };
  const hasIndustry = industries.length > 0 || industryCodes.length > 0;

  const targetType = corp ? resolveTargetType(corp.resBusinessmanType) : null;
  const revenueWon = input.vatBase?.taxBaseWon ?? null;
  const founderAge = calculateAgeYears(input.birthDate8, asOf);
  const name = corp ? corp.resUserNm : null;

  const confidence: Partial<Record<CriterionDimension, number>> = {};
  if (region) confidence.region = CODEF_CONFIRMED_CONFIDENCE;
  if (bizAgeMonths !== null) confidence.biz_age = CODEF_CONFIRMED_CONFIDENCE;
  if (hasIndustry) confidence.industry = CODEF_CONFIRMED_CONFIDENCE;
  if (targetType) confidence.target_type = CODEF_CONFIRMED_CONFIDENCE;
  if (revenueWon !== null) confidence.revenue = CODEF_CONFIRMED_CONFIDENCE;
  if (founderAge !== null) confidence.founder_age = CODEF_FOUNDER_AGE_CONFIDENCE;

  const profile: CompanyProfile = {
    biz_age_months: bizAgeMonths,
    is_preliminary: false,
    industries,
    confidence,
  };
  if (industryCodes.length > 0) profile.industry_codes = industryCodes;
  if (name) profile.name = name;
  if (region) profile.region = region;
  if (targetType) profile.target_types = [targetType];
  if (revenueWon !== null) profile.revenue_krw = revenueWon;
  if (founderAge !== null) profile.founder_age = founderAge;

  return {
    profile,
    facts: {
      has_region: Boolean(region),
      has_biz_age: bizAgeMonths !== null,
      has_industry: hasIndustry,
      has_target_type: Boolean(targetType),
      has_revenue: revenueWon !== null,
      has_founder_age: founderAge !== null,
      masked_identity_no: corp?.resUserIdentiyNo ?? null,
      joint_representative: corp?.resJointRepresentativeNm ?? null,
      gender: input.gender ?? null,
    },
  };
}

/** 업태/종목 텍스트를 개별 항목으로 분해한다('/', ',', '·', '、' 구분). */
function collectIndustryEntries(...fields: Array<string | null>): string[] {
  const entries: string[] = [];
  for (const field of fields) {
    if (!field) continue;
    for (const part of field.split(/[/,·、]/)) {
      const trimmed = part.trim();
      if (trimmed) entries.push(trimmed);
    }
  }
  return entries;
}

/** 사업자종류(법인/개인) → target_type 라벨. */
function resolveTargetType(businessmanType: string | null): string | null {
  if (!businessmanType) return null;
  if (/법인/.test(businessmanType)) return "법인";
  if (/개인/.test(businessmanType)) return "개인사업자";
  return businessmanType;
}

/** 생년월일 8자리(yyyyMMdd)에서 asOf 기준 만나이를 파생한다. 파싱 불가 시 null. */
function calculateAgeYears(birthDate8: string | null | undefined, asOf: Date): number | null {
  const digits = (birthDate8 ?? "").replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  let age = asOf.getUTCFullYear() - year;
  const asOfMonth = asOf.getUTCMonth() + 1;
  const asOfDay = asOf.getUTCDate();
  if (asOfMonth < month || (asOfMonth === month && asOfDay < day)) age -= 1;
  return age >= 0 ? age : null;
}
