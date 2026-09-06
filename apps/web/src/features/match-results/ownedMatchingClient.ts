import type { ActionResult, MatchingProfileAnswerRequest, OwnedCompanyMatchingResult } from "@cunote/contracts";
import { TeaserError } from "./logic";

export async function loadOwnedMatching(companyId?: string): Promise<OwnedCompanyMatchingResult> {
  const query = companyId === undefined ? "" : `?${new URLSearchParams({ companyId })}`;
  const response = await fetch(`/api/web/company-matching${query}`, {
    cache: "no-store", signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json() as ActionResult<OwnedCompanyMatchingResult>;
  if (!response.ok || !payload.ok || !payload.data) {
    throw new TeaserError(payload.error?.message ?? "저장된 정보를 불러오지 못했어요.", payload.error?.code ?? null);
  }
  assertCompany(payload.data, companyId);
  return payload.data;
}

export async function saveOwnedMatchingAnswer(companyId: string, answer: MatchingProfileAnswerRequest, expectedProfileRevision?: string): Promise<OwnedCompanyMatchingResult> {
  const response = await fetch("/api/web/profile/field", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...answer, companyId, ...(expectedProfileRevision ? { expectedProfileRevision } : {}) }), signal: AbortSignal.timeout(20_000),
  });
  const payload = await response.json() as ActionResult<{ matching: OwnedCompanyMatchingResult }>;
  if (!response.ok || !payload.ok || !payload.data?.matching) {
    throw new TeaserError(payload.error?.message ?? "답변을 저장하지 못했어요.", payload.error?.code ?? null);
  }
  assertCompany(payload.data.matching, companyId);
  return payload.data.matching;
}

function assertCompany(result: OwnedCompanyMatchingResult, expected?: string) {
  if (!result.companyId || (expected !== undefined && expected !== result.companyId)) {
    throw new TeaserError("요청한 회사와 응답이 달라 정보를 반영하지 않았어요. 새로고침해주세요.", "company_scope_mismatch");
  }
}
