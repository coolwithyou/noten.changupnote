import {
  isVerifiedLocalLabSourceArtifact,
  validatePromotionReleaseManifest,
  type PromotionReleasePlanItem,
  type PromotionReleaseManifest,
  type VerifiedLocalLabSourceEvidence,
} from "./promotionReleaseContract";
import type { AuthoringFeatureReadiness } from "@cunote/contracts";

export interface PromotionServingLedgerItem {
  grantId: string;
  runId: string;
  planSha256: string;
  deepAnalysisRunId: string | null;
  releaseManifestSha256: string;
  manifest: unknown;
}

export interface PromotionServingItemBinding {
  releaseDbId: string;
  grantId: string;
  runId: string;
  planSha256: string;
  deepAnalysisRunId: string | null;
  releaseManifestSha256: string;
}

export interface PromotionServingReleaseDocument {
  releaseDbId: string;
  releaseManifestSha256: string;
  manifest: unknown;
}

export type PromotionServingEvidence =
  | {
      kind: "production_deep_run";
      deepAnalysisRunId: string;
      authoringReadiness: AuthoringFeatureReadiness;
    }
  | {
      kind: "verified_local_lab";
      evidence: VerifiedLocalLabSourceEvidence;
      authoringReadiness: AuthoringFeatureReadiness;
    };

const UNVERIFIED_AUTHORING_READINESS: AuthoringFeatureReadiness = Object.freeze({
  status: "unverified",
  sourceDisposition: "unverified",
});

export interface PromotionServingSnapshotMetrics {
  itemBindingRows: number;
  releaseDocumentRows: number;
  releaseManifestBytes: number;
  releaseManifestValidations: number;
}

export interface PromotionServingRequestSnapshot<TItem extends PromotionServingItemBinding> {
  items: Array<{ item: TItem; evidence: PromotionServingEvidence }>;
  metrics: PromotionServingSnapshotMetrics;
}

interface VerifiedPromotionServingRelease {
  manifest: PromotionReleaseManifest;
  planByGrantId: ReadonlyMap<string, PromotionReleasePlanItem>;
  artifactByGrantId: ReadonlyMap<string, PromotionReleaseManifest["sourceArtifacts"][number]>;
}

/**
 * 제품이 신뢰할 수 있는 승격 provenance를 한 곳에서 판정한다.
 *
 * - 운영 worker 런은 기존 FK를 그대로 신뢰한다.
 * - 로컬 런은 release manifest 자체 해시, item의 plan/run 결속, 구독 transport,
 *   사람 검수 또는 AI 검수+감사 파일 해시가 모두 맞아야 한다.
 * - 기존 local release와 단순 runId만 있는 행은 null로 fail-closed한다.
 */
export function resolvePromotionServingEvidence(
  item: PromotionServingLedgerItem,
): PromotionServingEvidence | null {
  if (item.deepAnalysisRunId) {
    return {
      kind: "production_deep_run",
      deepAnalysisRunId: item.deepAnalysisRunId,
      authoringReadiness: UNVERIFIED_AUTHORING_READINESS,
    };
  }

  const manifest = readManifest(item.manifest);
  if (
    !manifest
    || manifest.manifestSha256 !== item.releaseManifestSha256
    || manifest.servingProvenance !== "verified_local_lab"
  ) {
    return null;
  }
  return resolveVerifiedLocalLabItem(item, indexVerifiedRelease(manifest));
}

/**
 * 한 DB snapshot에서 분리 조회한 작은 item 결속과 release별 문서를 조립한다.
 * manifest는 release당 한 번만 검증하고 item의 plan/run/source 결속은 생략하지 않는다.
 */
