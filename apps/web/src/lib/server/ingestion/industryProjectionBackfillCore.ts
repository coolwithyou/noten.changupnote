import type { GrantSource, NormalizedGrant } from "@cunote/contracts";
import { mergeGrantIndustryTags, projectGrantIndustryTags } from "@cunote/core";

export interface IndustryProjectionBackfillCandidate {
  source: GrantSource;
  sourceId: string;
  title: string;
  before: string[];
  projected: string[];
  additions: string[];
  after: string[];
}

export interface IndustryProjectionBackfillPlan {
  scanned: number;
  sourceCount: number;
  criteriaSignalCount: number;
  candidateCount: number;
  unchangedCount: number;
  candidates: IndustryProjectionBackfillCandidate[];
}

/** 기존 업종을 삭제·교체하지 않고 긍정 industry criterion 신호만 추가한다. */
export function planBizInfoIndustryProjectionBackfill<TPayload>(
  grants: Array<NormalizedGrant<TPayload>>,
): IndustryProjectionBackfillPlan {
  return planGrantIndustryProjectionBackfill(grants, "bizinfo");
}

export function planGrantIndustryProjectionBackfill<TPayload>(
  grants: Array<NormalizedGrant<TPayload>>,
  source: GrantSource,
): IndustryProjectionBackfillPlan {
  const sourceGrants = grants.filter((entry) => entry.grant.source === source);
  const candidates: IndustryProjectionBackfillCandidate[] = [];
  let criteriaSignalCount = 0;

  for (const entry of sourceGrants) {
    const projected = projectGrantIndustryTags(entry.criteria);
    if (projected.length > 0) criteriaSignalCount += 1;
    const before = [...entry.grant.f_industries];
    const after = mergeGrantIndustryTags(before, projected);
    const beforeSet = new Set(before);
    const additions = after.filter((value) => !beforeSet.has(value));
    if (additions.length === 0) continue;
    candidates.push({
      source,
      sourceId: entry.grant.source_id,
      title: entry.grant.title,
      before,
      projected,
      additions,
      after,
    });
  }

  return {
    scanned: grants.length,
    sourceCount: sourceGrants.length,
    criteriaSignalCount,
    candidateCount: candidates.length,
    unchangedCount: sourceGrants.length - candidates.length,
    candidates,
  };
}
