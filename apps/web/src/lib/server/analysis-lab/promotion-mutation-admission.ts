import type { PromotionReleaseManifest } from "./promotion-release";

/** legacy review 경로가 receipt 기반 closed-beta 권한을 우회하려 할 때의 명시적 거부. */
export class PromotionMutationAdmissionError extends Error {
  readonly code = "receipt_backed_release_required" as const;

  constructor(reason: string) {
    super(`receipt 기반 exact release만 승인·승격할 수 있습니다: ${reason}`);
    this.name = "PromotionMutationAdmissionError";
  }
}

/**
 * 모델 실행 Gate와 release mutation 권한을 분리한다.
 *
 * 이 함수는 readPromotionReleaseManifest가 schema/hash를 검증한 뒤 호출한다. 모든 항목이
 * exact deep-repair receipt와 current revision readiness에 묶인 release만 mutation 경계를
 * 통과한다. 실제 쓰기는 이후 manifest 확인, 준비자/승인자/실행자 분리, aggregate/shadow/
 * dry-run, baseline/source 재검증이 모두 통과해야 열린다.
 */
export function assertReceiptBackedPromotionMutationAdmitted(
  manifest: PromotionReleaseManifest,
): void {
  if (manifest.servingProvenance !== "verified_local_lab") {
    throw new PromotionMutationAdmissionError("verified_local_lab provenance가 아닙니다");
  }
  if (manifest.plans.length === 0 || manifest.sourceArtifacts.length !== manifest.plans.length) {
    throw new PromotionMutationAdmissionError("plan/source cardinality가 일치하지 않습니다");
  }
  const sourceByGrantId = new Map(
    manifest.sourceArtifacts.map((source) => [source.grantId, source]),
  );
  for (const item of manifest.plans) {
    if (
      item.promotionPlan.origin !== "deep_repair"
      || item.promotionPlan.auditState !== "deep_repair_receipt"
    ) {
      throw new PromotionMutationAdmissionError(`${item.grantId}가 deep-repair plan이 아닙니다`);
    }
    const readiness = item.deepRepairReadiness;
    if (
      !readiness
      || (readiness.disposition !== "ready" && readiness.disposition !== "conditional")
      || readiness.reasons.length > 0
    ) {
      throw new PromotionMutationAdmissionError(`${item.grantId}의 current readiness가 안전하지 않습니다`);
    }
    const source = sourceByGrantId.get(item.grantId);
    const evidence = source?.localLabEvidence;
    const deepRepair = evidence?.deepRepair;
    if (
      !source
      || source.runId !== item.promotionPlan.runId
      || evidence?.reviewMethod !== "deep_repair_receipt"
      || !deepRepair
      || deepRepair.receiptSha256 !== readiness.receiptSha256
      || deepRepair.sourceRevisionSha256 !== readiness.sourceRevisionSha256
    ) {
      throw new PromotionMutationAdmissionError(`${item.grantId}의 run/receipt/revision 결속이 불완전합니다`);
    }
    if (
      evidence.inputSha256 !== readiness.inputSha256
      || deepRepair.attachmentManifestSha256 !== readiness.attachmentManifestSha256
      || source.sourceRevisionSha256 !== readiness.sourceRevisionSha256
    ) {
      throw new PromotionMutationAdmissionError(`${item.grantId}의 input/attachment/revision이 다릅니다`);
    }
  }
}
