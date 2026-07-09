/**
 * 결정론적 프로필 시드 (Apply Experience v2 · ADR-8 트랙 ① / P2-7).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md §4.3(컨펌 규약)·§8 Phase 2 P2-7.
 *
 * `mappedCompanyField` 가 있는 필드에 회사 프로필 값을 `status:"suggested", source:"profile",
 * basis:"사업자 정보"` 로 시드한다(LLM 미경유). **멱등** — 이미 답변이 있는 label 은 불변.
 *
 * 순수 함수다. 호출 배선(필드 로드·프로필 resolve·저장)은 P2b workspace 로더가 담당한다.
 */
import type { CompanyProfile } from "@cunote/contracts";
import {
  type DraftFieldAnswer,
  type DraftFieldAnswers,
  normalizeAnswerLabel,
  normalizeAnswerValue,
} from "./fieldAnswers";

/** 시드 대상 필드의 최소 형태(grant_document_fields 에서 뽑는 부분집합). */
export interface SeedFieldInput {
  label: string;
  mappedCompanyField: string | null;
  fieldId?: string;
}

export const PROFILE_SEED_BASIS = "사업자 정보";

/**
 * `mappedCompanyField` 키 → 회사 프로필 값(문자열) 매핑.
 * buildProfileCopyFields 의 포맷 규약과 일치시킨다(표시 일관성). 값이 없으면 null → 시드 제외.
 * CompanyProfile 에 없는 매핑(representative_name·biz_no 등)은 항상 null.
 */
export function resolveProfileValueForMappedField(
  mappedCompanyField: string,
  profile: CompanyProfile,
): string | null {
  switch (mappedCompanyField) {
    case "name":
      return cleanText(profile.name);
    case "region":
      return cleanText(profile.region?.label ?? profile.region?.code);
    case "industries":
      return cleanText(profile.industries?.join(", "));
    case "revenue":
      return formatKrw(profile.revenue_krw);
    case "employees":
      return profile.employees_count === null || profile.employees_count === undefined
        ? null
        : `${profile.employees_count}명`;
    case "certifications":
      return cleanText([...(profile.certs ?? []), ...(profile.ip ?? [])].join(", "));
    default:
      // representative_name·biz_no 등은 CompanyProfile 에 소스가 없어 결정론 시드 불가.
      return null;
  }
}

/**
 * 프로필 시드 적용(멱등). 기존 답변이 있는 label 은 절대 덮어쓰지 않는다.
 * 프로필 값이 있는 mapped 필드만 `suggested/profile` 로 추가한다.
 */
export function seedProfileFieldAnswers(input: {
  fields: SeedFieldInput[];
  profile: CompanyProfile;
  current: DraftFieldAnswers;
  at?: string;
}): DraftFieldAnswers {
  const at = input.at ?? new Date().toISOString();
  const next: DraftFieldAnswers = { ...input.current };
  for (const field of input.fields) {
    if (!field.mappedCompanyField) continue;
    const label = normalizeAnswerLabel(field.label);
    if (!label) continue;
    if (next[label]) continue; // 멱등: 기존 답변 label 불변
    const resolved = resolveProfileValueForMappedField(field.mappedCompanyField, input.profile);
    if (!resolved) continue;
    const value = normalizeAnswerValue(resolved);
    if (!value) continue;
    const answer: DraftFieldAnswer = {
      value,
      status: "suggested",
      source: "profile",
      suggestedValue: value,
      basis: PROFILE_SEED_BASIS,
      updatedAt: at,
    };
    if (field.fieldId) answer.fieldId = field.fieldId;
    next[label] = answer;
  }
  return next;
}

function cleanText(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.trim();
  return cleaned.length > 0 ? cleaned : null;
}

function formatKrw(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return `${new Intl.NumberFormat("ko-KR").format(value)}원`;
}
