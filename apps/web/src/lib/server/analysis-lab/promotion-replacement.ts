import { and, eq, inArray } from "drizzle-orm";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadPromotionGrantSnapshot, promotionGrantSnapshotStateSha256 } from "./promotion-snapshot";
import { readPromotionReleaseManifest, sha256Canonical, type PromotionReleaseManifest } from "./promotion-release";

type Replacement = NonNullable<PromotionReleaseManifest["replacesActiveRelease"]>;

/** Only an explicit, fully applied predecessor can be replaced. Never clear old ledger rows. */
export function assertAppliedReplacementItem(input: {
  releaseStatus: string; itemStatus: string; ledgerManifestSha256: string;
  manifestSha256: string; ledgerRunId: string; manifestRunId: string;
  afterSha256: string | null; currentSha256: string;
}): void {
  if (input.releaseStatus !== "active" || input.itemStatus !== "applied"
    || input.ledgerManifestSha256 !== input.manifestSha256
    || input.ledgerRunId !== input.manifestRunId
    || !input.afterSha256 || input.afterSha256 !== input.currentSha256) {
    throw new Error("이전 발행의 active/applied·manifest·run·현재 snapshot 결속이 다릅니다.");
  }
}

export async function loadActiveReplacement(releaseId: string, grantIds: readonly string[]): Promise<{
  evidence: Replacement; manifest: PromotionReleaseManifest;
}> {
  const manifest = await readPromotionReleaseManifest(releaseId);
  const db = getCunoteDb();
  const rows = await db.select({ releaseStatus: schema.analysisLabPromotionReleases.status,
    ledgerManifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
    grantId: schema.analysisLabPromotionItems.grantId,
    itemStatus: schema.analysisLabPromotionItems.status,
    ledgerRunId: schema.analysisLabPromotionItems.runId,
    afterSha256: schema.analysisLabPromotionItems.afterSha256,
  }).from(schema.analysisLabPromotionReleases).innerJoin(schema.analysisLabPromotionItems,
    eq(schema.analysisLabPromotionReleases.id, schema.analysisLabPromotionItems.releaseDbId))
    .where(and(eq(schema.analysisLabPromotionReleases.releaseId, releaseId),
      inArray(schema.analysisLabPromotionItems.grantId, [...grantIds])));
  if (rows.length !== grantIds.length) throw new Error("이전 발행에 exact 대상이 없습니다.");
  const items: Replacement["items"] = [];
  for (const grantId of grantIds) {
    const row = rows.find((item) => item.grantId === grantId);
    const plan = manifest.plans.find((item) => item.grantId === grantId);
    if (!row || !plan) throw new Error("이전 발행 대상 결속이 없습니다.");
    const snapshot = await loadPromotionGrantSnapshot(db, grantId);
    assertAppliedReplacementItem({ ...row, manifestSha256: manifest.manifestSha256,
      manifestRunId: plan.promotionPlan.runId,
      currentSha256: promotionGrantSnapshotStateSha256(snapshot) });
    items.push({ grantId, runId: row.ledgerRunId, afterSha256: row.afterSha256! });
  }
  return { evidence: { releaseId, manifestSha256: manifest.manifestSha256, items }, manifest };
}

/** An older prepared revision already followed by this applied cohort is historical. */
export function isPreparedAncestorOfReplacement(previous: PromotionReleaseManifest, active: PromotionReleaseManifest): boolean {
  return previous.cohortLabel === active.cohortLabel && previous.revision < active.revision
    && previous.plans.length >= active.plans.length && active.plans.length > 0
    && active.plans.every((item) => previous.plans.some((old) => item.grantId === old.grantId
      && item.promotionPlan.runId === old.promotionPlan.runId));
}

export async function verifyActiveReplacement(manifest: PromotionReleaseManifest): Promise<void> {
  if (!manifest.replacesActiveRelease) return;
  const current = await loadActiveReplacement(manifest.replacesActiveRelease.releaseId,
    manifest.plans.map((item) => item.grantId));
  if (sha256Canonical(current.evidence) !== sha256Canonical(manifest.replacesActiveRelease)) {
    throw new Error("replacement 준비 이후 이전 발행 결속이 변경됐습니다.");
  }
}
