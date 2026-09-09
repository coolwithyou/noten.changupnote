import type { NormalizedGrant } from "@cunote/contracts";
import { and, eq, inArray } from "drizzle-orm";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import {
  loadPromotionServingRequestSnapshot,
  listActiveGrantsInPromotionServingSnapshot,
  withPromotionServingReadSnapshot,
} from "../repositories/drizzle";
import {
  activeGrantApplyEndCutoff,
  isClearlyStaleUndatedGrant,
  isKStartupRecruitmentClosedPayload,
} from "../repositories/activeGrantFilter";
import type { PromotionServingEvidence } from "../analysis-serving/promotionServing";
import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";
import {
  ACTIVE_SERVING_MONITOR_SENTINEL_LIMIT,
  activeServingMonitorInventorySha256,
  buildActiveServingMonitorPlan,
  type ActiveServingMonitorBinding,
  type ActiveServingMonitorCandidate,
  type ActiveServingMonitorExclusionReason,
  type ActiveServingMonitorPlan,
} from "./servingMonitor";

type PromotionItemRow = typeof schema.analysisLabPromotionItems.$inferSelect;
type PromotionReleaseRow = typeof schema.analysisLabPromotionReleases.$inferSelect;
type DeepAnalysisRunRow = typeof schema.grantDeepAnalysisRuns.$inferSelect;

export interface LoadedActiveServingMonitorBinding extends ActiveServingMonitorBinding {
  releaseManifestSha256: string;
  releasePlanSha256: string;
  manifest: unknown;
  item: PromotionItemRow;
  release: PromotionReleaseRow;
  run: DeepAnalysisRunRow | null;
  evidence: PromotionServingEvidence;
}

export interface ActiveServingMonitorInventory {
  schema: "deep-analysis-active-serving-inventory-v1";
  asOf: string;
  sentinelLimit: number;
  canonicalEntries: NormalizedGrant[];
  candidates: Array<ActiveServingMonitorCandidate<LoadedActiveServingMonitorBinding>>;
  plan: ActiveServingMonitorPlan<NormalizedGrant, LoadedActiveServingMonitorBinding>;
  inventorySha256: string;
  metrics: {
    appliedActiveOrCanaryRows: number;
    servingEligibleBindings: number;
    ineligibleAppliedBindings: number;
  };
}

/**
 * 제품 reader DTO와 그 DTO를 허용한 exact promotion item을 같은 read-only RR snapshot에 묶는다.
 * history/unapplied/release 미적용 상태는 query admission 전에 제외한다.
 */
