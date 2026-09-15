import {
  normalizeAnalysisLaunchGrant,
  normalizeAnalysisLaunchReceipt,
  normalizeCompletedAnalysisLaunchManifestForOfflineConsumption,
  readAnalysisLaunchArtifact,
  type AnalysisLaunchGrant,
  type AnalysisLaunchManifest,
  type AnalysisLaunchReceipt,
} from "./launch-batch-artifacts";

export interface CompletedAnalysisLaunchArtifacts {
  readonly receipt: AnalysisLaunchReceipt;
  readonly manifest: AnalysisLaunchManifest;
  readonly grant: AnalysisLaunchGrant;
}

/**
 * 완료 receipt의 content-addressed ancestry를 읽는 오프라인 consumer 전용 경계다.
 * live admission과 promotion은 이 reader를 사용하지 않는다.
 */
export async function readCompletedAnalysisLaunchArtifacts(input: {
  readonly launchReceiptSha256: string;
  readonly repositoryRoot: string;
}): Promise<CompletedAnalysisLaunchArtifacts> {
  const receipt = normalizeAnalysisLaunchReceipt(await readAnalysisLaunchArtifact(
    "receipts",
    input.launchReceiptSha256,
    input.repositoryRoot,
  ));
  const manifest = normalizeCompletedAnalysisLaunchManifestForOfflineConsumption(
    await readAnalysisLaunchArtifact("manifests", receipt.manifestSha256, input.repositoryRoot),
  );
  const grant = normalizeAnalysisLaunchGrant(await readAnalysisLaunchArtifact(
    "grants",
    receipt.grantSha256,
    input.repositoryRoot,
  ));
  if (
    grant.manifestSha256 !== receipt.manifestSha256
    || grant.targetCount !== manifest.targets.length
    || receipt.targets.length !== manifest.targets.length
  ) {
    throw new Error("launch receipt/manifest/grant target 결속이 다릅니다.");
  }
  const manifestTargets = new Map(manifest.targets.map((target) => [target.sequence, target.grantId]));
  if (
    manifestTargets.size !== manifest.targets.length
    || receipt.targets.some((target) => manifestTargets.get(target.sequence) !== target.grantId)
  ) {
    throw new Error("launch receipt target이 manifest exact target과 다릅니다.");
  }
  return Object.freeze({ receipt, manifest, grant });
}
