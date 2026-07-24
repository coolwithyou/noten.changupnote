import { sql, type SQL } from "drizzle-orm";
import {
  DEEP_ANALYSIS_ACTIVE_POLICY_VERSION,
  DEEP_ANALYSIS_ACTIVE_TIME_ZONE,
} from "@cunote/contracts";
import * as schema from "@/lib/server/db/schema";

export {
  DEEP_ANALYSIS_ACTIVE_POLICY_VERSION,
  DEEP_ANALYSIS_ACTIVE_TIME_ZONE,
};

/**
 * `isGrantActiveForDeepAnalysis`와 같은 KST 경계를 DB에서 적용한다.
 * applyEnd 미상과 시작 전 공고는 유료 분석 분모가 아니라 별도 예외/예정 큐다.
 */
export function activeDeepAnalysisGrantPredicate(asOf: Date = new Date()): SQL {
  const asOfIso = asOf.toISOString();
  return sql`
    ${schema.grants.status} = 'open'
    AND ${schema.grants.applyEnd} IS NOT NULL
    AND timezone(${DEEP_ANALYSIS_ACTIVE_TIME_ZONE}, ${schema.grants.applyEnd})::date
      >= timezone(${DEEP_ANALYSIS_ACTIVE_TIME_ZONE}, ${asOfIso}::timestamptz)::date
    AND (
      ${schema.grants.applyStart} IS NULL
      OR timezone(${DEEP_ANALYSIS_ACTIVE_TIME_ZONE}, ${schema.grants.applyStart})::date
        <= timezone(${DEEP_ANALYSIS_ACTIVE_TIME_ZONE}, ${asOfIso}::timestamptz)::date
    )
  `;
}