export async function loadActiveServingMonitorInventory(input: {
  db: CunoteDb;
  asOf?: Date;
  sentinelLimit?: number;
}): Promise<ActiveServingMonitorInventory> {
  const asOf = input.asOf ?? new Date();
  const sentinelLimit = input.sentinelLimit ?? ACTIVE_SERVING_MONITOR_SENTINEL_LIMIT;
  return withPromotionServingReadSnapshot(input.db, async (session) => {
    const canonicalEntries = await listActiveGrantsInPromotionServingSnapshot(session, {
      asOf,
      limit: sentinelLimit,
      requireDeepAnalysisPromotion: true,
    });
    const promotionSnapshot = await loadPromotionServingRequestSnapshot(session);
    const itemRows = await session
      .select({
        item: schema.analysisLabPromotionItems,
        releaseId: schema.analysisLabPromotionReleases.releaseId,
        releaseStatus: schema.analysisLabPromotionReleases.status,
        releaseManifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
        releasePlanSha256: schema.analysisLabPromotionReleases.releasePlanSha256,
        releaseUpdated: schema.analysisLabPromotionReleases.completedAt,
        releaseRolledBackAt: schema.analysisLabPromotionReleases.rolledBackAt,
        grantSource: schema.grants.source,
        grantStatus: schema.grants.status,
        grantTitle: schema.grants.title,
        grantApplyEnd: schema.grants.applyEnd,
        grantServingState: schema.grants.servingState,
        rawPayload: schema.grantRaw.payload,
        run: schema.grantDeepAnalysisRuns,
      })
      .from(schema.analysisLabPromotionItems)
      .innerJoin(
        schema.analysisLabPromotionReleases,
        eq(schema.analysisLabPromotionReleases.id, schema.analysisLabPromotionItems.releaseDbId),
      )
      .innerJoin(schema.grants, eq(schema.grants.id, schema.analysisLabPromotionItems.grantId))
      .leftJoin(
        schema.grantRaw,
        and(
          eq(schema.grantRaw.source, schema.grants.source),
          eq(schema.grantRaw.sourceId, schema.grants.sourceId),
        ),
      )
      .leftJoin(
        schema.grantDeepAnalysisRuns,
        eq(schema.grantDeepAnalysisRuns.id, schema.analysisLabPromotionItems.deepAnalysisRunId),
      )
      .where(and(
        eq(schema.analysisLabPromotionItems.status, "applied"),
        inArray(schema.analysisLabPromotionReleases.status, ["active", "canary_passed"]),
      ));
    const releaseDbIds = uniqueStrings(itemRows.map((row) => row.item.releaseDbId));
    const releaseRows = releaseDbIds.length === 0
      ? []
      : await session
        .select()
        .from(schema.analysisLabPromotionReleases)
        .where(inArray(schema.analysisLabPromotionReleases.id, releaseDbIds));
    const candidateGrantIds = uniqueStrings(itemRows.map((row) => row.item.grantId));
    const confirmedMemberRows = candidateGrantIds.length === 0
      ? []
      : await session
        .select({ memberGrantId: schema.dedupLinks.memberGrantId })
        .from(schema.dedupLinks)
        .where(and(
          eq(schema.dedupLinks.confirmed, true),
          inArray(schema.dedupLinks.memberGrantId, candidateGrantIds),
        ));

    const itemByReleaseGrant = new Map(itemRows.map((row) => [
      bindingKey(row.item.releaseDbId, row.item.grantId),
      row,
    ]));
    const releaseById = new Map(releaseRows.map((release) => [release.id, release]));
    const releaseManifestContentSha256ById = new Map(releaseRows.map((release) => [
      release.id,
      sha256Canonical(release.manifest),
    ]));
    const confirmedMemberIds = new Set(confirmedMemberRows.map((row) => row.memberGrantId));
    const candidates = promotionSnapshot.items.flatMap(({ item, evidence }) => {
      const row = itemByReleaseGrant.get(bindingKey(item.releaseDbId, item.grantId));
      const release = releaseById.get(item.releaseDbId);
      if (!row || !release) return [];
      if (release.status !== "active" && release.status !== "canary_passed") return [];
      const appliedAt = row.item.appliedAt?.toISOString() ?? null;
      const verificationBindingSha256 = sha256Canonical({
        promotionItemId: row.item.id,
        itemStatus: row.item.status,
        itemUpdatedAt: row.item.updatedAt.toISOString(),
        itemPlanSha256: row.item.planSha256,
        itemRunId: row.item.runId,
        itemDeepAnalysisRunId: row.item.deepAnalysisRunId,
        itemAfterSha256: row.item.afterSha256,
        itemBeforeSnapshot: row.item.beforeSnapshot,
        appliedAt,
        releaseId: release.releaseId,
        releaseStatus: release.status,
        releaseManifestSha256: release.manifestSha256,
        releaseManifestContentSha256: releaseManifestContentSha256ById.get(release.id),
        releasePlanSha256: release.releasePlanSha256,
        releaseCompletedAt: release.completedAt?.toISOString() ?? null,
        releaseRolledBackAt: release.rolledBackAt?.toISOString() ?? null,
        run: row.run,
      });
      const binding: LoadedActiveServingMonitorBinding = {
        promotionItemId: row.item.id,
        releaseDbId: row.item.releaseDbId,
        releaseId: release.releaseId,
        releaseStatus: release.status,
        grantId: row.item.grantId,
        runId: row.item.runId,
        planSha256: row.item.planSha256,
        deepAnalysisRunId: row.item.deepAnalysisRunId,
        evidenceKind: evidence.kind,
        appliedAt,
        verificationBindingSha256,
        releaseManifestSha256: release.manifestSha256,
        releasePlanSha256: release.releasePlanSha256,
        manifest: release.manifest,
        item: row.item,
        release,
        run: row.run,
        evidence,
      };
      return [{
        binding,
        canonicalExclusionReason: classifyCanonicalExclusion({
              source: row.grantSource,
              status: row.grantStatus,
              title: row.grantTitle,
              applyEnd: row.grantApplyEnd,
              servingState: row.grantServingState,
              rawPayload: row.rawPayload,
              confirmedMember: confirmedMemberIds.has(row.item.grantId),
              asOf,
            }),
      } satisfies ActiveServingMonitorCandidate<LoadedActiveServingMonitorBinding>];
    });
    const plan = buildActiveServingMonitorPlan({
      canonicalEntries,
      candidates,
      sentinelLimit,
    });
    const inventorySha256 = activeServingMonitorInventorySha256({
      canonicalEntries,
      candidates,
    });
    return {
      schema: "deep-analysis-active-serving-inventory-v1",
      asOf: asOf.toISOString(),
      sentinelLimit,
      canonicalEntries,
      candidates,
      plan,
      inventorySha256,
      metrics: {
        appliedActiveOrCanaryRows: itemRows.length,
        servingEligibleBindings: candidates.length,
        ineligibleAppliedBindings: itemRows.length - candidates.length,
      },
    };
  });
}

function classifyCanonicalExclusion(input: {
  source: "kstartup" | "bizinfo" | "bizinfo_event";
  status: "open" | "closed" | "upcoming" | "unknown";
  title: string;
  applyEnd: Date | null;
  servingState: string;
  rawPayload: unknown;
  confirmedMember: boolean;
  asOf: Date;
}): ActiveServingMonitorExclusionReason | null {
  if (input.servingState !== "visible") return "not_visible";
  if (input.status !== "open" && input.status !== "upcoming" && input.status !== "unknown") {
    return "inactive_status";
  }
  if (input.applyEnd && input.applyEnd < activeGrantApplyEndCutoff(input.asOf)) {
    return "deadline_elapsed";
  }
  if (input.confirmedMember) return "confirmed_duplicate";
  if (isClearlyStaleUndatedGrant({
    source: input.source,
    status: input.status,
    title: input.title,
    apply_end: input.applyEnd?.toISOString() ?? null,
  }, input.asOf)) return "stale_undated";
  if (isKStartupRecruitmentClosedPayload(input.source, input.rawPayload)) {
    return "source_marked_closed";
  }
  return null;
}

function bindingKey(releaseDbId: string, grantId: string): string {
  return `${releaseDbId}:${grantId}`;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}
