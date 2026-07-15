import {
  CRITERION_DIMENSIONS,
  type CompanyProfile,
  type CriterionDimension,
  type GrantCriterion,
  type MatchResult,
  type NormalizedGrant,
} from "@cunote/contracts";
import {
  createGrantAnalysisPilotVariant,
  grantAnalysisCriterionHasEvidence,
  matchNormalizedGrant,
  withMatchRanking,
  type GrantAnalysisAxisAssessmentInput,
  type GrantAnalysisInputArtifact,
  type GrantAnalysisPilotVariant,
  type GrantAnalysisPilotVariantId,
} from "@cunote/core";
import type { PilotAxisObservation } from "./grantAnalysisPilotExtractor";
import type { GrantAnalysisPilotInputs } from "./grantAnalysisPilotInputs";

export function buildGrantAnalysisPilotVariant(options: {
  variant: GrantAnalysisPilotVariantId;
  entry: NormalizedGrant<unknown>;
  inputs: GrantAnalysisPilotInputs;
  criteria: readonly GrantCriterion[];
  axes?: readonly PilotAxisObservation[];
  extractorVersion: string;
}): GrantAnalysisPilotVariant {
  const inputArtifacts = buildGrantAnalysisInputArtifacts({
    entry: options.entry,
    inputs: options.inputs,
    variant: options.variant,
  });
  const missingInputCount = inputArtifacts.filter((artifact) => !artifact.included).length;
  return createGrantAnalysisPilotVariant({
    variant: options.variant,
    grantId: `${options.entry.grant.source}:${options.entry.grant.source_id}`,
    sourceRevision: options.inputs.sourceRevision,
    extractorVersion: options.extractorVersion,
    inputs: inputArtifacts,
    axes: options.axes
      ? buildExtractedAxisAssessments(options.criteria, options.axes, {
        inputInspectionComplete: missingInputCount === 0,
        missingInputCount,
      })
      : buildCurrentAxisAssessments(options.criteria),
  });
}

export function buildCurrentAxisAssessments(
  criteria: readonly GrantCriterion[],
): GrantAnalysisAxisAssessmentInput[] {
  return CRITERION_DIMENSIONS.map((dimension) => {
    if (isReserved(dimension)) return reservedAssessment(dimension);
    const dimensionCriteria = criteria.filter((criterion) => criterion.dimension === dimension);
    if (dimensionCriteria.length === 0) {
      return { dimension, state: "not_inspected", criteria: [] };
    }
    return assessmentFromCriteria(dimension, dimensionCriteria, "현재 추출 결과");
  });
}

export function buildExtractedAxisAssessments(
  criteria: readonly GrantCriterion[],
  observations: readonly PilotAxisObservation[],
  inputCoverage: { inputInspectionComplete: boolean; missingInputCount: number } = {
    inputInspectionComplete: true,
    missingInputCount: 0,
  },
): GrantAnalysisAxisAssessmentInput[] {
  const byDimension = new Map(observations.map((observation) => [observation.dimension, observation]));
  return CRITERION_DIMENSIONS.map((dimension) => {
    if (isReserved(dimension)) return reservedAssessment(dimension);
    const dimensionCriteria = criteria.filter((criterion) => criterion.dimension === dimension);
    const observation = byDimension.get(dimension);
    const note = [observation?.note, ...(observation?.issues ?? [])].filter(Boolean).join(" | ");
    if (dimensionCriteria.length > 0) {
      return assessmentFromCriteria(dimension, dimensionCriteria, note || "LLM 추출 결과");
    }
    switch (observation?.effectiveStatus) {
      case "inspected_no_condition":
        return inputCoverage.inputInspectionComplete
          ? { dimension, state: "explicit_no_condition", criteria: [], ...(note ? { note } : {}) }
          : {
            dimension,
            state: "not_inspected",
            criteria: [],
            note: [
              note,
              `전체 공고 기준 입력 ${inputCoverage.missingInputCount}개가 미포함되어 조건 부재를 확정하지 않았습니다.`,
            ].filter(Boolean).join(" | "),
          };
      case "ambiguous":
      case "condition_found":
        return {
          dimension,
          state: "failed",
          criteria: [],
          note: note || `${observation.effectiveStatus} 상태지만 검증 가능한 criterion이 없습니다.`,
        };
      case "input_missing":
      case "not_returned":
      default:
        return { dimension, state: "not_inspected", criteria: [], ...(note ? { note } : {}) };
    }
  });
}

