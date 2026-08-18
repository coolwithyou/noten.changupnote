import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import type { LabRun } from "@/lib/server/analysis-lab/lab-contract";
import {
  classifyApplicationPrecomputeDocument,
  type AppliedGrantApplicationPrecompute,
} from "../documents/applicationPrecomputeMaterialization";
import {
  readRoundtripRunArtifacts,
  type RoundtripRunManifest,
} from "./application-roundtrip/store";
import { admitApplicationRoundtripRelease } from "./application-roundtrip/release-admission-production";
import type { ApplicationRoundtripReleaseAdmission } from "./application-roundtrip/release-admission";
import { analysisLabDir, findMonorepoRoot } from "./run-store";
import { isPublishableLabRun } from "./run-outcome";

export const PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA =
  "promotion-application-precompute-v2" as const;
export const LEGACY_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA =
  "promotion-application-precompute-v1" as const;

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

export interface PromotionApplicationPrecomputeEvidence {
  schema:
    | typeof PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
    | typeof LEGACY_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA;
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
}

export interface BundledPromotionApplicationPrecompute {
  run: ApplicationRoundtripRun;
  manifest: RoundtripRunManifest;
}

export interface PromotionApplicationPrecomputeReceipt {
  schema: "analysis-lab-application-precompute-receipt-v1";
  status: "ready" | "conditional" | "not_applicable";
  roundtripRunId: string | null;
  transport?: "claude-cli";
  model?: typeof APPLICATION_ROUNDTRIP_ADOPTED_MODEL;
  analysisSha256?: string;
  manifestSha256?: string;
  materialized: number;
  reused: number;
  protected: number;
  terminalOnly: number;
  fields: number;
  completedAt: string;
}

export interface PreparedPromotionApplicationPrecomputeBundle {
  evidence: PromotionApplicationPrecomputeEvidence;
  analysisBody: Buffer;
  manifestBody: Buffer;
}

export function buildPromotionApplicationPrecomputeReceipt(input: {
  evidence: PromotionApplicationPrecomputeEvidence;
  applied: AppliedGrantApplicationPrecompute;
  completedAt?: Date;
}): PromotionApplicationPrecomputeReceipt {
  if (
    (input.evidence.status === "ready" || input.evidence.status === "conditional")
    && input.applied.materialized + input.applied.reused + input.applied.protected === 0
  ) {
    throw new Error(`Kordoc ready 증거가 있지만 반영된 지원 양식이 없습니다: ${input.evidence.grantId}`);
  }
  return {
    schema: "analysis-lab-application-precompute-receipt-v1",
    status: input.evidence.status,
    roundtripRunId: input.evidence.roundtripRunId,
    transport: input.evidence.transport,
    model: input.evidence.model,
    analysisSha256: input.evidence.analysisSha256,
    manifestSha256: input.evidence.manifestSha256,
    materialized: input.applied.materialized,
    reused: input.applied.reused,
    protected: input.applied.protected,
    terminalOnly: input.applied.terminalOnly,
    fields: input.applied.fields,
    completedAt: (input.completedAt ?? new Date()).toISOString(),
  };
}

export function verifyPromotionApplicationPrecomputeReceipt(input: {
  receipt: unknown;
  evidence: PromotionApplicationPrecomputeEvidence | undefined;
  observedFieldCount: number;
  observedFieldsReadySurfaceCount: number;
  observedArtifactCount: number;
}): string[] {
  if (!input.evidence) return [];
  const receipt = input.receipt as Partial<PromotionApplicationPrecomputeReceipt> | null;
  if (
    !receipt
    || receipt.schema !== "analysis-lab-application-precompute-receipt-v1"
    || receipt.status !== input.evidence.status
    || receipt.roundtripRunId !== input.evidence.roundtripRunId
    || receipt.transport !== input.evidence.transport
    || receipt.model !== input.evidence.model
    || receipt.analysisSha256 !== input.evidence.analysisSha256
    || receipt.manifestSha256 !== input.evidence.manifestSha256
  ) {
    return ["receipt_mismatch"];
  }
  if (input.evidence.status === "ready" || input.evidence.status === "conditional") {
    const appliedSurfaceCount = Number(receipt.materialized ?? 0)
      + Number(receipt.reused ?? 0)
      + Number(receipt.protected ?? 0);
    return [
      ...(appliedSurfaceCount > 0 ? [] : ["no_applied_surface"]),
      ...(input.observedFieldCount > 0 ? [] : ["no_materialized_fields"]),
      ...(input.observedFieldsReadySurfaceCount > 0 ? [] : ["no_fields_ready_surface"]),
      ...(input.observedArtifactCount > 0 ? [] : ["no_field_candidate_artifact"]),
    ];
  }
  return input.observedArtifactCount > 0 ? [] : ["no_terminal_artifact"];
}

/**
 * 고품질 구독 모델의 Kordoc 결과를 release 아래로 복제하고 내용 해시를 봉인한다.
 * clean worktree 승격은 원래 spike-out 위치가 아니라 이 번들만 읽는다.
 */
