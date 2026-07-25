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
    ${schema.grants.id} IN (
      SELECT active_grant.grant_id
      FROM cunote_active_deep_analysis_grants(
        ${asOfIso}::timestamptz
      ) AS active_grant
    )
  `;
}
