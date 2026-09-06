import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { canonicalJson } from "@/lib/rhwp/documentAgentContract";
import { resolvePromotionServingEvidence } from "./promotionServing";
import {
  authoringGuideMatchesSource,
  formatGrantAuthoringGuide,
  isGrantAuthoringGuideV1,
} from "./authoringGuide";
import { validatePromotionReleaseManifest } from "./promotionReleaseContract";
import {
  loadPromotionGrantSnapshot,
  promotionGrantSnapshotStateSha256,
} from "./promotionSnapshot";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";

export type DocumentAgentEvidenceKind =
  | "current_document"
  | "announcement"
  | "company_profile"
  | "verified_deep";

export interface DocumentAgentGroundingSource {
  sourceId: string;
  kind: DocumentAgentEvidenceKind;
  title: string;
  content: string;
  sha256: string;
  provenance: Record<string, unknown>;
}

export interface DocumentAgentGroundingBundle {
  sources: DocumentAgentGroundingSource[];
  groundingBindingSha256: string;
  groundingProvenance: Record<string, unknown>;
}

export async function loadVerifiedDeepSources(grantId: string): Promise<{
  sources: DocumentAgentGroundingSource[];
  provenance: Record<string, unknown>;
}> {
  const db = getCunoteDb();
  const rows = await db
    .select({
      releaseId: schema.analysisLabPromotionReleases.releaseId,
      releaseDbId: schema.analysisLabPromotionReleases.id,
      releaseStatus: schema.analysisLabPromotionReleases.status,
      releaseManifestSha256: schema.analysisLabPromotionReleases.manifestSha256,
      manifest: schema.analysisLabPromotionReleases.manifest,
      promotionItemId: schema.analysisLabPromotionItems.id,
      runId: schema.analysisLabPromotionItems.runId,
      planSha256: schema.analysisLabPromotionItems.planSha256,
      deepAnalysisRunId: schema.analysisLabPromotionItems.deepAnalysisRunId,
      afterSha256: schema.analysisLabPromotionItems.afterSha256,
      appliedAt: schema.analysisLabPromotionItems.appliedAt,
      deepRunStatus: schema.grantDeepAnalysisRuns.status,
      deepSourceRevisionSha256: schema.grantDeepAnalysisRuns.sourceRevisionSha256,
    })
    .from(schema.analysisLabPromotionItems)
    .innerJoin(
      schema.analysisLabPromotionReleases,
      eq(schema.analysisLabPromotionItems.releaseDbId, schema.analysisLabPromotionReleases.id),
    )
    .leftJoin(
      schema.grantDeepAnalysisRuns,
      eq(schema.analysisLabPromotionItems.deepAnalysisRunId, schema.grantDeepAnalysisRuns.id),
    )
    .where(and(
      eq(schema.analysisLabPromotionItems.grantId, grantId),
      eq(schema.analysisLabPromotionItems.status, "applied"),
      isNull(schema.analysisLabPromotionItems.rolledBackAt),
      isNotNull(schema.analysisLabPromotionItems.appliedAt),
      inArray(schema.analysisLabPromotionReleases.status, ["active", "canary_passed"]),
    ))
    .orderBy(desc(schema.analysisLabPromotionItems.appliedAt))
    .limit(2);
  const newest = rows[0];
  if (!newest || !newest.appliedAt || !newest.afterSha256) {
    return { sources: [], provenance: { status: "unavailable" } };
  }
  if (rows[1]?.appliedAt?.getTime() === newest.appliedAt.getTime()) {
    return { sources: [], provenance: { status: "ambiguous_newest" } };
  }
  const evidence = resolvePromotionServingEvidence({
    grantId,
    runId: newest.runId,
    planSha256: newest.planSha256,
    deepAnalysisRunId: newest.deepAnalysisRunId,
    releaseManifestSha256: newest.releaseManifestSha256,
    manifest: newest.manifest,
  });
  if (
    !evidence
    || (evidence.kind === "production_deep_run" && newest.deepRunStatus !== "passed")
  ) {
    return { sources: [], provenance: { status: "invalid_provenance" } };
  }
  let manifest;
  try {
    manifest = validatePromotionReleaseManifest(newest.manifest);
  } catch {
    return { sources: [], provenance: { status: "invalid_manifest" } };
  }
  const plan = manifest.plans.find((entry) => entry.grantId === grantId);
  const artifact = manifest.sourceArtifacts.find((entry) => entry.grantId === grantId);
  if (
    manifest.manifestSha256 !== newest.releaseManifestSha256
    || !plan
    || !artifact
    || plan.planSha256 !== newest.planSha256
    || plan.promotionPlan.runId !== newest.runId
    || artifact.runId !== newest.runId
  ) {
    return { sources: [], provenance: { status: "manifest_binding_mismatch" } };
  }
  const sourceRevisionSha256 = artifact.sourceRevisionSha256;
  if (
    !sourceRevisionSha256
    || !/^[0-9a-f]{64}$/u.test(sourceRevisionSha256)
    || (evidence.kind === "production_deep_run" && (
      artifact.deepAnalysisRunId !== newest.deepAnalysisRunId
      || newest.deepSourceRevisionSha256 !== sourceRevisionSha256
    ))
    || (evidence.kind === "verified_local_lab"
      && evidence.evidence.deepRepair
      && evidence.evidence.deepRepair.sourceRevisionSha256 !== sourceRevisionSha256)
  ) {
    return { sources: [], provenance: { status: "source_revision_mismatch" } };
  }
  const snapshot = await loadPromotionGrantSnapshot(db, grantId);
  const currentSha256 = promotionGrantSnapshotStateSha256(snapshot);
  if (currentSha256 !== newest.afterSha256) {
    return { sources: [], provenance: { status: "current_state_drift" } };
  }
  const planStableKeyCounts = countStableKeys(plan.promotionPlan.criterionStableKeys);
  const snapshotStableKeyCounts = countStableKeys(snapshot.criteria.map((criterion) => criterion.stableKey));
  const candidates = snapshot.criteria.flatMap((criterion) => {
    if (
      !criterion.stableKey
      || planStableKeyCounts.get(criterion.stableKey) !== 1
      || snapshotStableKeyCounts.get(criterion.stableKey) !== 1
    ) return [];
    const content = [
      `판정 축: ${criterion.dimension}`,
      `조건: ${criterion.operator} ${canonicalJson(criterion.value)}`,
      criterion.rawText ? `공고 조건 원문: ${criterion.rawText}` : null,
      criterion.sourceSpan ? `근거: ${criterion.sourceSpan}` : null,
    ].filter((value): value is string => Boolean(value)).join("\n");
    return [makeSource({
      sourceId: `deep_analysis:${criterion.dimension}:${sha256(criterion.stableKey)}`,
      kind: "verified_deep",
      title: `검증된 딥분석 조건 · ${criterion.dimension}`,
      content,
      provenance: {
        stableKey: criterion.stableKey,
      },
    })];
  });
  const sourceIdCounts = new Map<string, number>();
  for (const source of candidates) {
    sourceIdCounts.set(source.sourceId, (sourceIdCounts.get(source.sourceId) ?? 0) + 1);
  }
  const sources = candidates.filter((source) => sourceIdCounts.get(source.sourceId) === 1);
  let authoringGuideStatus: "verified" | "unavailable" | "binding_mismatch" = "unavailable";
  if (isGrantAuthoringGuideV1(snapshot.authoringGuide)) {
    const expectedInputSha256 = artifact.inputSha256 ?? artifact.localLabEvidence?.inputSha256 ?? null;
    const expectedAttachmentManifestSha256 =
      artifact.localLabEvidence?.deepRepair?.attachmentManifestSha256
      ?? artifact.localLabEvidence?.analysisLaunch?.attachmentManifestSha256
      ?? null;
    const guide = snapshot.authoringGuide;
    const guideBound = authoringGuideMatchesSource({
      guide,
      runId: newest.runId,
      inputSha256: expectedInputSha256,
      sourceRevisionSha256,
      attachmentManifestSha256: expectedAttachmentManifestSha256,
    });
    if (guideBound) {
      const content = formatGrantAuthoringGuide(guide);
      sources.push(makeSource({
        sourceId: `deep_analysis:authoring_guide:${sha256(content)}`,
        kind: "verified_deep",
        title: "검증된 공고 작성 가이드",
        content,
        provenance: {
          runId: guide.source.runId,
          inputSha256: guide.source.inputSha256,
          sourceRevisionSha256: guide.source.sourceRevisionSha256,
          attachmentManifestSha256: guide.source.attachmentManifestSha256,
        },
      }));
      authoringGuideStatus = "verified";
    } else {
      authoringGuideStatus = "binding_mismatch";
    }
  }
  return {
    sources,
    provenance: {
      status: "verified",
      promotionItemId: newest.promotionItemId,
      releaseDbId: newest.releaseDbId,
      releaseId: newest.releaseId,
      releaseStatus: newest.releaseStatus,
      runId: newest.runId,
      deepAnalysisRunId: newest.deepAnalysisRunId,
      planSha256: newest.planSha256,
      manifestSha256: newest.releaseManifestSha256,
      afterSha256: newest.afterSha256,
      appliedAt: newest.appliedAt.toISOString(),
      promotionStateSha256: currentSha256,
      servingKind: evidence.kind,
      sourceRevisionSha256,
      authoringGuideStatus,
    },
  };
}

function countStableKeys(values: readonly (string | null | undefined)[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value?.trim()) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

function makeSource(input: Omit<DocumentAgentGroundingSource, "sha256">): DocumentAgentGroundingSource {
  return { ...input, sha256: sha256(input.content) };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
