import { APPLICATION_ROUNDTRIP_ADOPTED_MODEL, APPLICATION_ROUNDTRIP_VERSION } from "../application-analysis/contract";
import type { ApplicationRoundtripReleaseAdmission } from "../analysis-lab/application-roundtrip/release-admission";

export const PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA =
  "promotion-application-precompute-v2" as const;
export const LEGACY_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA =
  "promotion-application-precompute-v1" as const;
export const ANALYSIS_LAUNCH_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA =
  "promotion-application-precompute-v3" as const;

export interface PromotionApplicationPrecomputeAdmissionEvidence {
  receiptSchema: ApplicationRoundtripReleaseAdmission["receiptSchema"];
  admissionReceiptSha256: string;
  canaryReceiptSha256: string;
  proposalSha256: string;
  proposalGitSha: string;
  policyGitSha: string | null;
  sequence: number;
  deepReceiptSha256: string;
  sourceSha256s: string[];
  runArtifactPath: string;
  runArtifactSha256: string;
  targetDisposition: "ready" | "conditional";
  cohortVerdict: "CONTINUE";
  reasonCodes: ApplicationRoundtripReleaseAdmission["reasonCodes"];
}

export interface PromotionApplicationPrecomputeLaunchEvidence {
  launchReceiptSha256: string;
  launchManifestSha256: string;
  launchGrantSha256: string;
  launchSequence: number;
  independentReviewManifestSha256: string;
  independentReviewAggregateSha256: string;
  runArtifactSha256: string;
  applicationFieldAnalysisVersion: string;
}

export interface PromotionApplicationPrecomputeEvidence {
  schema:
    | typeof PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
    | typeof LEGACY_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
    | typeof ANALYSIS_LAUNCH_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA;
  releaseId: string;
  grantId: string;
  parentLabRunId: string;
  roundtripRunId: string;
  status: "ready" | "conditional" | "not_applicable";
  transport: "claude-cli";
  model: typeof APPLICATION_ROUNDTRIP_ADOPTED_MODEL;
  analysisSha256: string;
  manifestSha256: string;
  sourceCount: number;
  documentCount: number;
  materializableDocumentCount: number;
  reviewRequiredDocumentCount: number;
  /** v2부터 deep receipt와 Kordoc canary/policy receipt의 exact 결속을 봉인한다. */
  canaryAdmission?: PromotionApplicationPrecomputeAdmissionEvidence;
  /** v3: formal launch receipt와 target별 독립 검수 PASS 결속. */
  launchAdmission?: PromotionApplicationPrecomputeLaunchEvidence;
}

export function validatePromotionApplicationPrecomputeEvidence(
  value: unknown,
): asserts value is PromotionApplicationPrecomputeEvidence {
  if (!value || typeof value !== "object") throw new Error("Kordoc release evidence가 객체가 아닙니다.");
  const evidence = value as Partial<PromotionApplicationPrecomputeEvidence>;
  if (
    evidence.schema !== PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
      && evidence.schema !== LEGACY_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
      && evidence.schema !== ANALYSIS_LAUNCH_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
  ) {
    throw new Error("Kordoc release evidence schema가 올바르지 않습니다.");
  }
  if (
    typeof evidence.releaseId !== "string"
    || typeof evidence.grantId !== "string"
    || typeof evidence.parentLabRunId !== "string"
    || typeof evidence.roundtripRunId !== "string"
    || (evidence.status !== "ready" && evidence.status !== "conditional" && evidence.status !== "not_applicable")
    || evidence.transport !== "claude-cli"
    || evidence.model !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
    || !isSha256(evidence.analysisSha256)
    || !isSha256(evidence.manifestSha256)
    || !isNonnegativeInteger(evidence.sourceCount)
    || !isNonnegativeInteger(evidence.documentCount)
    || !isNonnegativeInteger(evidence.materializableDocumentCount)
    || !isNonnegativeInteger(evidence.reviewRequiredDocumentCount)
    || ((evidence.status === "ready" || evidence.status === "conditional")
      && evidence.materializableDocumentCount === 0)
  ) {
    throw new Error("Kordoc release evidence 형식이 올바르지 않습니다.");
  }
  if (evidence.schema === PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA) {
    validateCanaryAdmissionEvidence(evidence.canaryAdmission, evidence);
    if (evidence.launchAdmission !== undefined) {
      throw new Error("Kordoc v2 evidence에는 launch admission을 기록할 수 없습니다.");
    }
  } else if (evidence.schema === ANALYSIS_LAUNCH_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA) {
    validateLaunchAdmissionEvidence(evidence.launchAdmission, evidence);
    if (evidence.canaryAdmission !== undefined) {
      throw new Error("formal launch RHWP evidence에는 canary admission을 기록할 수 없습니다.");
    }
  } else if (evidence.status === "conditional" || evidence.canaryAdmission !== undefined) {
    throw new Error("legacy Kordoc release evidence에는 canary admission을 기록할 수 없습니다.");
  }
  assertSafeReleaseSegment(evidence.releaseId, "releaseId");
  assertSafeReleaseSegment(evidence.grantId, "grantId");
}

