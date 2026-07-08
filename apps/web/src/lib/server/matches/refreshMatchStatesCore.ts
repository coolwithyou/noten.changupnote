// 매치 상태(match_state) 갱신 코어. 회사 프로필 + 활성 공고를 읽어 적격성·적합도를 재계산하고,
// write 이면 match_state 행을 저장한다.
//
// 이 모듈은 순수 코어다: argv/env 파싱과 loadMonorepoEnv, db 생성은 호출부(CLI · API 라우트)의 책임이며,
// 여기서는 process.env 가 이미 주입돼 있다고 가정한다.
// CLI 는 refresh-match-states-cli.ts, 서버 라우트는 /api/cron/grant-cycle-post 가 이 함수를 호출한다.
import type { CunoteDb } from "../db/client";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { refreshMatchStates } from "./matchStateRefresh";

export interface RunRefreshMatchStatesInput {
  db: CunoteDb;
  companyId: string;
  userId: string;
  limit: number;
  asOf: Date;
  write: boolean;
}

export async function runRefreshMatchStates(
  input: RunRefreshMatchStatesInput,
): Promise<Record<string, unknown>> {
  const repositories = createDrizzleRepositories<unknown>({
    dialect: "drizzle",
    client: input.db,
  });
  const company = await repositories.companies.resolveCompanyProfile({
    companyId: input.companyId,
    userId: input.userId,
  });
  if (!company) throw new Error(`회사 프로필을 찾지 못했습니다: ${input.companyId}`);

  const grants = await repositories.grants.listActiveGrants({ limit: input.limit, asOf: input.asOf });
  const { plan, savedCount } = await refreshMatchStates({
    repositories,
    company,
    grants,
    asOf: input.asOf,
    companyId: input.companyId,
    userId: input.userId,
    write: input.write,
  });

  return {
    dryRun: !input.write,
    savedCount,
    companyId: input.companyId,
    userId: input.userId,
    limit: input.limit,
    asOf: plan.asOf,
    grantCount: plan.grantCount,
    counts: plan.counts,
    transitionWindowCounts: plan.transitionWindowCounts,
    states: plan.states.map((state) => ({
      grantId: state.grantId,
      source: state.source,
      sourceId: state.sourceId,
      eligibility: state.eligibility,
      fitScore: state.fitScore,
      eligibleFrom: state.eligibleFrom,
      eligibleUntil: state.eligibleUntil,
      rulesetVer: state.rulesetVer,
      scoringVer: state.scoringVer,
    })),
  };
}