export function buildPromotionServingRequestSnapshot<TItem extends PromotionServingItemBinding>(input: {
  items: TItem[];
  releases: PromotionServingReleaseDocument[];
}): PromotionServingRequestSnapshot<TItem> {
  const localReleaseIds = new Set(input.items
    .filter((item) => item.deepAnalysisRunId === null)
    .map((item) => item.releaseDbId));
  const releasesById = new Map<string, VerifiedPromotionServingRelease | null>();
  let releaseManifestBytes = 0;
  let releaseManifestValidations = 0;
  for (const document of input.releases) {
    if (!localReleaseIds.has(document.releaseDbId)) continue;
    releaseManifestBytes += Buffer.byteLength(JSON.stringify(document.manifest));
    if (releasesById.has(document.releaseDbId)) {
      releasesById.set(document.releaseDbId, null);
      continue;
    }
    releaseManifestValidations += 1;
    const manifest = readManifest(document.manifest);
    releasesById.set(
      document.releaseDbId,
      manifest
        && manifest.manifestSha256 === document.releaseManifestSha256
        && manifest.servingProvenance === "verified_local_lab"
        ? indexVerifiedRelease(manifest)
        : null,
    );
  }

  const items: PromotionServingRequestSnapshot<TItem>["items"] = [];
  for (const item of input.items) {
    if (item.deepAnalysisRunId) {
      items.push({
        item,
        evidence: {
          kind: "production_deep_run",
          deepAnalysisRunId: item.deepAnalysisRunId,
          authoringReadiness: UNVERIFIED_AUTHORING_READINESS,
        },
      });
      continue;
    }
    const release = releasesById.get(item.releaseDbId);
    if (!release || release.manifest.manifestSha256 !== item.releaseManifestSha256) continue;
    const evidence = resolveVerifiedLocalLabItem(item, release);
    if (evidence) items.push({ item, evidence });
  }

  return {
    items,
    metrics: {
      itemBindingRows: input.items.length,
      releaseDocumentRows: input.releases.length,
      releaseManifestBytes,
      releaseManifestValidations,
    },
  };
}

function resolveVerifiedLocalLabItem(
  item: Pick<PromotionServingLedgerItem, "grantId" | "runId" | "planSha256">,
  release: VerifiedPromotionServingRelease,
): PromotionServingEvidence | null {
  const plan = release.planByGrantId.get(item.grantId);
  const artifact = release.artifactByGrantId.get(item.grantId);
  if (
    !plan
    || !artifact
    || plan.planSha256 !== item.planSha256
    || plan.promotionPlan.runId !== item.runId
    || artifact.runId !== item.runId
    || !isVerifiedLocalLabSourceArtifact(artifact)
    || !artifact.localLabEvidence
  ) {
    return null;
  }
  return {
    kind: "verified_local_lab",
    evidence: artifact.localLabEvidence,
    authoringReadiness: authoringReadinessForPromotionPlan(plan),
  };
}

function indexVerifiedRelease(manifest: PromotionReleaseManifest): VerifiedPromotionServingRelease {
  return {
    manifest,
    planByGrantId: new Map(manifest.plans.map((plan) => [plan.grantId, plan])),
    artifactByGrantId: new Map(manifest.sourceArtifacts.map((artifact) => [artifact.grantId, artifact])),
  };
}

/** 검증 완료 manifest plan의 작성 projection만 제품 DTO용 최소 계약으로 내린다. */
export function authoringReadinessForPromotionPlan(
  plan: {
    readonly analysisLaunchReadiness?: NonNullable<PromotionReleasePlanItem["analysisLaunchReadiness"]>;
  },
): AuthoringFeatureReadiness {
  const readiness = plan.analysisLaunchReadiness;
  const authoring = readiness?.runFeatureReadiness?.authoring;
  if (!authoring) return UNVERIFIED_AUTHORING_READINESS;
  const currentEvidenceVerified = readiness.authoringEvidenceStatus === "verified"
    && Array.isArray(readiness.authoringEvidenceReasons)
    && readiness.authoringEvidenceReasons.length === 0;
  return {
    status: authoring.status === "ready" && currentEvidenceVerified ? "ready" : "held",
    sourceDisposition: authoring.sourceDisposition,
  };
}

export function isPromotionItemServingEligible(item: PromotionServingLedgerItem): boolean {
  return resolvePromotionServingEvidence(item) !== null;
}

function readManifest(value: unknown): PromotionReleaseManifest | null {
  try {
    return validatePromotionReleaseManifest(value);
  } catch {
    return null;
  }
}
