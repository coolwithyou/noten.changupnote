import type { AuthoringFeatureReadiness } from "@cunote/contracts";
import type {
  PromotionServingItemBinding,
  PromotionServingRequestSnapshot,
} from "./promotionServing";
import {
  resolveApplicationFieldRepairAuthoringReadiness,
  type ApplicationFieldRepairServingRow,
} from "./applicationFieldRepairContract";

export interface PromotionServingItemWithIdentity extends PromotionServingItemBinding {
  promotionItemId: string;
}

/**
 * DB의 현재 surface/source/canonical-field 결속까지 검증한 repair만 이 작은 모양으로
 * serving builder에 전달한다. 검증 전 ledger row를 이 타입으로 단언하면 안 된다.
 */
export interface VerifiedApplicationRepairAuthoringOverlay {
  parentPromotionItemId: string;
  authoringReadiness: AuthoringFeatureReadiness & {
    status: "ready";
    sourceDisposition: "ready";
  };
}

/** raw ledger row의 중복을 먼저 닫고 exact repair contract를 통과한 overlay만 만든다. */
export function resolveApplicationRepairAuthoringOverlays(
  rows: readonly ApplicationFieldRepairServingRow[],
): VerifiedApplicationRepairAuthoringOverlay[] {
  const byParent = new Map<string, ApplicationFieldRepairServingRow[]>();
  for (const row of rows) {
    const siblings = byParent.get(row.parentPromotionItemId) ?? [];
    siblings.push(row);
    byParent.set(row.parentPromotionItemId, siblings);
  }
  const overlays: VerifiedApplicationRepairAuthoringOverlay[] = [];
  for (const [parentPromotionItemId, siblings] of byParent) {
    if (siblings.length !== 1) continue;
    const readiness = resolveApplicationFieldRepairAuthoringReadiness(siblings[0]!);
    if (readiness?.status !== "ready" || readiness.sourceDisposition !== "ready") continue;
    overlays.push({
      parentPromotionItemId,
      authoringReadiness: { status: "ready", sourceDisposition: "ready" },
    });
  }
  return overlays;
}

/**
 * 기존 promotion item과 matching provenance는 그대로 두고 작성 준비도만 보강한다.
 * 같은 parent에 verified overlay가 중복되면 순서를 추정하지 않고 기존 readiness로 닫는다.
 */
export function applyApplicationRepairAuthoringOverlays<
  TItem extends PromotionServingItemWithIdentity,
>(
  snapshot: PromotionServingRequestSnapshot<TItem>,
  overlays: readonly VerifiedApplicationRepairAuthoringOverlay[],
): PromotionServingRequestSnapshot<TItem> {
  const overlaysByParent = new Map<string, VerifiedApplicationRepairAuthoringOverlay | null>();
  for (const overlay of overlays) {
    const existing = overlaysByParent.get(overlay.parentPromotionItemId);
    overlaysByParent.set(overlay.parentPromotionItemId, existing === undefined ? overlay : null);
  }
  if (overlaysByParent.size === 0) return snapshot;

  return {
    ...snapshot,
    items: snapshot.items.map((entry) => {
      const overlay = overlaysByParent.get(entry.item.promotionItemId);
      if (!overlay) return entry;
      return {
        item: entry.item,
        evidence: {
          ...entry.evidence,
          authoringReadiness: overlay.authoringReadiness,
        },
      };
    }),
  };
}
