import { eq, type SQL } from "drizzle-orm";
import {
  GRANT_SERVING_STATES,
  type GrantServingState,
} from "@cunote/contracts";

import * as schema from "@/lib/server/db/schema";

export { GRANT_SERVING_STATES, type GrantServingState };

/**
 * 일반 사용자·matcher가 소비할 수 있는 공고의 단일 DB predicate.
 *
 * 분석 worker와 명시적 내부 ID 조회는 staged 공고를 처리해야 하므로 호출자가 이
 * predicate를 선택적으로 우회하는 대신 그 경로에서 직접 grants를 조회한다.
 */
export function grantServingVisiblePredicate(): SQL {
  return eq(schema.grants.servingState, "visible");
}

export function isGrantServingVisible(state: string): state is "visible" {
  return state === "visible";
}
