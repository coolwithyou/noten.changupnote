/**
 * 결정론적 프로필 시드 (Apply Experience v2 · ADR-8 트랙 ① / P2-7).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md §4.3(컨펌 규약)·§8 Phase 2 P2-7.
 *
 * `mappedCompanyField` 가 있는 필드에 회사 프로필 값을 `status:"suggested", source:"profile",
 * basis:"사업자 정보"` 로 시드한다(LLM 미경유). 기존 사용자 결정은 불변으로 두고, 위치가
 * 유일하게 확정된 미승인 template/profile 시드만 현재 fieldId에 결속한다.
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

/** CompanyProfile 밖에 보관되는 회사 식별정보 중 지원서에 안전하게 복사할 값. */
export interface CompanyIdentitySeed {
  businessNumber?: string | null;
}

export const PROFILE_SEED_BASIS = "사업자 정보";

/**
 * `mappedCompanyField` 키 → 회사 프로필 값(문자열) 매핑.
 * buildProfileCopyFields 의 포맷 규약과 일치시킨다(표시 일관성). 값이 없으면 null → 시드 제외.
 * CompanyProfile 에 없는 매핑은 identity 에서만 해소한다. 알 수 없는 값은 null.
 */
export function resolveProfileValueForMappedField(
  mappedCompanyField: string,
  profile: CompanyProfile,
  identity: CompanyIdentitySeed = {},
): string | null {
  switch (mappedCompanyField) {
    case "name":
      return cleanText(profile.name);
    case "region":
      return cleanText(profile.region?.label ?? profile.region?.code);
    case "industries":
      return cleanText(profile.industries?.join(", "));
    case "size":
      return cleanText(profile.size);
    case "revenue":
      return formatKrw(profile.revenue_krw);
    case "employees":
      return profile.employees_count === null || profile.employees_count === undefined
        ? null
        : `${profile.employees_count}명`;
    case "certifications":
      return cleanText([...(profile.certs ?? []), ...(profile.ip ?? [])].join(", "));
    case "target_types":
      return cleanText(profile.target_types?.join(", "));
    case "biz_no":
      return formatBusinessNumber(identity.businessNumber);
    default:
      // representative_name 등은 현재 신뢰 가능한 정본이 없어 결정론 시드 불가.
      return null;
  }
}

/**
 * 프로필 시드 적용(멱등). 프로필 값이 있는 mapped 필드만 `suggested/profile` 로 추가한다.
 * 기존 답변은 유일한 label의 미승인 template 값 또는 같은 profile 값에 fieldId를 결속할 때만
 * 갱신한다. accepted/edited/dismissed 및 user/llm 출처는 그대로 보존한다.
 */
export function seedProfileFieldAnswers(input: {
  fields: SeedFieldInput[];
  profile: CompanyProfile;
  identity?: CompanyIdentitySeed;
  current: DraftFieldAnswers;
  at?: string;
}): DraftFieldAnswers {
  const at = input.at ?? new Date().toISOString();
  let next = input.current;
  const normalizedLabelCounts = new Map<string, number>();
  for (const field of input.fields) {
    const identity = normalizedSeedLabelIdentity(field.label);
    if (identity) normalizedLabelCounts.set(identity, (normalizedLabelCounts.get(identity) ?? 0) + 1);
  }
  for (const field of input.fields) {
    if (!field.mappedCompanyField) continue;
    const label = normalizeAnswerLabel(field.label);
    if (!label) continue;
    const labelIdentity = normalizedSeedLabelIdentity(label);
    if (normalizedLabelCounts.get(labelIdentity) !== 1) continue;
    const resolved = resolveProfileValueForMappedField(
      field.mappedCompanyField,
      input.profile,
      input.identity,
    );
    if (!resolved) continue;
    const value = normalizeAnswerValue(resolved);
    if (!value) continue;
    const existing = next[label];
    if (existing) {
      const canRebindUnapprovedTemplate = existing.status === "suggested"
        && existing.source === "template"
        && Boolean(field.fieldId);
      const canBindMatchingProfileSeed = existing.status === "suggested"
        && existing.source === "profile"
        && existing.value === value
        && !existing.fieldId
        && Boolean(field.fieldId);
      if (!canRebindUnapprovedTemplate && !canBindMatchingProfileSeed) continue;
    }
    const answer: DraftFieldAnswer = {
      value,
      status: "suggested",
      source: "profile",
      suggestedValue: value,
      basis: PROFILE_SEED_BASIS,
      updatedAt: at,
    };
    if (field.fieldId) answer.fieldId = field.fieldId;
    if (next === input.current) next = { ...input.current };
    next[label] = answer;
  }
  return next;
}

function normalizedSeedLabelIdentity(value: string): string {
  return normalizeAnswerLabel(value).normalize("NFKC").replace(/\s+/gu, "");
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

function formatBusinessNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\D/g, "");
  if (normalized.length !== 10) return null;
  return `${normalized.slice(0, 3)}-${normalized.slice(3, 5)}-${normalized.slice(5)}`;
}
