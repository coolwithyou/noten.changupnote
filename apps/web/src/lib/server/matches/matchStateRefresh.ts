import type { CompanyProfile, CriterionConfirmation, NormalizedGrant } from "@cunote/contracts";
import {
  planMatchStateRefresh,
  type MatchStateRefreshPlan,
  type ServiceRepositories,
} from "@cunote/core";

export interface RefreshMatchStatesInput<TPayload = unknown> {
  repositories: ServiceRepositories<TPayload>;
  companyId: string;
  company: CompanyProfile;
  grants: Array<NormalizedGrant<TPayload>>;
  asOf: Date;
  write: boolean;
}

export interface RefreshMatchStatesResult {
  plan: MatchStateRefreshPlan;
  savedCount: number;
}

export async function refreshMatchStates<TPayload>({
  repositories,
  companyId,
  company,
  grants,
  asOf,
  write,
}: RefreshMatchStatesInput<TPayload>): Promise<RefreshMatchStatesResult> {
  // (company, grant) 자가신고 확인 답변(확인 루프 Phase B)을 배치 로드해 엔진 입력에 싣는다.
  // 리포지토리가 미구현이거나 답변이 없으면 undefined — 엔진은 기존 동작과 완전히 동일하다.
  const confirmationsByGrantId = await loadCriterionConfirmations({ repositories, companyId, grants });
  const plan = planMatchStateRefresh({
    company,
    grants,
    asOf,
    companyId,
    ...(confirmationsByGrantId ? { confirmationsByGrantId } : {}),
  });

  if (!write) {
    return { plan, savedCount: 0 };
  }

  await Promise.all(plan.states.map((state) => repositories.matches.saveMatchState({
    companyId,
    grantId: state.grantId,
    match: state.match,
    eligibleFrom: parsePlanDate(state.eligibleFrom),
    eligibleUntil: parsePlanDate(state.eligibleUntil),
  })));

  return { plan, savedCount: plan.states.length };
}

export async function loadCriterionConfirmations<TPayload>(input: {
  repositories: ServiceRepositories<TPayload>;
  companyId: string;
  grants: Array<NormalizedGrant<TPayload>>;
}): Promise<ReadonlyMap<string, CriterionConfirmation[]> | undefined> {
  const listCriterionConfirmations =
    input.repositories.matches.listCriterionConfirmations?.bind(input.repositories.matches);
  if (!listCriterionConfirmations) return undefined;
  // grantKey는 grant.id가 있으면 id를 쓴다. DB id가 없는 공고(샘플 경로)는 확인 답변도 있을 수 없어 제외.
  const grantIds = input.grants
    .map((entry) => entry.grant.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (grantIds.length === 0) return undefined;
  const confirmations = await listCriterionConfirmations({ companyId: input.companyId, grantIds });
  return confirmations.size > 0 ? confirmations : undefined;
}

function parsePlanDate(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