export function buildGrantAnalysisInputArtifacts(options: {
  entry: NormalizedGrant<unknown>;
  inputs: GrantAnalysisPilotInputs;
  variant: GrantAnalysisPilotVariantId;
}): GrantAnalysisInputArtifact[] {
  const artifacts: GrantAnalysisInputArtifact[] = [{
    inputId: `api:${options.entry.grant.source}:${options.entry.grant.source_id}`,
    kind: "api_text",
    fetched: true,
    converted: true,
    included: true,
  }];
  const attachments = options.entry.raw.attachments ?? [];
  const includedFilenameCounts = countFilenames(options.inputs.attachments.includedAttachments.map((entry) => entry.filename));
  const currentEvidenceFilenameCounts = countFilenames(options.entry.criteria.flatMap((criterion) => {
    const prefix = "attachment:";
    return criterion.source_field?.startsWith(prefix) ? [criterion.source_field.slice(prefix.length)] : [];
  }));

  attachments.forEach((attachment, index) => {
    const fetched = hasStableArchiveIdentity(attachment);
    const declaredConverted = attachment.conversion?.status === "converted" &&
      validStorageKey(attachment.conversion.markdown_storage_key);
    const converted = fetched && declaredConverted;
    const requestedIncluded = options.variant === "C"
      ? consumeFilename(includedFilenameCounts, attachment.filename)
      : options.variant === "A"
        ? consumeFilename(currentEvidenceFilenameCounts, attachment.filename)
        : false;
    const included = converted && requestedIncluded;
    const failure = attachmentFailure(attachment, fetched, declaredConverted);
    artifacts.push({
      inputId: `attachment:${index + 1}:${attachment.filename}`,
      kind: "attachment",
      fetched,
      converted,
      included,
      ...(failure && !included ? { failure } : {}),
    });
  });

  const missingCount = Math.max(0, options.inputs.attachments.counts.expected - attachments.length);
  for (let index = 0; index < missingCount; index += 1) {
    artifacts.push({
      inputId: `attachment:missing:${index + 1}`,
      kind: "attachment",
      fetched: false,
      converted: false,
      included: false,
      failure: "Expected attachment is absent from the archived input inventory.",
    });
  }
  return artifacts;
}

export function buildGrantAnalysisShadowMatch(options: {
  entry: NormalizedGrant<unknown>;
  criteria: readonly GrantCriterion[];
  company: CompanyProfile;
  asOf: Date;
}): MatchResult {
  const { extraction_manifest: _currentManifest, ...entryWithoutManifest } = options.entry;
  const proposed: NormalizedGrant<unknown> = {
    ...entryWithoutManifest,
    criteria: options.criteria.map((criterion) => ({ ...criterion })),
  };
  return withMatchRanking(
    proposed,
    options.company,
    matchNormalizedGrant(proposed, options.company),
    { asOf: options.asOf },
  );
}

function assessmentFromCriteria(
  dimension: CriterionDimension,
  criteria: readonly GrantCriterion[],
  note: string,
): GrantAnalysisAxisAssessmentInput {
  const hasTextOnly = criteria.some((criterion) => criterion.operator === "text_only");
  const allEvidenceBacked = criteria.every(grantAnalysisCriterionHasEvidence);
  if (!allEvidenceBacked && hasTextOnly) {
    return {
      dimension,
      state: "failed",
      criteria: [],
      note: `${note} | text_only와 근거 누락 criterion이 혼재해 축 판정을 보류했습니다.`,
    };
  }
  if (hasTextOnly) return { dimension, state: "text_only", criteria: [...criteria], note };
  if (!allEvidenceBacked) return { dimension, state: "evidence_missing", criteria: [...criteria], note };
  return { dimension, state: "structured", criteria: [...criteria], note };
}

function reservedAssessment(
  dimension: "premises" | "export_performance",
): GrantAnalysisAxisAssessmentInput {
  return { dimension, state: "reserved", criteria: [], note: "현재 프로필·판정 파이프라인 예약 축" };
}

function isReserved(dimension: CriterionDimension): dimension is "premises" | "export_performance" {
  return dimension === "premises" || dimension === "export_performance";
}

function countFilenames(filenames: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const filename of filenames) counts.set(filename, (counts.get(filename) ?? 0) + 1);
  return counts;
}

function consumeFilename(counts: Map<string, number>, filename: string): boolean {
  const count = counts.get(filename) ?? 0;
  if (count <= 0) return false;
  counts.set(filename, count - 1);
  return true;
}

function hasStableArchiveIdentity(
  attachment: NonNullable<NormalizedGrant<unknown>["raw"]["attachments"]>[number],
): boolean {
  return Boolean(attachment.storage_key?.trim() && attachment.sha256?.trim());
}

function validStorageKey(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") && !value.split("/").includes("..");
}

function attachmentFailure(
  attachment: NonNullable<NormalizedGrant<unknown>["raw"]["attachments"]>[number],
  fetched: boolean,
  declaredConverted: boolean,
): string | null {
  if (attachment.conversion?.status === "failed") {
    return attachment.conversion.error?.trim().slice(0, 300) || "Attachment conversion failed.";
  }
  if (attachment.conversion?.status === "converted" && !declaredConverted) {
    return "Converted attachment has no readable markdown storage key.";
  }
  if (declaredConverted && !fetched) {
    return "Converted attachment has no stable archived source identity.";
  }
  return null;
}
