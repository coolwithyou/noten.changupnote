import { randomUUID } from "node:crypto";
import type { CreditSystemRepository } from "@cunote/core";
import type { ProductTeaserResult } from "@cunote/contracts";

export const LANDING_MATCH_OBSERVATION_SCHEMA =
  "landing-match-observation-v1" as const;
export const LANDING_MATCH_OBSERVATION_FEATURE =
  "landing_match_observation" as const;

export interface LandingMatchObservationContext {
  schema: typeof LANDING_MATCH_OBSERVATION_SCHEMA;
  surface: "anonymous_teaser";
  observedAt: string;
  evaluatedGrantCount: number;
  returnedGrantCount: number;
  matches: Array<{
    grantId: string;
    rank: number;
    eligibility: string;
    bucket: string;
    recommendationTier: string | null;
    verificationCompleteness: number;
    evidenceCoverage: number | null;
    matchConfidence: number;
    relevanceScore: number | null;
    priorityScore: number | null;
    rulesetVer: string;
    scoringVer: string;
  }>;
}

/**
 * 랜딩 응답에 실제로 노출한 공고 판정만 최소 스냅샷으로 남긴다.
 * 사업자번호·회사 프로필·rule trace 원문은 저장하지 않는다.
 */
export function buildLandingMatchObservationContext(
  result: ProductTeaserResult,
  observedAt = new Date(),
): LandingMatchObservationContext {
  return {
    schema: LANDING_MATCH_OBSERVATION_SCHEMA,
    surface: "anonymous_teaser",
    observedAt: observedAt.toISOString(),
    evaluatedGrantCount: result.searchContext?.evaluatedGrantCount ?? 0,
    returnedGrantCount: result.matches.length,
    matches: result.matches.map((match, index) => ({
      grantId: match.grantId,
      rank: index + 1,
      eligibility: match.eligibility,
      bucket: match.bucket,
      recommendationTier: match.recommendationTier ?? null,
      verificationCompleteness:
        match.quality?.verificationCompleteness ?? match.fitScore,
      evidenceCoverage: match.quality?.evidenceCoverage ?? null,
      matchConfidence: match.matchConfidence,
      relevanceScore: match.ranking?.relevanceScore ?? null,
      priorityScore: match.ranking?.priorityScore ?? null,
      rulesetVer: match.rulesetVer,
      scoringVer: match.scoringVer,
    })),
  };
}

export async function recordLandingMatchObservation(input: {
  creditsSystem: CreditSystemRepository;
  result: ProductTeaserResult;
  observedAt?: Date;
}): Promise<{ id: string; requestId: string }> {
  const requestId = randomUUID();
  const created = await input.creditsSystem.recordFreeUsageEvent({
    walletId: null,
    userId: null,
    companyId: null,
    featureCode: LANDING_MATCH_OBSERVATION_FEATURE,
    provider: "cunote_matcher",
    model: null,
    requestId,
    contextRef: {
      ...buildLandingMatchObservationContext(
        input.result,
        input.observedAt,
      ),
    },
  });
  return { id: created.id, requestId };
}