function validateLaunchAdmissionEvidence(
  value: PromotionApplicationPrecomputeLaunchEvidence | undefined,
  evidence: { schema?: unknown },
): void {
  if (
    !value
    || !isSha256(value.launchReceiptSha256)
    || !isSha256(value.launchManifestSha256)
    || !isSha256(value.launchGrantSha256)
    || !Number.isInteger(value.launchSequence)
    || value.launchSequence < 0
    || !isSha256(value.independentReviewManifestSha256)
    || !isSha256(value.independentReviewAggregateSha256)
    || !isSha256(value.runArtifactSha256)
    || value.applicationFieldAnalysisVersion !== APPLICATION_ROUNDTRIP_VERSION
    || evidence.schema !== ANALYSIS_LAUNCH_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
  ) {
    throw new Error("formal launch RHWP evidence 결속이 올바르지 않습니다.");
  }
}

function validateCanaryAdmissionEvidence(
  value: unknown,
  evidence: Partial<PromotionApplicationPrecomputeEvidence>,
): asserts value is PromotionApplicationPrecomputeAdmissionEvidence {
  if (!value || typeof value !== "object") {
    throw new Error("Kordoc release canary admission이 없습니다.");
  }
  const admission = value as Partial<PromotionApplicationPrecomputeAdmissionEvidence>;
  if (
    (admission.receiptSchema !== "application-roundtrip-canary-receipt-v3"
      && admission.receiptSchema !== "application-roundtrip-canary-policy-receipt-v1")
    || !isSha256(admission.admissionReceiptSha256)
    || !isSha256(admission.canaryReceiptSha256)
    || !isSha256(admission.proposalSha256)
    || typeof admission.proposalGitSha !== "string"
    || !/^[a-f0-9]{40}$/u.test(admission.proposalGitSha)
    || (admission.policyGitSha !== null
      && (typeof admission.policyGitSha !== "string" || !/^[a-f0-9]{40}$/u.test(admission.policyGitSha)))
    || !isNonnegativeInteger(admission.sequence)
    || !isSha256(admission.deepReceiptSha256)
    || !Array.isArray(admission.sourceSha256s)
    || admission.sourceSha256s.length === 0
    || admission.sourceSha256s.some((sha256) => !isSha256(sha256))
    || new Set(admission.sourceSha256s).size !== admission.sourceSha256s.length
    || typeof admission.runArtifactPath !== "string"
    || !isSha256(admission.runArtifactSha256)
    || (admission.targetDisposition !== "ready" && admission.targetDisposition !== "conditional")
    || admission.cohortVerdict !== "CONTINUE"
    || !Array.isArray(admission.reasonCodes)
    || admission.reasonCodes.length === 0
    || admission.targetDisposition !== evidence.status
    || admission.runArtifactSha256 !== evidence.analysisSha256
    || (admission.receiptSchema === "application-roundtrip-canary-receipt-v3"
      && (admission.admissionReceiptSha256 !== admission.canaryReceiptSha256
        || admission.policyGitSha !== null))
    || (admission.receiptSchema === "application-roundtrip-canary-policy-receipt-v1"
      && admission.policyGitSha === null)
  ) {
    throw new Error("Kordoc release canary admission 형식이 올바르지 않습니다.");
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function assertSafeReleaseSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,119}$/u.test(value)) {
    throw new Error(`허용되지 않는 ${label}: ${value}`);
  }
}