export async function preparePromotionApplicationPrecomputeBundle(input: {
  releaseId: string;
  labRun: LabRun;
  deepReceiptSha256: string;
}): Promise<PreparedPromotionApplicationPrecomputeBundle | null> {
  assertSafeReleaseSegment(input.releaseId, "releaseId");
  if (!isPublishableLabRun(input.labRun)) {
    throw new Error(`publishable이 아닌 LabRun은 Kordoc release에 결속할 수 없습니다: ${input.labRun.grantId}`);
  }
  const admission = await admitApplicationRoundtripRelease({
    grantId: input.labRun.grantId,
    deepReceiptSha256: input.deepReceiptSha256,
  });
  if (!admission) return null;
  const artifacts = await readRoundtripRunArtifacts(input.labRun.grantId, admission.runId);
  if (!artifacts) {
    throw new Error(`Kordoc 선분석 artifact를 release에 봉인할 수 없습니다: ${input.labRun.grantId}`);
  }
  const artifactPath = relative(findMonorepoRoot(), join(artifacts.dir, "analysis.json"))
    .split(sep).join("/");
  assertRoundtripProvenance(input.labRun, artifacts.run, artifacts.manifest, admission, artifactPath);

  const applicationDocuments = artifacts.run.documents.filter((document) =>
    document.role === "application_form"
    || document.role === "business_plan"
    || document.role === "mixed_form");
  const materializableDocuments = applicationDocuments.filter((document) => {
    const classification = classifyApplicationPrecomputeDocument(document);
    return classification.materialize
      && document.fieldPlanning.status === "llm"
      && document.fieldPlanning.transport === "claude-cli"
      && document.fieldPlanning.requestedModel === APPLICATION_ROUNDTRIP_ADOPTED_MODEL
      && (document.fieldPlanning.failureCode ?? null) === null;
  });
  const reviewRequiredDocumentCount = applicationDocuments.filter((document) =>
    classifyApplicationPrecomputeDocument(document).status === "review_required").length;
  const status = materializableDocuments.length > 0 ? admission.targetDisposition : null;
  if (status === null) {
    throw new Error(
      `고품질 구독 모델이 자동 materialize 가능한 Kordoc 필드를 확정하지 못했습니다: `
        + `${input.labRun.grantId} (사람 검수 대신 모델 재분석 대상으로 유지)`,
    );
  }

  const [analysisBody, manifestBody] = await Promise.all([
    readFile(join(artifacts.dir, "analysis.json")),
    readFile(join(artifacts.dir, "manifest.json")),
  ]);
  if (sha256(analysisBody) !== admission.runArtifactSha256) {
    throw new Error(`Kordoc canary receipt와 run artifact hash가 다릅니다: ${input.labRun.grantId}`);
  }
  const evidence: PromotionApplicationPrecomputeEvidence = {
    schema: PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA,
    releaseId: input.releaseId,
    grantId: input.labRun.grantId,
    parentLabRunId: input.labRun.runId,
    roundtripRunId: artifacts.run.runId,
    status,
    transport: "claude-cli",
    model: APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
    analysisSha256: sha256(analysisBody),
    manifestSha256: sha256(manifestBody),
    sourceCount: artifacts.run.sourceCount ?? artifacts.run.documents.length,
    documentCount: artifacts.run.documents.length,
    materializableDocumentCount: materializableDocuments.length,
    reviewRequiredDocumentCount,
    canaryAdmission: {
      receiptSchema: admission.receiptSchema,
      admissionReceiptSha256: admission.admissionReceiptSha256,
      canaryReceiptSha256: admission.canaryReceiptSha256,
      proposalSha256: admission.proposalSha256,
      proposalGitSha: admission.proposalGitSha,
      policyGitSha: admission.policyGitSha,
      sequence: admission.sequence,
      deepReceiptSha256: admission.deepReceiptSha256,
      sourceSha256s: [...admission.sourceSha256s],
      runArtifactPath: admission.runArtifactPath,
      runArtifactSha256: admission.runArtifactSha256,
      targetDisposition: admission.targetDisposition,
      cohortVerdict: admission.cohortVerdict,
      reasonCodes: admission.reasonCodes,
    },
  };
  return { evidence, analysisBody, manifestBody };
}

export async function writePreparedPromotionApplicationPrecomputeBundle(
  prepared: PreparedPromotionApplicationPrecomputeBundle,
): Promise<void> {
  const dir = promotionApplicationPrecomputeDir(
    prepared.evidence.releaseId,
    prepared.evidence.grantId,
  );
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeImmutable(join(dir, "analysis.json"), prepared.analysisBody),
    writeImmutable(join(dir, "manifest.json"), prepared.manifestBody),
  ]);
}

