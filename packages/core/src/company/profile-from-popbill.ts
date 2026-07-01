import type { CompanyProfile, CriterionDimension } from "@cunote/contracts";
import { REGION_CODES, REGION_LABELS } from "../kstartup/constants.js";
import { maskCorpNum } from "../popbill/corp-num.js";
import type { PopbillBizCheckInfo } from "../popbill/types.js";

export interface PopbillCompanyProfileResult {
  profile: CompanyProfile;
  facts: {
    masked_biz_no: string | null;
    result: number | string | null;
    result_message: string | null;
    check_dt: string | null;
    has_corp_name: boolean;
    has_region: boolean;
    has_biz_age: boolean;
    has_size: boolean;
    has_industry: boolean;
    close_down_state: string | number | null;
    close_down_tax_type: string | number | null;
  };
}

export function buildCompanyProfileFromPopbill(
  info: PopbillBizCheckInfo,
  options: { asOf?: Date } = {},
): PopbillCompanyProfileResult {
  const asOf = options.asOf ?? new Date();
  const region = resolveRegionFromAddress(info.addr);
  const bizAgeMonths = calculateBizAgeMonths(info.establishDate, asOf);
  const size = resolveCompanySize(info.corpScaleCode);
  const industries = unique([
    clean(info.industryCode),
    clean(info.bizClass),
    clean(info.bizType),
  ].filter(Boolean));
  const confidence: Partial<Record<CriterionDimension, number>> = {};
  if (region) confidence.region = 0.8;
  if (bizAgeMonths !== null) confidence.biz_age = 0.75;
  if (size) confidence.size = 0.65;
  if (industries.length > 0) confidence.industry = 0.6;
  if (info.closeDownState !== undefined || info.closeDownTaxType !== undefined) {
    confidence.business_status = 0.8;
  }
  const businessStatus = resolveBusinessStatus(info.closeDownState, info.closeDownTaxType);

  const profile: CompanyProfile = {
    biz_age_months: bizAgeMonths,
    is_preliminary: false,
    industries,
    size,
    confidence,
  };
  if (info.corpNum) profile.id = `popbill:${maskCorpNum(info.corpNum)}`;
  const name = clean(info.corpName);
  if (name) profile.name = name;
  if (region) profile.region = region;
  if (businessStatus) profile.business_status = businessStatus;

  return {
    profile,
    facts: {
      masked_biz_no: info.corpNum ? maskCorpNum(info.corpNum) : null,
      result: info.result ?? null,
      result_message: clean(info.resultMessage) || null,
      check_dt: clean(info.checkDT) || null,
      has_corp_name: Boolean(clean(info.corpName)),
      has_region: Boolean(region),
      has_biz_age: bizAgeMonths !== null,
      has_size: Boolean(size),
      has_industry: industries.length > 0,
      close_down_state: info.closeDownState ?? null,
      close_down_tax_type: info.closeDownTaxType ?? null,
    },
  };
}

function resolveBusinessStatus(
  closeDownState: string | number | null | undefined,
  closeDownTaxType: string | number | null | undefined,
): CompanyProfile["business_status"] | null {
  if (closeDownState === undefined && closeDownTaxType === undefined) return null;
  const state = closeDownState ?? null;
  const active = String(state) === "1";
  return {
    active,
    close_down_state: state,
    close_down_tax_type: closeDownTaxType ?? null,
    label: active ? "정상" : "휴폐업 확인 필요",
  };
}

export function resolveCompanySize(value: string | number | null | undefined): string | null {
  const text = clean(String(value ?? ""));
  if (!text) return null;
  if (["10", "11"].includes(text) || /대기업/.test(text)) return "대기업";
  if (["20", "21"].includes(text) || /중견/.test(text)) return "중견기업";
  if (text === "30" || /중소/.test(text)) return "중소기업";
  if (/소상공인/.test(text)) return "소상공인";
  if (/소기업/.test(text)) return "소기업";
  return text;
}

export function resolveRegionFromAddress(
  address: string | null | undefined,
): { code: string; label: string } | null {
  const text = clean(address);
  if (!text) return null;
  const normalized = text.replace(/\s+/g, " ");
  for (const [label, code] of Object.entries(REGION_CODES)) {
    if (normalized.startsWith(label)) return { code, label };
  }

  const aliases: Array<[RegExp, string]> = [
    [/^서울특별시/, "11"],
    [/^부산광역시/, "26"],
    [/^대구광역시/, "27"],
    [/^인천광역시/, "28"],
    [/^광주광역시/, "29"],
    [/^대전광역시/, "30"],
    [/^울산광역시/, "31"],
    [/^세종특별자치시/, "36"],
    [/^경기도/, "41"],
    [/^강원(?:특별자치도|도)/, "42"],
    [/^충청북도/, "43"],
    [/^충북/, "43"],
    [/^충청남도/, "44"],
    [/^충남/, "44"],
    [/^전북(?:특별자치도)?/, "45"],
    [/^전라북도/, "45"],
    [/^전남/, "46"],
    [/^전라남도/, "46"],
    [/^경북/, "47"],
    [/^경상북도/, "47"],
    [/^경남/, "48"],
    [/^경상남도/, "48"],
    [/^제주(?:특별자치도|도)/, "50"],
  ];
  const hit = aliases.find(([pattern]) => pattern.test(normalized));
  if (!hit) return null;
  const code = hit[1];
  return { code, label: REGION_LABELS[code] ?? code };
}

export function calculateBizAgeMonths(
  establishDate: string | null | undefined,
  asOf: Date,
): number | null {
  const date = parseYmd(establishDate);
  if (!date) return null;
  let months = (asOf.getUTCFullYear() - date.getUTCFullYear()) * 12;
  months += asOf.getUTCMonth() - date.getUTCMonth();
  if (asOf.getUTCDate() < date.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

function parseYmd(value: string | null | undefined): Date | null {
  const digits = clean(value).replace(/\D/g, "");
  if (!/^\d{8}$/.test(digits)) return null;
  const year = Number(digits.slice(0, 4));
  const month = Number(digits.slice(4, 6));
  const day = Number(digits.slice(6, 8));
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
