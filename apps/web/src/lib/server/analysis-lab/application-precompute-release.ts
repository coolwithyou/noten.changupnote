import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  APPLICATION_ROUNDTRIP_ADOPTED_MODEL,
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import type { LabRun } from "@/features/dev/analysis-lab/contract";
import {
  classifyApplicationPrecomputeDocument,
  type AppliedGrantApplicationPrecompute,
} from "../documents/applicationPrecomputeMaterialization";
import {
  readRoundtripRunArtifacts,
  type RoundtripRunManifest,
} from "./application-roundtrip/store";
import { analysisLabDir } from "./run-store";

export const PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA =
  "promotion-application-precompute-v1" as const;

export interface PromotionApplicationPrecomputeEvidence {
  schema: typeof PROMOTION_APPLICATION_PRECOMPUTE_SCHEMA;
  releaseId: string;
  grantId: string;
  parentLabRunId: string;
  roundtripRunId: string;
  status: "ready" | "not_applicable";
  transport: "claude-cli";
  model: typeof APPLICATION_ROUNDTRIP_ADOPTED_MODEL;
  analysisSha256: string;
  manifestSha256: string;
  sourceCount: number;
  documentCount: number;
  materializableDocumentCount: number;
  reviewRequiredDocumentCount: number;
}

export interface BundledPromotionApplicationPrecompute {
  run: ApplicationRoundtripRun;
  manifest: RoundtripRunManifest;
}

export interface PromotionApplicationPrecomputeReceipt {
  schema: "analysis-lab-application-precompute-receipt-v1";
  status: "ready" | "not_applicable";
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

export function buildPromotionApplicationPrecomputeReceipt(input: {
  evidence: PromotionApplicationPrecomputeEvidence;
  applied: AppliedGrantApplicationPrecompute;
  completedAt?: Date;
}): PromotionApplicationPrecomputeReceipt {
  if (
    input.evidence.status === "ready"
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
  if (input.evidence.status === "ready") {
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
export async function bundlePromotionApplicationPrecompute(input: {
  releaseId: string;
  labRun: LabRun;
}): Promise<PromotionApplicationPrecomputeEvidence | null> {
  assertSafeReleaseSegment(input.releaseId, "releaseId");
  const reference = input.labRun.applicationRoundtrip;
  if (!reference?.runId) return null;
  if (
    reference.transport !== "claude-cli"
    || reference.model !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
  ) {
    throw new Error(
      `Kordoc release는 ${APPLICATION_ROUNDTRIP_ADOPTED_MODEL} claude-cli 증거가 필요합니다: `
        + input.labRun.grantId,
    );
  }
  const artifacts = await readRoundtripRunArtifacts(input.labRun.grantId, reference.runId);
  if (!artifacts) {
    throw new Error(`Kordoc 선분석 artifact를 release에 봉인할 수 없습니다: ${input.labRun.grantId}`);
  }
  assertRoundtripProvenance(input.labRun, artifacts.run, artifacts.manifest);

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
  const status = materializableDocuments.length > 0
    ? "ready"
    : applicationDocuments.length === 0
      ? "not_applicable"
      : null;
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
  const dir = promotionApplicationPrecomputeDir(input.releaseId, input.labRun.grantId);
  await mkdir(dir, { recursive: true });
  await Promise.all([
    writeImmutable(join(dir, "analysis.json"), analysisBody),
    writeImmutable(join(dir, "manifest.json"), manifestBody),
  ]);

  return {
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
  };
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
    || run.parentLabRunId !== evidence.parentLabRunId
    || run.transport !== evidence.transport
    || run.requestedModel !== evidence.model
    || manifest.runId !== run.runId
    || manifest.grantId !== run.grantId
  ) {
    throw new Error(`release Kordoc artifact provenance가 일치하지 않습니다: ${evidence.grantId}`);
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
    || typeof evidence.releaseId !== "string"
    || typeof evidence.grantId !== "string"
    || typeof evidence.parentLabRunId !== "string"
    || typeof evidence.roundtripRunId !== "string"
    || (evidence.status !== "ready" && evidence.status !== "not_applicable")
    || evidence.transport !== "claude-cli"
    || evidence.model !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
    || !isSha256(evidence.analysisSha256)
    || !isSha256(evidence.manifestSha256)
    || !isNonnegativeInteger(evidence.sourceCount)
    || !isNonnegativeInteger(evidence.documentCount)
    || !isNonnegativeInteger(evidence.materializableDocumentCount)
    || !isNonnegativeInteger(evidence.reviewRequiredDocumentCount)
    || (evidence.status === "ready" && evidence.materializableDocumentCount === 0)
  ) {
    throw new Error("Kordoc release evidence 형식이 올바르지 않습니다.");
  }
  assertSafeReleaseSegment(evidence.releaseId, "releaseId");
  assertSafeReleaseSegment(evidence.grantId, "grantId");
}

function assertRoundtripProvenance(
  labRun: LabRun,
  run: ApplicationRoundtripRun,
  manifest: RoundtripRunManifest,
): void {
  if (
    run.version !== APPLICATION_ROUNDTRIP_VERSION
    || run.grantId !== labRun.grantId
    || run.parentLabRunId !== labRun.runId
    || run.transport !== "claude-cli"
    || run.requestedModel !== APPLICATION_ROUNDTRIP_ADOPTED_MODEL
    || run.error !== null
    || (run.failureCode ?? null) !== null
    || manifest.runId !== run.runId
    || manifest.grantId !== run.grantId
    || manifest.source !== run.source
    || manifest.sourceId !== run.sourceId
  ) {
    throw new Error(`Kordoc 고품질 모델 provenance가 release 기준을 충족하지 않습니다: ${labRun.grantId}`);
  }
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
