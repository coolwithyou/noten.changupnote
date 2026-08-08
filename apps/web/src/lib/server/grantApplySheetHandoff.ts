import { unstable_cache } from "next/cache";
import { loadServiceApplySheet } from "./serviceData";

type GrantApplySheetScope =
  | { companyId: string; userId: string; virtualBizNo?: never }
  | { virtualBizNo: string; companyId?: never; userId?: never };

/**
 * 공고 상세에서 만든 사용자별 판정 시트를 바로 이어지는 workspace 진입에서 재사용한다.
 * 상세 렌더마다 새 handoffKey를 발급하고 인증·회사 선택은 캐시 밖에서 검증해, 다른 방문이나
 * 사용자/회사 결과가 섞이지 않게 한다.
 */
const loadCachedGrantApplySheet = unstable_cache(
  async (
    grantId: string,
    handoffKey: string,
    scope: "company" | "virtual",
    companyId: string | null,
    userId: string | null,
    virtualBizNo: string | null,
  ) => loadServiceApplySheet(
    grantId,
    scope === "virtual"
      ? { virtualBizNo: virtualBizNo! }
      : { companyId: companyId!, userId: userId! },
  ),
  ["grant-apply-sheet-handoff-v1"],
  { revalidate: 600 },
);

export function loadGrantApplySheetForHandoff(
  grantId: string,
  handoffKey: string,
  scope: GrantApplySheetScope,
) {
  if (scope.virtualBizNo !== undefined) {
    return loadCachedGrantApplySheet(grantId, handoffKey, "virtual", null, null, scope.virtualBizNo);
  }
  return loadCachedGrantApplySheet(grantId, handoffKey, "company", scope.companyId, scope.userId, null);
}
