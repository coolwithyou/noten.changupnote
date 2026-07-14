// 매치 상태(match_state) 갱신 코어. 회사 프로필 + 활성 공고를 읽어 적격성·조건 확인도를 재계산하고,
// write 이면 match_state 행을 저장한다.
//
// 이 모듈은 순수 코어다: argv/env 파싱과 loadMonorepoEnv, db 생성은 호출부(CLI · API 라우트)의 책임이며,
// 여기서는 process.env 가 이미 주입돼 있다고 가정한다.
// CLI 는 refresh-match-states-cli.ts, 서버 라우트는 /api/cron/grant-cycle-post 가 이 함수를 호출한다.
import type { CunoteDb } from "../db/client";
import { planProfileQuestions, resolveGrantExtractionManifest } from "@cunote/core";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { resolveSystemProductCompanyProfile } from "../productProfile/resolveProductCompanyProfile";
import { refreshMatchStates } from "./matchStateRefresh";

export interface RunRefreshMatchStatesInput {
  db: CunoteDb;
  companyId: string;
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
  const resolution = await resolveSystemProductCompanyProfile({
    companyId: input.companyId,
    asOf: input.asOf.toISOString(),
  }, {
    companies: repositories.companies,
    enrichmentCache: repositories.enrichmentCache,
  });

  const grants = await repositories.grants.listActiveGrants({ limit: input.limit, asOf: input.asOf });
  const { plan, savedCount } = await refreshMatchStates({
    repositories,
    company: resolution.profile,
    grants,
    asOf: input.asOf,
    companyId: input.companyId,
    write: input.write,
  });
  const recommendationTierCounts = histogram(plan.states.map((state) =>
    state.match.review_gate?.tier ?? "unknown"));
  const extractionReadinessCounts = histogram(plan.states.map((state) =>
    state.match.quality.extractionReadiness));
  const eligibilityConfidenceCounts = histogram(plan.states.map((state) =>
    state.match.quality.eligibilityConfidence));
  const extractionManifests = grants.map((grant) => resolveGrantExtractionManifest(grant));
  const extractionWarningCounts = histogram(extractionManifests.flatMap((manifest) => manifest.warnings));
  const extractionAttachmentStatusCounts = histogram(grants.flatMap((grant) =>
    (grant.raw.attachments ?? []).map((attachment) => attachment.conversion?.status ?? "pending")));
  const hardFailDimensions = histogram(plan.states.flatMap((state) =>
    state.match.rule_trace
      .filter((trace) =>
        trace.result === "fail" && (trace.kind === "required" || trace.kind === "exclusion"))
      .map((trace) => trace.dimension)));
  const questionPlan = !input.write
    ? planProfileQuestions(grants.map((item, index) => ({
        item,
        match: plan.states[index]!.match,
      })), { asOf: input.asOf, limit: 3 })
    : [];

  return {
    dryRun: !input.write,
    savedCount,
    companyId: input.companyId,
    stateScope: resolution.stateScope,
    limit: input.limit,
    asOf: plan.asOf,
    grantCount: plan.grantCount,
    counts: plan.counts,
    recommendationTierCounts,
    extractionReadinessCounts,
    extractionWarningCounts,
    extractionAttachmentStatusCounts,
    eligibilityConfidenceCounts,
    hardFailDimensions,
    averageVerificationCompleteness: average(plan.states.map((state) =>
      state.match.quality.verificationCompleteness)),
    averageEvidenceCoverage: average(plan.states.map((state) =>
      state.match.quality.evidenceCoverage)),
    ...(!input.write ? {
      profileQuestionPlan: questionPlan.map((item) => ({
        dimension: item.question.dimension,
        prompt: item.question.prompt,
        inputType: item.question.inputType,
        affectedGrantCount: item.question.affectedGrantCount,
        resolvesGrantCount: item.resolvesGrantCount,
        score: item.score,
        effort: item.effort,
      })),
      extractionIncompleteSamples: extractionManifests
        .filter((manifest) => manifest.readiness === "partial" || manifest.readiness === "unstructured")
        .slice(0, 10)
        .map((manifest) => ({
          grantId: manifest.grantId,
          readiness: manifest.readiness,
          warnings: manifest.warnings,
          attachmentsExpected: manifest.attachmentsExpected,
          attachmentsFetched: manifest.attachmentsFetched,
          attachmentsConverted: manifest.attachmentsConverted,
        })),
      hardFailSamples: plan.states
        .map((state) => ({
          source: state.source,
          sourceId: state.sourceId,
          failures: state.match.rule_trace
            .filter((trace) =>
              trace.result === "fail" && (trace.kind === "required" || trace.kind === "exclusion"))
            .map((trace) => ({ dimension: trace.dimension, message: trace.message })),
        }))
        .filter((sample) => sample.failures.length > 0)
        .slice(0, 10),
    } : {}),
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

function histogram(values: string[]): Record<string, number> {
  return Object.fromEntries([...values.reduce((counts, value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()).entries()].sort((left, right) =>
    right[1] - left[1] || left[0].localeCompare(right[0])));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}
