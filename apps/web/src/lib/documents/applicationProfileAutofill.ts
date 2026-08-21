import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import { isReplaceableRhwpGuide } from "@/lib/rhwp/guideText";

export const APPLICATION_PROFILE_KEYS = [
  "applicant_name",
  "applicant_email",
  "applicant_phone",
  "applicant_postal_code",
  "applicant_address",
  "company_name",
  "company_representative_name",
  "company_business_number",
  "company_email",
  "company_phone",
  "company_postal_code",
  "company_address",
] as const;

export type ApplicationProfileKey = typeof APPLICATION_PROFILE_KEYS[number];

export interface ApplicationAutofillProfile {
  personal: {
    fullName: string | null;
    applicationEmail: string | null;
    phone: string | null;
    postalCode: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
  };
  company: {
    name: string | null;
    representativeName: string | null;
    businessNumber: string | null;
    businessNumberVerified: boolean;
    applicationEmail: string | null;
    phone: string | null;
    postalCode: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
  };
  updatedAt: string | null;
}

export interface ApplicationAutofillProfileInput {
  personal: {
    fullName: string | null;
    applicationEmail: string | null;
    phone: string | null;
    postalCode: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
  };
  company: {
    name: string | null;
    representativeName: string | null;
    businessNumber: string | null;
    applicationEmail: string | null;
    phone: string | null;
    postalCode: string | null;
    addressLine1: string | null;
    addressLine2: string | null;
  };
}

export interface ApplicationAutofillFieldBinding {
  fieldId: string;
  status: "unique" | "missing" | "ambiguous" | "resolving";
  beforeText?: string;
}

export type ApplicationAutofillPlanState =
  | "ready"
  | "missing_profile"
  | "already_filled"
  | "blocked";

export interface ApplicationAutofillPlanItem {
  fieldId: string;
  fieldKey: string;
  label: string;
  profileKey: ApplicationProfileKey | null;
  value: string | null;
  state: ApplicationAutofillPlanState;
  reason: string | null;
}

export interface ApplicationAutofillPlan {
  items: ApplicationAutofillPlanItem[];
  ready: ApplicationAutofillPlanItem[];
  missingProfileKeys: ApplicationProfileKey[];
}

const SENSITIVE_OR_MANUAL = /(주민(?:등록)?번호|외국인등록번호|여권번호|서명|직인|도장|계좌|비밀번호|인증번호|동의|날인)/u;
const THIRD_PARTY = /(홍보물제작기업|외주|협력|수행기관|용역사|공급업체|추천인|보증인)/u;
const COMPANY_CONTEXT = /(회사|기업|사업장|법인|업체)/u;
const APPLICANT_CONTEXT = /(신청인|신청자|대표자|개인|자택|거주)/u;

/**
 * 필드 의미는 분석된 canonical key와 검수된 mappedCompanyField를 우선 사용한다.
 * label은 개인/회사 연락처처럼 기존 분석기가 canonical key를 만들지 못한 좁은 경우에만
 * 보조 신호로 사용하며, 제3자·민감정보는 항상 fail-closed한다.
 */
export function resolveApplicationProfileKey(
  field: Pick<ConnectedDocumentField, "fieldKey" | "label" | "mappedCompanyField">,
): ApplicationProfileKey | null {
  const label = normalizeLabel(field.label);
  if (!label || SENSITIVE_OR_MANUAL.test(label) || THIRD_PARTY.test(label)) return null;

  const mapped = normalizeKey(field.mappedCompanyField ?? "");
  if (mapped === "name") return "company_name";
  if (mapped === "biz_no" || mapped === "business_number") return "company_business_number";
  if (mapped === "representative_name") return "company_representative_name";

  const key = stripOccurrenceSuffix(normalizeKey(field.fieldKey));
  if (matchesKey(key, ["company_name", "company.name", "company", "기업명", "회사명", "상호", "법인명"])) {
    return "company_name";
  }
  if (matchesKey(key, ["biz_reg_no", "biz_no", "business_number", "company.biz_no", "사업자등록번호", "사업자번호"])) {
    return "company_business_number";
  }
  if (matchesKey(key, ["ceo_name", "representative_name", "company.representative_name", "대표자명", "대표자성명"])) {
    return "company_representative_name";
  }
  if (matchesKey(key, ["applicant_name", "applicant.name", "full_name", "성명", "신청인성명", "신청자성명"])) {
    return "applicant_name";
  }

  if (/(우편번호|postal_?code)/iu.test(`${key} ${label}`)) {
    return COMPANY_CONTEXT.test(label) && !APPLICANT_CONTEXT.test(label)
      ? "company_postal_code"
      : "applicant_postal_code";
  }
  if (/(이메일|전자우편|e_?mail|email)/iu.test(`${key} ${label}`)) {
    return COMPANY_CONTEXT.test(label) && !APPLICANT_CONTEXT.test(label)
      ? "company_email"
      : "applicant_email";
  }
  if (/(전화|연락처|휴대전화|핸드폰|mobile|phone|tel)/iu.test(`${key} ${label}`)) {
    return COMPANY_CONTEXT.test(label) && !APPLICANT_CONTEXT.test(label)
      ? "company_phone"
      : "applicant_phone";
  }
  if (key === "address" || /(주소|소재지|address)/iu.test(`${key} ${label}`)) {
    return APPLICANT_CONTEXT.test(label) && !COMPANY_CONTEXT.test(label)
      ? "applicant_address"
      : "company_address";
  }
  return null;
}

