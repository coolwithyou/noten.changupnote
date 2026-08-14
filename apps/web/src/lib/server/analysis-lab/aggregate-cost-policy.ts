interface ReviewedRunCostInput {
  /** 기록 이전 런(undefined)은 legacy API로 해석한다. */
  transport?: "api" | "claude-cli";
  costUsd: number | null;
}

interface ReviewedRunCostLaneSummary {
  runCount: number;
  costSampleCount: number;
  totalUsd: number;
  averageUsd: number | null;
}

interface ReviewedRunApiCostGate {
  actualUsd: number;
  maxUsd: number;
  pass: boolean;
}

interface ReviewedRunCostSummary {
  api: ReviewedRunCostLaneSummary;
  subscription: ReviewedRunCostLaneSummary;
  apiCostGate: ReviewedRunApiCostGate | null;
}

function summarizeLane(runs: readonly ReviewedRunCostInput[]): ReviewedRunCostLaneSummary {
  const costs = runs
    .map((run) => run.costUsd)
    .filter((cost): cost is number => cost !== null);
  const totalUsd = costs.reduce((sum, cost) => sum + cost, 0);
  return {
    runCount: runs.length,
    costSampleCount: costs.length,
    totalUsd,
    averageUsd: costs.length > 0 ? totalUsd / costs.length : null,
  };
}

export function summarizeReviewedRunCosts(
  runs: readonly ReviewedRunCostInput[],
  apiMaxCostPerNoticeUsd: number,
): ReviewedRunCostSummary {
  const apiRuns = runs.filter((run) => run.transport !== "claude-cli");
  const subscriptionRuns = runs.filter((run) => run.transport === "claude-cli");
  const api = summarizeLane(apiRuns);
  return {
    api,
    subscription: summarizeLane(subscriptionRuns),
    apiCostGate: api.runCount > 0
      ? {
          // 기존 aggregate는 비용 표본이 없으면 0으로 계산했다. transport 분리에서도
          // 그 API legacy semantics를 유지하고, 별도 fail-closed 정책은 도입하지 않는다.
          actualUsd: api.averageUsd ?? 0,
          maxUsd: apiMaxCostPerNoticeUsd,
          pass: (api.averageUsd ?? 0) <= apiMaxCostPerNoticeUsd,
        }
      : null,
  };
}