export async function bundlePromotionApplicationPrecompute(input: {
  releaseId: string;
  labRun: LabRun;
  deepReceiptSha256: string;
}): Promise<PromotionApplicationPrecomputeEvidence | null> {
  const prepared = await preparePromotionApplicationPrecomputeBundle(input);
  if (!prepared) return null;
  await writePreparedPromotionApplicationPrecomputeBundle(prepared);
  return prepared.evidence;
}

/** release에 봉인된 Kordoc 산출물만 읽고 해시·provenance를 다시 검증한다. */
export async function readBundledPromotionApplicationPrecompute(
  evidence: PromotionApplicationPrecomputeEvidence,
): Promise<BundledPromotionApplicationPrecompute> {
  validatePromotionApplicationPrecomputeEvidence(evidence);
  const dir = promotionApplicationPrecomputeDir(evidence.releaseId, evidence.grantId);
  const [analysisBody, manifestBody] = await Promise.all([
    readFile(join(dir, "analysis.json")),
    readFile(join(dir, "manifest.json")),
  ]);
  if (
    sha256(analysisBody) !== evidence.analysisSha256
    || sha256(manifestBody) !== evidence.manifestSha256
  ) {
    throw new Error(`release Kordoc artifact hash가 일치하지 않습니다: ${evidence.grantId}`);
  }
  const run = JSON.parse(analysisBody.toString("utf8")) as ApplicationRoundtripRun;
  const manifest = JSON.parse(manifestBody.toString("utf8")) as RoundtripRunManifest;
  if (
    run.version !== APPLICATION_ROUNDTRIP_VERSION
    || run.runId !== evidence.roundtripRunId
    || run.grantId !== evidence.grantId
    || run.transport !== evidence.transport
    || run.requestedModel !== evidence.model
    || manifest.runId !== run.runId
    || manifest.grantId !== run.grantId
  ) {
    throw new Error(`release Kordoc artifact provenance가 일치하지 않습니다: ${evidence.grantId}`);
  }
  if (
    evidence.schema === LEGACY_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
    && run.parentLabRunId !== evidence.parentLabRunId
  ) {
    throw new Error(`legacy release Kordoc parent provenance가 일치하지 않습니다: ${evidence.grantId}`);
  }
  if (evidence.canaryAdmission) {
    const sourceSha256s = manifest.attachments.map((attachment) => attachment.sourceSha256);
    if (
      evidence.canaryAdmission.runArtifactSha256 !== evidence.analysisSha256
      || evidence.canaryAdmission.targetDisposition !== evidence.status
      || !sameSet(evidence.canaryAdmission.sourceSha256s, sourceSha256s)
    ) {
      throw new Error(`release Kordoc receipt admission이 artifact와 일치하지 않습니다: ${evidence.grantId}`);
    }
  }
  return { run, manifest };
}

export function validatePromotionApplicationPrecomputeEvidence(
  value: unknown,
): asserts value is PromotionApplicationPrecomputeEvidence {
  if (!value || typeof value !== "object") throw new Error("Kordoc release evidence가 객체가 아닙니다.");
  const evidence = value as Partial<PromotionApplicationPrecomputeEvidence>;
  if (
    evidence.schema !== PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
      && evidence.schema !== LEGACY_PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA
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
  } else if (evidence.status === "conditional" || evidence.canaryAdmission !== undefined) {
    throw new Error("legacy Kordoc release evidence에는 canary admission을 기록할 수 없습니다.");
  }
  assertSafeReleaseSegment(evidence.releaseId, "releaseId");
  assertSafeReleaseSegment(evidence.grantId, "grantId");
}

function assertRoundtripProvenance(
  labRun: LabRun,
  run: ApplicationRoundtripRun,
  manifest: RoundtripRunManifest,
  admission: ApplicationRoundtripReleaseAdmission,
  artifactPath: string,
): void {
  const manifestSourceSha256s = manifest.attachments.map((attachment) => attachment.sourceSha256);
  if (
    !isPublishableLabRun(labRun)
    || run.version !== APPLICATION_ROUNDTRIP_VERSION
    || run.grantId !== labRun.grantId
    || run.transport !== "claude-cli"
    || run.requestedModel !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
    || run.error !== null
    || (run.failureCode ?? null) !== null
    || manifest.runId !== run.runId
    || manifest.grantId !== run.grantId
    || manifest.source !== run.source
    || manifest.sourceId !== run.sourceId
    || admission.grantId !== labRun.grantId
    || admission.runId !== run.runId
    || admission.runArtifactPath !== artifactPath
    || !sameSet(admission.sourceSha256s, manifestSourceSha256s)
  ) {
    throw new Error(`Kordoc 고품질 모델 provenance가 release 기준을 충족하지 않습니다: ${labRun.grantId}`);
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

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length
    && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function promotionApplicationPrecomputeDir(releaseId: string, grantId: string): string {
  assertSafeReleaseSegment(releaseId, "releaseId");
  assertSafeReleaseSegment(grantId, "grantId");
  return join(analysisLabDir(), "releases", releaseId, "application-precompute", grantId);
}

async function writeImmutable(path: string, body: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { flag: "wx" });
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
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
