import { createHash } from "node:crypto";
import type { GrantAuthoringGuideV1 } from "@cunote/contracts";
import type { LabRun } from "./lab-contract";
import { buildGrantAuthoringGuide } from "./authoring-guide";
import { isPublishableLabRun } from "./run-outcome";
import { convertSelectedLabCriteria } from "./shadow-convert";

export const AUTHORING_GUIDE_ADOPTION_SCHEMA = "authoring-guide-adoption-manifest-v1" as const;

export type AuthoringGuideAdoptionDisposition =
  | "projection_ready"
  | "review_required"
  | "source_recovery_required"
  | "rerun_required";

export type AuthoringGuideAdoptionReason =
  | "current_source_unsealed"
  | "input_sha256_drift"
  | "attachment_manifest_sha256_drift"
  | "program_intent_missing"
  | "criteria_missing"
  | "criterion_source_span_missing_or_unverified"
  | "criterion_projection_failed";

export interface AuthoringGuideAdoptionCandidate {
  readonly grantId: string;
  readonly source: string;
  readonly sourceId: string;
  readonly title: string;
  readonly run: LabRun;
  readonly runArtifactPath: string;
  readonly runArtifactSha256: string;
  readonly current: {
    readonly inputSha256: string;
    readonly attachmentManifestSha256: string;
    readonly sourceRevisionSha256: string;
    readonly sourceSealed: boolean;
    readonly operationalInputSha256: string;
    readonly operationalAttachmentManifestSha256: string;
    readonly sourceBlockers: readonly {
      readonly code: string;
      readonly attachmentId: string | null;
      readonly message: string;
    }[];
  };
}

export interface AuthoringGuideAdoptionManifestItem {
  readonly grantId: string;
  readonly source: string;
  readonly sourceId: string;
  readonly title: string;
  readonly disposition: AuthoringGuideAdoptionDisposition;
  readonly reasons: readonly AuthoringGuideAdoptionReason[];
  readonly requiresReleaseValidation: true;
  readonly advisoryPreviewOnly: true;
  readonly run: {
    readonly runId: string;
    readonly artifactPath: string;
    readonly artifactSha256: string;
    readonly inputSha256: string;
    readonly attachmentManifestSha256: string | null;
  };
  readonly current: {
    readonly inputSha256: string;
    readonly attachmentManifestSha256: string;
    readonly sourceRevisionSha256: string;
    readonly sourceSealed: boolean;
    readonly operationalInputSha256: string;
    readonly operationalAttachmentManifestSha256: string;
    readonly sourceBlockers: readonly {
      readonly code: string;
      readonly attachmentId: string | null;
      readonly message: string;
    }[];
  };
  readonly evidence: {
    readonly programIntentPresent: boolean;
    readonly criterionCount: number;
    readonly verifiedSourceSpanCount: number;
    readonly projectedCriterionCount: number;
  };
  readonly authoringGuidePreview: GrantAuthoringGuideV1 | null;
}

export interface AuthoringGuideAdoptionManifest {
  readonly schema: typeof AUTHORING_GUIDE_ADOPTION_SCHEMA;
  readonly preparedAt: string;
  readonly asOfKst: string;
  readonly execution: {
    readonly mode: "offline_read_only";
    readonly modelCallsMade: 0;
    readonly databaseWritesMade: 0;
    readonly promotionAuthorized: false;
  };
  readonly population: {
    readonly strictEligibleGrantCount: number;
    readonly historicalPublishableRunCount: number;
  };
  readonly summary: {
    readonly projectionReady: number;
    readonly reviewRequired: number;
    readonly sourceRecoveryRequired: number;
    readonly rerunRequired: number;
  };
  readonly items: readonly AuthoringGuideAdoptionManifestItem[];
}

export function isExplicitAuthoringGuideAdoptionRun(
  run: Pick<LabRun, "primaryValidationOutcome" | "error">,
): boolean {
  return run.primaryValidationOutcome === "publishable" && isPublishableLabRun(run);
}

export function createAuthoringGuideAdoptionManifest(input: {
  readonly preparedAt: Date;
  readonly asOfKst: string;
  readonly strictEligibleGrantCount: number;
  readonly candidates: readonly AuthoringGuideAdoptionCandidate[];
}): AuthoringGuideAdoptionManifest {
  const preparedAt = input.preparedAt.toISOString();
  if (!Number.isFinite(Date.parse(preparedAt))) throw new Error("preparedAt이 잘못됐습니다.");
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(input.asOfKst)) throw new Error("asOfKst가 잘못됐습니다.");
  if (!Number.isSafeInteger(input.strictEligibleGrantCount) || input.strictEligibleGrantCount < 0) {
    throw new Error("strictEligibleGrantCount가 잘못됐습니다.");
  }

  const sortedCandidates = [...input.candidates].sort((left, right) => (
    left.grantId.localeCompare(right.grantId, "en")
  ));
  if (new Set(sortedCandidates.map((candidate) => candidate.grantId)).size !== sortedCandidates.length) {
    throw new Error("adoption candidate grantId가 중복됐습니다.");
  }
  const items = sortedCandidates.map(classifyAuthoringGuideAdoptionCandidate);

  return Object.freeze({
    schema: AUTHORING_GUIDE_ADOPTION_SCHEMA,
    preparedAt,
    asOfKst: input.asOfKst,
    execution: Object.freeze({
      mode: "offline_read_only",
      modelCallsMade: 0,
      databaseWritesMade: 0,
      promotionAuthorized: false,
    }),
    population: Object.freeze({
      strictEligibleGrantCount: input.strictEligibleGrantCount,
      historicalPublishableRunCount: items.length,
    }),
    summary: Object.freeze({
      projectionReady: items.filter((item) => item.disposition === "projection_ready").length,
      reviewRequired: items.filter((item) => item.disposition === "review_required").length,
      sourceRecoveryRequired: items.filter(
        (item) => item.disposition === "source_recovery_required",
      ).length,
      rerunRequired: items.filter((item) => item.disposition === "rerun_required").length,
    }),
    items: Object.freeze(items),
  });
}

