import { createHash } from "node:crypto";
import type { CompanyProfile } from "@cunote/contracts";

export class CompanyProfileConflictError extends Error {
  readonly status = 409;
  readonly code = "company_profile_conflict";
  constructor() {
    super("다른 화면에서 사업자 정보가 변경됐어요. 입력값을 확인한 뒤 새로고침하여 다시 반영해주세요.");
  }
}

/** 객체 키 순서는 버전이 아니다. 0/없음/모름/출처/시각의 변경은 버전을 바꾼다. */
export function companyProfileRevision(profile: unknown): string {
  return createHash("sha256").update(JSON.stringify(profile, (_key, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")));
    }
    return value;
  })).digest("hex");
}

export function assertCompanyProfileUnchanged(current: CompanyProfile, expected?: CompanyProfile | string): void {
  if (expected === undefined) return;
  const revision = typeof expected === "string" ? expected : companyProfileRevision(expected);
  if (companyProfileRevision(current) !== revision) throw new CompanyProfileConflictError();
}

/** 조회기가 보충하는 추적용 ID는 제외하고 원시 사실·범위·출처·확인 시각은 모두 결속한다. */
export function matchingProfileRevision(profile: CompanyProfile): string {
  const evidence = profile.profile_evidence
    ? Object.fromEntries(Object.entries(profile.profile_evidence).filter(([dimension, observation]) => {
        // 정확한 수치가 없는 구간 답변은 resolver가 사실 observation으로 만들지 않는다.
        // min/max/unit/출처/답변 시각은 아래 question_answer_state 원문으로 이미 결속된다.
        return !(observation?.provider === "cunote_profile_question_range" &&
          ((dimension === "revenue" && profile.revenue_krw == null) || (dimension === "employees" && profile.employees_count == null)));
      }).map(([dimension, observation]) => [
        dimension,
        observation ? Object.fromEntries(Object.entries(observation).filter(([key]) =>
          !["canonicalValue", "observationId", "observationVersion", "resolverVersion"].includes(key))) : observation,
      ]))
    : undefined;
  return companyProfileRevision({ ...profile, profile_evidence: evidence && Object.keys(evidence).length ? evidence : undefined });
}
