import {
  isVerifiedLocalLabSourceArtifact,
  validatePromotionReleaseManifest,
  type PromotionReleaseManifest,
  type VerifiedLocalLabSourceEvidence,
} from "./promotion-release";

export interface PromotionServingLedgerItem {
  grantId: string;
  runId: string;
  planSha256: string;
  deepAnalysisRunId: string | null;
  releaseManifestSha256: string;
  manifest: unknown;
}

export type PromotionServingEvidence =
  | { kind: "production_deep_run"; deepAnalysisRunId: string }
  | {
      kind: "verified_local_lab";
      evidence: VerifiedLocalLabSourceEvidence;
    };

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
    return { kind: "production_deep_run", deepAnalysisRunId: item.deepAnalysisRunId };
  }

  const manifest = readManifest(item.manifest);
  if (
    !manifest
    || manifest.manifestSha256 !== item.releaseManifestSha256
    || manifest.servingProvenance !== "verified_local_lab"
  ) {
    return null;
  }
  const plan = manifest.plans.find((entry) => entry.grantId === item.grantId);
  const artifact = manifest.sourceArtifacts.find((entry) => entry.grantId === item.grantId);
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
  return { kind: "verified_local_lab", evidence: artifact.localLabEvidence };
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