export function classifyAuthoringGuideAdoptionCandidate(
  candidate: AuthoringGuideAdoptionCandidate,
): AuthoringGuideAdoptionManifestItem {
  requireSha(candidate.run.inputSha256, "run.inputSha256");
  if (candidate.run.attachmentManifestSha256 !== undefined) {
    requireSha(candidate.run.attachmentManifestSha256, "run.attachmentManifestSha256");
  }
  requireSha(candidate.runArtifactSha256, "runArtifactSha256");
  requireSha(candidate.current.inputSha256, "current.inputSha256");
  requireSha(candidate.current.attachmentManifestSha256, "current.attachmentManifestSha256");
  requireSha(candidate.current.sourceRevisionSha256, "current.sourceRevisionSha256");
  requireSha(candidate.current.operationalInputSha256, "current.operationalInputSha256");
  requireSha(
    candidate.current.operationalAttachmentManifestSha256,
    "current.operationalAttachmentManifestSha256",
  );
  if (candidate.current.sourceSealed === (candidate.current.sourceBlockers.length > 0)) {
    throw new Error(`source seal과 blocker 결속이 잘못됐습니다: ${candidate.grantId}`);
  }
  const reasons: AuthoringGuideAdoptionReason[] = [];
  if (!candidate.current.sourceSealed) reasons.push("current_source_unsealed");
  if (candidate.run.inputSha256 !== candidate.current.inputSha256) {
    reasons.push("input_sha256_drift");
  }
  if (
    candidate.run.attachmentManifestSha256
    !== candidate.current.attachmentManifestSha256
  ) {
    reasons.push("attachment_manifest_sha256_drift");
  }
  if (!candidate.run.programIntent) reasons.push("program_intent_missing");

  const verifiedSourceSpanCount = candidate.run.criteria.filter((criterion) => (
    criterion.spanVerified
    && typeof criterion.sourceSpan === "string"
    && criterion.sourceSpan.trim().length > 0
  )).length;
  if (candidate.run.criteria.length === 0) {
    reasons.push("criteria_missing");
  } else if (verifiedSourceSpanCount !== candidate.run.criteria.length) {
    reasons.push("criterion_source_span_missing_or_unverified");
  }
  const conversion = convertSelectedLabCriteria(candidate.run, {
    selections: candidate.run.criteria.map((_, criterionIndex) => ({
      criterionIndex,
      needsReview: false,
    })),
  });
  if (conversion.report.error !== null) reasons.push("criterion_projection_failed");

  const rerunReasons = new Set<AuthoringGuideAdoptionReason>([
    "input_sha256_drift",
    "attachment_manifest_sha256_drift",
    "program_intent_missing",
  ]);
  let disposition: AuthoringGuideAdoptionDisposition = "projection_ready";
  if (reasons.some((reason) => rerunReasons.has(reason))) {
    disposition = "rerun_required";
  } else if (reasons.includes("current_source_unsealed")) {
    disposition = "source_recovery_required";
  } else if (reasons.length > 0) {
    disposition = "review_required";
  }
  const currentBindingMatches = !reasons.includes("current_source_unsealed")
    && !reasons.includes("input_sha256_drift")
    && !reasons.includes("attachment_manifest_sha256_drift");
  const authoringGuidePreview = currentBindingMatches
    ? buildGrantAuthoringGuide({
      run: {
        ...candidate.run,
        sourceRevisionSha256: candidate.current.sourceRevisionSha256,
      },
      criteria: conversion.criteria,
    })
    : null;

  return Object.freeze({
    grantId: candidate.grantId,
    source: candidate.source,
    sourceId: candidate.sourceId,
    title: candidate.title,
    disposition,
    reasons: Object.freeze(reasons),
    requiresReleaseValidation: true,
    advisoryPreviewOnly: true,
    run: Object.freeze({
      runId: candidate.run.runId,
      artifactPath: candidate.runArtifactPath,
      artifactSha256: candidate.runArtifactSha256,
      inputSha256: candidate.run.inputSha256,
      attachmentManifestSha256: candidate.run.attachmentManifestSha256 ?? null,
    }),
    current: Object.freeze({
      ...candidate.current,
      sourceBlockers: Object.freeze(candidate.current.sourceBlockers.map((blocker) => (
        Object.freeze({ ...blocker })
      ))),
    }),
    evidence: Object.freeze({
      programIntentPresent: candidate.run.programIntent !== null,
      criterionCount: candidate.run.criteria.length,
      verifiedSourceSpanCount,
      projectedCriterionCount: conversion.criteria.length,
    }),
    authoringGuidePreview,
  });
}

export function hashAuthoringGuideAdoptionManifest(
  manifest: AuthoringGuideAdoptionManifest,
): string {
  return createHash("sha256").update(encodeAuthoringGuideAdoptionManifest(manifest)).digest("hex");
}

export function encodeAuthoringGuideAdoptionManifest(
  manifest: AuthoringGuideAdoptionManifest,
): Buffer {
  return Buffer.from(`${canonicalJson(manifest)}\n`, "utf8");
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical JSON에 유한하지 않은 숫자가 있습니다.");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error(`canonical JSON에 지원하지 않는 값이 있습니다: ${typeof value}`);
}

function requireSha(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/u.test(value)) throw new Error(`${label}가 SHA-256이 아닙니다.`);
  return value;
}
