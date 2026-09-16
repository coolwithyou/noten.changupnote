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
 * 종료 receipt의 immutable ancestry를 읽는 후속 소비 전용 경계다.
 * 역사 계약은 독립 검수·release 준비 같은 모델 무호출 소비에서만 허용하며,
 * 이 reader의 성공을 새 grant/run admission으로 사용할 수 없다.
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
  if (manifest.source.terminalRepair || manifest.source.completedLaunch) {
    const { verifyCurrentInventoryLaunchBinding } = await import("./current-inventory-launch");
    await verifyCurrentInventoryLaunchBinding(input.repositoryRoot, manifest);
  }
  return Object.freeze({ receipt, manifest, grant });
}
