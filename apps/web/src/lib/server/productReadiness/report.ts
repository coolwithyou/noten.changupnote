import type { NormalizedGrant, WriteSupportLevel } from "@cunote/contracts";
import { deriveWriteSupport, grantKey, type GrantRepository } from "@cunote/core";

/** 제품 조회 정책 두 집합을 비교한다. 미노출 사유를 전부 '분석 실패'로 추정하지 않는다. */
export async function loadProductReadinessReport(input: {
  asOf: Date;
  repository: GrantRepository;
  source: "database" | "runtime_fixture";
  limit?: number;
}) {
  const limit = input.limit ?? 20_000;
  if (!Number.isFinite(input.asOf.getTime()) || !Number.isInteger(limit) || limit < 1 || limit > 20_000) {
    throw new Error("준비도 조회 기준일과 상한을 확인해주세요.");
  }
  const [inventory, serving] = await Promise.all([
    input.repository.listActiveGrants({ asOf: input.asOf, limit: limit + 1 }),
    input.repository.listActiveGrants({ asOf: input.asOf, limit: limit + 1, requireDeepAnalysisPromotion: true }),
  ]);
  if (inventory.length > limit || serving.length > limit) throw new Error("준비도 조회 상한 초과: 부분 집계는 반환하지 않습니다.");
  return buildProductReadinessReport({ ...input, inventory, serving });
}

export function buildProductReadinessReport(input: {
  asOf: Date;
  inventory: NormalizedGrant[];
  serving: NormalizedGrant[];
  source: "database" | "runtime_fixture";
}) {
  const inventory = uniqueGrants(input.inventory);
  const serving = uniqueGrants(input.serving);
  if ([...serving.keys()].some((id) => !inventory.has(id))) {
    throw new Error("조회 중 공고 집합 변경 감지: 같은 기준일로 다시 조회해주세요.");
  }
  const unserved = [...inventory].filter(([id]) => !serving.has(id)).map(([, value]) => value);
  const ages = unserved.map((entry) => Date.parse(entry.raw.collected_at ?? "")).filter((time) => Number.isFinite(time) && time <= input.asOf.getTime());
  const authoringSignals: Record<WriteSupportLevel, number> = {
    unknown: 0,
    ai_draft: 0,
    web_form_guide: 0,
    manual_form: 0,
    template_fill: 0,
  };
  for (const entry of serving.values()) authoringSignals[deriveWriteSupport(entry.grant)] += 1;
  return {
    version: "product-readiness-v1" as const,
    asOf: input.asOf.toISOString(),
    source: input.source,
    supply: {
      activeVisibleInventory: inventory.size,
      matchingServing: serving.size,
      notInMatchingServing: unserved.length,
      oldestUnservedCollectionAgeHours: ages.length ? Math.max(...ages.map((time) => (input.asOf.getTime() - time) / 3_600_000)) : null,
      unservedMissingCollectionTime: unserved.length - ages.length,
      note: "저장소의 활성·노출 정책 범위입니다. 미노출은 승격 대기·조건 부족 등 여러 원인일 수 있습니다. 수집 후 경과 시간은 승격 지연 시간이 아닙니다.",
    },
    authoring: {
      signals: authoringSignals,
      evidence: "announcement_metadata_only" as const,
      note: "공고 메타데이터의 작성 방식 신호이며 실제 편집·저장·다운로드 성공 건수가 아닙니다. 기능 준비는 각 작성 화면에서 별도로 확인합니다.",
    },
    promotionToExposureLatency: { status: "unavailable" as const, reason: "노출 영수증을 조회하지 않은 보고서입니다. DB 관측이 활성화된 경우에만 최초 수신 지연을 별도로 집계합니다." },
  };
}

function uniqueGrants(grants: NormalizedGrant[]) {
  const map = new Map<string, NormalizedGrant>();
  for (const entry of grants) {
    const id = grantKey(entry.grant);
    if (map.has(id)) throw new Error("중복 공고로 준비도를 집계할 수 없습니다.");
    map.set(id, entry);
  }
  return map;
}