export function applicationProfileValue(
  profile: ApplicationAutofillProfile,
  key: ApplicationProfileKey,
): string | null {
  switch (key) {
    case "applicant_name": return clean(profile.personal.fullName);
    case "applicant_email": return clean(profile.personal.applicationEmail);
    case "applicant_phone": return clean(profile.personal.phone);
    case "applicant_postal_code": return clean(profile.personal.postalCode);
    case "applicant_address": return joinAddress(profile.personal.addressLine1, profile.personal.addressLine2);
    case "company_name": return clean(profile.company.name);
    case "company_representative_name": return clean(profile.company.representativeName);
    case "company_business_number": return formatBusinessNumber(profile.company.businessNumber);
    case "company_email": return clean(profile.company.applicationEmail);
    case "company_phone": return clean(profile.company.phone);
    case "company_postal_code": return clean(profile.company.postalCode);
    case "company_address": return joinAddress(profile.company.addressLine1, profile.company.addressLine2);
  }
}

export function buildApplicationProfileAutofillPlan(input: {
  fields: readonly ConnectedDocumentField[];
  profile: ApplicationAutofillProfile;
  bindings: readonly ApplicationAutofillFieldBinding[];
}): ApplicationAutofillPlan {
  const bindings = new Map(input.bindings.map((binding) => [binding.fieldId, binding]));
  const items = input.fields.map((field): ApplicationAutofillPlanItem => {
    const profileKey = resolveApplicationProfileKey(field);
    if (!profileKey) return planItem(field, null, null, "blocked", "자동 입력이 허용된 등록정보 필드가 아닙니다.");
    const binding = bindings.get(field.fieldId);
    if (!binding || binding.status === "resolving") {
      return planItem(field, profileKey, null, "blocked", "현재 문서에서 입력 위치를 확인 중입니다.");
    }
    if (binding.status === "missing") {
      return planItem(field, profileKey, null, "blocked", "현재 문서에서 입력 위치를 확인하지 못했습니다.");
    }
    if (binding.status === "ambiguous") {
      return planItem(field, profileKey, null, "blocked", "입력 위치 후보가 여러 곳이라 자동 입력에서 제외했습니다.");
    }
    const value = applicationProfileValue(input.profile, profileKey);
    if (!value) return planItem(field, profileKey, null, "missing_profile", "저장된 등록정보가 없습니다.");
    const beforeText = binding.beforeText?.trim() ?? "";
    if (
      beforeText
      && !isReplaceableRhwpGuide(beforeText, field.sourceSpan, null)
    ) {
      return planItem(field, profileKey, value, "already_filled", "현재 값이 있어 덮어쓰지 않습니다.");
    }
    return planItem(field, profileKey, value, "ready", null);
  });
  const missingProfileKeys = [...new Set(items.flatMap((item) => (
    item.state === "missing_profile" && item.profileKey ? [item.profileKey] : []
  )))];
  return {
    items,
    ready: items.filter((item) => item.state === "ready"),
    missingProfileKeys,
  };
}

function planItem(
  field: Pick<ConnectedDocumentField, "fieldId" | "fieldKey" | "label">,
  profileKey: ApplicationProfileKey | null,
  value: string | null,
  state: ApplicationAutofillPlanState,
  reason: string | null,
): ApplicationAutofillPlanItem {
  return { fieldId: field.fieldId, fieldKey: field.fieldKey, label: field.label, profileKey, value, state, reason };
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").trim();
}

function normalizeKey(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("ko-KR");
}

function stripOccurrenceSuffix(value: string): string {
  return value.replace(/-\d+$/u, "");
}

function matchesKey(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value === normalizeKey(candidate));
}

function clean(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.normalize("NFKC").replace(/[\t\r\n]+/gu, " ").replace(/\s+/gu, " ").trim();
  return normalized || null;
}

function joinAddress(line1: string | null, line2: string | null): string | null {
  return clean([clean(line1), clean(line2)].filter(Boolean).join(" "));
}

function formatBusinessNumber(value: string | null): string | null {
  if (!value) return null;
  const digits = value.replace(/\D/gu, "");
  if (digits.length !== 10) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5)}`;
}
