import { DEEP_ANALYSIS_DEFAULT_LIMITS } from "@cunote/contracts";

import type * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { hashGrantRawPayload } from "@/lib/server/ingestion/grantRawHash";
import {
  AGGREGATE_SPLIT_MANIFEST_SCHEMA,
  AGGREGATE_SPLIT_MAP_PROMPT_VERSION,
  AGGREGATE_SPLIT_SYNTHESIS_PROMPT_VERSION,
  type AggregateSplitManifest,
  type AggregateSplitProgram,
  type AggregateSplitSegment,
} from "./aggregateSplitManifest";
import {
  DEEP_ANALYSIS_INPUT_SCHEMA,
  sealDeepAnalysisInput,
  type DeepAnalysisInputChunk,
  type DeepAnalysisInputSeal,
} from "./inputManifest";
import {
  buildAttachmentManifestSha256,
  buildDeepAnalysisSourceRevision,
  sha256Hex,
  stableJson,
} from "./sourceRevision";

export const AGGREGATE_SPLIT_CHILD_PROJECTION_SCHEMA =
  "aggregate-split-child-projection-v1" as const;
export const AGGREGATE_SPLIT_CHILD_SOURCE_SCHEMA =
  "aggregate-split-child-source-v1" as const;

type ParentGrant = typeof schema.grants.$inferSelect;

interface AggregateSplitParentGrantSnapshot {
  source: ParentGrant["source"];
  sourceId: string;
  url: string | null;
  agencyJurisdiction: string | null;
  agencyOperator: string | null;
  agencyPrimary: string | null;
  categoryL1: string | null;
  categoryL2: string | null;
  applyStart: string | null;
  applyEnd: string | null;
  applyMethod: Record<string, string | null> | null;
  status: ParentGrant["status"];
}

export interface AggregateSplitCompletedCaseIdentity {
  id: string;
  grantId: string;
  sourceRevisionSha256: string;
  inputArtifactKey: string;
  inputSha256: string;
  manifestArtifactKey: string;
  manifestSha256: string;
  model: string;
  segmentCount: number;
  programCount: number;
}

export interface ValidatedAggregateSplitBundle {
  manifest: AggregateSplitManifest;
  parentInput: {
    grantId: string;
    sourceRevisionSha256: string;
    inputSha256: string;
    attachmentManifestSha256: string;
    totalChars: number;
    chunks: DeepAnalysisInputChunk[];
    grantSnapshot: AggregateSplitParentGrantSnapshot;
  };
  segments: AggregateSplitSegment[];
}

export interface AggregateSplitChildDraft {
  stableKey: string;
  ordinal: number;
  source: ParentGrant["source"];
  sourceId: string;
  title: string;
  agencyPrimary: string | null;
  grantProjection: Record<string, unknown>;
  grantProjectionSha256: string;
  manifestSha256: string;
  sourceRevisionSha256: string;
  rawPayloadSha256: string;
  rawPayload: Record<string, unknown>;
  grantSourceFields: Record<string, unknown>;
}

/**
 * E-2 산출물의 DB identity, R2 readback hash, 입력 chunk, 최종 segment partition을
 * 소비 시점에 모두 다시 검증한다. 호출자는 이 함수가 반환한 segment text만 사용할 수 있다.
 */
export async function loadValidatedAggregateSplitBundle(input: {
  storage: R2ObjectStorage;
  splitCase: AggregateSplitCompletedCaseIdentity;
  maxChildInputChars?: number;
}): Promise<ValidatedAggregateSplitBundle> {
  assertCompletedCaseIdentity(input.splitCase);
  const [inputArtifactBody, manifestArtifactBody] = await Promise.all([
    input.storage.getObjectText(input.splitCase.inputArtifactKey),
    input.storage.getObjectText(input.splitCase.manifestArtifactKey),
  ]);
  if (sha256Hex(inputArtifactBody) !== input.splitCase.inputSha256) {
    throw materializationError(
      "aggregate_split_input_artifact_hash_mismatch",
      "분리 input artifact readback hash가 DB identity와 다릅니다.",
    );
  }
  if (sha256Hex(manifestArtifactBody) !== input.splitCase.manifestSha256) {
    throw materializationError(
      "aggregate_split_manifest_artifact_hash_mismatch",
      "분리 manifest artifact readback hash가 DB identity와 다릅니다.",
    );
  }

  const parentInput = parseAndValidateParentInputArtifact(
    inputArtifactBody,
    input.splitCase,
  );
  const manifest = parseAggregateSplitManifest(manifestArtifactBody);
  const segments = validateAggregateSplitManifestForMaterialization({
    manifest,
    parentInput,
    splitCase: input.splitCase,
    maxChildInputChars: input.maxChildInputChars
      ?? DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
  });
  return { manifest, parentInput, segments };
}

export function buildAggregateSplitChildDrafts(input: {
  splitCase: AggregateSplitCompletedCaseIdentity;
  bundle: ValidatedAggregateSplitBundle;
}): AggregateSplitChildDraft[] {
  const parentGrant = input.bundle.parentInput.grantSnapshot;
  const segmentById = new Map(
    input.bundle.segments.map((segment) => [segment.id, segment]),
  );
  return input.bundle.manifest.programs.map((program, ordinal) => {
    const includedIds = new Set([
      ...program.segmentIds,
      ...input.bundle.manifest.sharedSegmentIds,
    ]);
    const includedSegments = input.bundle.segments.filter(
      (segment) => includedIds.has(segment.id),
    );
    if (includedSegments.length !== includedIds.size) {
      throw materializationError(
        "aggregate_split_child_segment_missing",
        `${program.stableKey}의 파생 입력 segment가 누락됐습니다.`,
      );
    }
    const sourceId = buildAggregateSplitChildSourceId({
      parentSourceId: parentGrant.sourceId,
      parentSourceRevisionSha256: input.splitCase.sourceRevisionSha256,
      stableKey: program.stableKey,
    });
    const agencyPrimary = program.agency ?? parentGrant.agencyPrimary;
    const grantSourceFields = buildChildGrantSourceFields({
      parent: parentGrant,
      sourceId,
      title: program.title,
      agencyPrimary,
    });
    const rawPayload = {
      schema: AGGREGATE_SPLIT_CHILD_SOURCE_SCHEMA,
      provenance: {
        splitCaseId: input.splitCase.id,
        parentGrantId: input.splitCase.grantId,
        parentSource: parentGrant.source,
        parentSourceId: parentGrant.sourceId,
        parentSourceRevisionSha256: input.splitCase.sourceRevisionSha256,
        manifestSha256: input.splitCase.manifestSha256,
      },
      program: {
        stableKey: program.stableKey,
        ordinal,
        title: program.title,
        agency: program.agency,
        ownedSegmentIds: program.segmentIds,
        sharedSegmentIds: input.bundle.manifest.sharedSegmentIds,
      },
      segments: includedSegments.map((segment) => ({
        id: segment.id,
        ordinal: segment.ordinal,
        sourceKind: segment.sourceKind,
        sourceId: segment.sourceId,
        startChar: segment.startChar,
        endChar: segment.endChar,
        chars: segment.chars,
        sha256: segment.sha256,
        text: requiredSegment(segmentById, segment.id).text,
      })),
    };
    const rawPayloadSha256 = hashGrantRawPayload(rawPayload);
    const sourceRevision = buildDeepAnalysisSourceRevision({
      grant: grantSourceFields,
      rawHash: rawPayloadSha256,
      attachments: [],
    });
    const grantProjection = {
      schema: AGGREGATE_SPLIT_CHILD_PROJECTION_SCHEMA,
      splitCaseId: input.splitCase.id,
      parentGrantId: input.splitCase.grantId,
      stableKey: program.stableKey,
      ordinal,
      grant: grantSourceFields,
      initialMatchingProjection: {
        fRegions: [],
        fIndustries: [],
        fBizAgeMinMonths: null,
        fBizAgeMaxMonths: null,
        fSizes: [],
        fFounderTraits: [],
        fRequiredCerts: [],
        fApplyMethods: [],
        fAuthoringMode: "deep_analysis_pending",
        overallConfidence: 0,
      },
      rawPayloadSha256,
      sourceRevisionSha256: sourceRevision.sha256,
      manifestSha256: input.splitCase.manifestSha256,
    };
    return {
      stableKey: program.stableKey,
      ordinal,
      source: parentGrant.source,
      sourceId,
      title: program.title,
      agencyPrimary,
      grantProjection,
      grantProjectionSha256: sha256Hex(stableJson(grantProjection)),
      manifestSha256: input.splitCase.manifestSha256,
      sourceRevisionSha256: sourceRevision.sha256,
      rawPayloadSha256,
      rawPayload,
      grantSourceFields,
    };
  });
}

/**
 * 미래 E-3B가 grant/grant_raw를 projection 그대로 승격하면 prepareDeepAnalysisInput이
 * 동일한 seal을 재생성할 수 있도록 기존 structured source 계약을 그대로 사용한다.
 */
export function sealAggregateSplitChildInput(input: {
  childGrantId: string;
  draft: AggregateSplitChildDraft;
  maxTotalChars?: number;
}): DeepAnalysisInputSeal {
  const seal = sealDeepAnalysisInput({
    grantId: input.childGrantId,
    sourceRevisionSha256: input.draft.sourceRevisionSha256,
    structuredText: stableJson({
      schema: "deep-analysis-structured-source-v1",
      grant: input.draft.grantSourceFields,
      rawPayload: input.draft.rawPayload,
    }),
    attachments: [],
    maxTotalChars: input.maxTotalChars
      ?? DEEP_ANALYSIS_DEFAULT_LIMITS.maxTotalInputChars,
  });
  if (!seal.sealed) {
    throw materializationError(
      "aggregate_split_child_input_not_sealed",
      `${input.draft.stableKey} 파생 입력이 봉인되지 않았습니다: ${
        seal.blockers.map((blocker) => blocker.code).join(",")
      }`,
    );
  }
  return seal;
}

export function buildAggregateSplitChildSourceId(input: {
  parentSourceId: string;
  parentSourceRevisionSha256: string;
  stableKey: string;
}): string {
  if (!input.parentSourceId.trim()) throw new Error("parentSourceId is required");
  assertSha256(input.parentSourceRevisionSha256, "parentSourceRevisionSha256");
  if (!/^p\d{3}-[0-9a-f]{12}$/.test(input.stableKey)) {
    throw new Error(`Invalid aggregate split stable key: ${input.stableKey}`);
  }
  return [
    input.parentSourceId,
    "split",
    input.parentSourceRevisionSha256.slice(0, 12),
    input.stableKey,
  ].join("::");
}

export class AggregateSplitMaterializationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AggregateSplitMaterializationError";
  }
}

function parseAndValidateParentInputArtifact(
  body: string,
  splitCase: AggregateSplitCompletedCaseIdentity,
): ValidatedAggregateSplitBundle["parentInput"] {
  const payload = parseRecordJson(body, "aggregate split input artifact");
  if (payload.schema !== DEEP_ANALYSIS_INPUT_SCHEMA) {
    throw materializationError(
      "aggregate_split_input_schema_invalid",
      "분리 input artifact schema가 올바르지 않습니다.",
    );
  }
  if (
    payload.grantId !== splitCase.grantId
    || payload.sourceRevisionSha256 !== splitCase.sourceRevisionSha256
  ) {
    throw materializationError(
      "aggregate_split_input_identity_mismatch",
      "분리 input artifact의 parent/revision identity가 DB와 다릅니다.",
    );
  }
  const chunks = parseInputChunks(payload.chunks);
  validateInputChunks(chunks);
  const grantSnapshot = parseParentGrantSnapshot(chunks);
  const totalChars = requiredNonnegativeInteger(payload.totalChars, "input.totalChars");
  if (chunks.reduce((sum, chunk) => sum + chunk.chars, 0) !== totalChars) {
    throw materializationError(
      "aggregate_split_input_coverage_invalid",
      "분리 input chunk 문자 수가 전체 입력과 다릅니다.",
    );
  }
  if (!Array.isArray(payload.attachments)) {
    throw materializationError(
      "aggregate_split_input_attachments_invalid",
      "분리 input attachment manifest가 배열이 아닙니다.",
    );
  }
  const attachmentManifestSha256 = requiredSha256(
    payload.attachmentManifestSha256,
    "input.attachmentManifestSha256",
  );
  if (buildAttachmentManifestSha256(payload.attachments) !== attachmentManifestSha256) {
    throw materializationError(
      "aggregate_split_attachment_manifest_hash_mismatch",
      "분리 input attachment manifest hash가 올바르지 않습니다.",
    );
  }
  return {
    grantId: splitCase.grantId,
    sourceRevisionSha256: splitCase.sourceRevisionSha256,
    inputSha256: splitCase.inputSha256,
    attachmentManifestSha256,
    totalChars,
    chunks,
    grantSnapshot,
  };
}

function parseAggregateSplitManifest(body: string): AggregateSplitManifest {
  const payload = parseRecordJson(body, "aggregate split manifest");
  if (payload.schema !== AGGREGATE_SPLIT_MANIFEST_SCHEMA) {
    throw materializationError(
      "aggregate_split_manifest_schema_invalid",
      "분리 manifest schema가 올바르지 않습니다.",
    );
  }
  if (!isRecord(payload.promptVersions)) {
    throw materializationError(
      "aggregate_split_manifest_prompt_invalid",
      "분리 manifest prompt version이 없습니다.",
    );
  }
  if (
    payload.promptVersions.map !== AGGREGATE_SPLIT_MAP_PROMPT_VERSION
    || payload.promptVersions.synthesis !== AGGREGATE_SPLIT_SYNTHESIS_PROMPT_VERSION
  ) {
    throw materializationError(
      "aggregate_split_manifest_prompt_invalid",
      "분리 manifest prompt version이 현재 계약과 다릅니다.",
    );
  }
  if (
    !Array.isArray(payload.segments)
    || !Array.isArray(payload.sharedSegmentIds)
    || !Array.isArray(payload.navigationSegmentIds)
    || !Array.isArray(payload.programs)
    || !isRecord(payload.coverage)
    || !isRecord(payload.execution)
  ) {
    throw materializationError(
      "aggregate_split_manifest_contract_invalid",
      "분리 manifest의 필수 배열 또는 evidence가 없습니다.",
    );
  }
  return payload as unknown as AggregateSplitManifest;
}

function validateAggregateSplitManifestForMaterialization(input: {
  manifest: AggregateSplitManifest;
  parentInput: ValidatedAggregateSplitBundle["parentInput"];
  splitCase: AggregateSplitCompletedCaseIdentity;
  maxChildInputChars: number;
}): AggregateSplitSegment[] {
  const { manifest, parentInput, splitCase } = input;
  if (
    manifest.caseId !== splitCase.id
    || manifest.parentGrantId !== splitCase.grantId
    || manifest.sourceRevisionSha256 !== splitCase.sourceRevisionSha256
    || manifest.inputSha256 !== splitCase.inputSha256
    || manifest.model !== splitCase.model
  ) {
    throw materializationError(
      "aggregate_split_manifest_identity_mismatch",
      "분리 manifest identity가 DB case/input과 다릅니다.",
    );
  }
  if (
    manifest.segments.length !== splitCase.segmentCount
    || manifest.programs.length !== splitCase.programCount
    || manifest.programs.length < 2
    || manifest.programs.length > 300
  ) {
    throw materializationError(
      "aggregate_split_manifest_count_mismatch",
      "분리 manifest의 segment/program 수가 DB evidence와 다릅니다.",
    );
  }
  const sourceText = reconstructInputSources(parentInput.chunks);
  const sourceEnds = new Map<string, number>();
  const segmentIds = new Set<string>();
  const segments = manifest.segments.map((candidate, ordinal) => {
    if (!isRecord(candidate)) {
      throw materializationError(
        "aggregate_split_manifest_segment_invalid",
        `manifest segment ${ordinal}가 객체가 아닙니다.`,
      );
    }
    const sourceKind = requiredEnum(
      candidate.sourceKind,
      ["structured", "attachment"] as const,
      `segments[${ordinal}].sourceKind`,
    );
    const sourceId = requiredString(candidate.sourceId, `segments[${ordinal}].sourceId`);
    const key = sourceKey(sourceKind, sourceId);
    const text = sourceText.get(key);
    if (text === undefined) {
      throw materializationError(
        "aggregate_split_manifest_segment_source_missing",
        `manifest segment ${ordinal}의 원문 source가 없습니다.`,
      );
    }
    const startChar = requiredNonnegativeInteger(
      candidate.startChar,
      `segments[${ordinal}].startChar`,
    );
    const endChar = requiredNonnegativeInteger(
      candidate.endChar,
      `segments[${ordinal}].endChar`,
    );
    const chars = requiredNonnegativeInteger(candidate.chars, `segments[${ordinal}].chars`);
    const sha256 = requiredSha256(candidate.sha256, `segments[${ordinal}].sha256`);
    const id = requiredString(candidate.id, `segments[${ordinal}].id`);
    if (
      candidate.ordinal !== ordinal
      || startChar !== (sourceEnds.get(key) ?? 0)
      || endChar <= startChar
      || chars !== endChar - startChar
    ) {
      throw materializationError(
        "aggregate_split_manifest_segment_offsets_invalid",
        `manifest segment ${id}의 ordinal/offset이 무손실 연속 구간이 아닙니다.`,
      );
    }
    const segmentText = text.slice(startChar, endChar);
    if (
      segmentText.length !== chars
      || sha256Hex(segmentText) !== sha256
      || id !== `seg-${String(ordinal + 1).padStart(5, "0")}-${sha256.slice(0, 12)}`
      || segmentIds.has(id)
    ) {
      throw materializationError(
        "aggregate_split_manifest_segment_hash_invalid",
        `manifest segment ${id}의 id/hash/text가 일치하지 않습니다.`,
      );
    }
    sourceEnds.set(key, endChar);
    segmentIds.add(id);
    return {
      id,
      ordinal,
      sourceKind,
      sourceId,
      startChar,
      endChar,
      chars,
      sha256,
      text: segmentText,
    };
  });
  for (const [key, text] of sourceText) {
    if ((sourceEnds.get(key) ?? 0) !== text.length) {
      throw materializationError(
        "aggregate_split_manifest_segment_coverage_invalid",
        `manifest가 ${key} 원문 전체를 연속 분할하지 않았습니다.`,
      );
    }
  }

  const segmentById = new Map(segments.map((segment) => [segment.id, segment]));
  const assigned = new Set<string>();
  const sharedSegmentIds = validateSegmentIdList(
    manifest.sharedSegmentIds,
    segmentById,
    assigned,
    "sharedSegmentIds",
  );
  const navigationSegmentIds = validateSegmentIdList(
    manifest.navigationSegmentIds,
    segmentById,
    assigned,
    "navigationSegmentIds",
  );
  const sharedChars = sumSegmentChars(sharedSegmentIds, segmentById);
  const programKeys = new Set<string>();
  const programIdentities = new Set<string>();
  let lastProgramOrdinal = -1;
  let programChars = 0;
  for (const [programOrdinal, program] of manifest.programs.entries()) {
    validateProgramShape(program, programOrdinal);
    if (programKeys.has(program.stableKey)) {
      throw materializationError(
        "aggregate_split_manifest_program_duplicate",
        `중복 program stable key: ${program.stableKey}`,
      );
    }
    programKeys.add(program.stableKey);
    const programSegmentIds = validateSegmentIdList(
      program.segmentIds,
      segmentById,
      assigned,
      `programs[${programOrdinal}].segmentIds`,
    );
    if (programSegmentIds.length === 0) {
      throw materializationError(
        "aggregate_split_manifest_program_empty",
        `${program.stableKey}에 program segment가 없습니다.`,
      );
    }
    const firstSegment = requiredSegment(segmentById, programSegmentIds[0]!);
    if (firstSegment.ordinal <= lastProgramOrdinal) {
      throw materializationError(
        "aggregate_split_manifest_program_order_invalid",
        "manifest program 순서가 첫 segment 원문 순서와 다릅니다.",
      );
    }
    lastProgramOrdinal = firstSegment.ordinal;
    const expectedStableKey = `p${String(programOrdinal + 1).padStart(3, "0")}-${
      sha256Hex([
        splitCase.sourceRevisionSha256,
        program.title,
        firstSegment.id,
      ].join("\u0000")).slice(0, 12)
    }`;
    if (program.stableKey !== expectedStableKey) {
      throw materializationError(
        "aggregate_split_manifest_program_key_invalid",
        `${program.stableKey}가 server-derived stable key와 다릅니다.`,
      );
    }
    const ownedChars = sumSegmentChars(programSegmentIds, segmentById);
    const projectedInputChars = ownedChars + sharedChars;
    if (
      program.ownedChars !== ownedChars
      || program.projectedInputChars !== projectedInputChars
      || projectedInputChars > input.maxChildInputChars
    ) {
      throw materializationError(
        "aggregate_split_manifest_program_chars_invalid",
        `${program.stableKey}의 child 문자 수 evidence가 올바르지 않습니다.`,
      );
    }
    const identity = `${normalizeTitle(program.title)}\u0000${
      normalizeTitle(program.agency ?? "")
    }`;
    if (programIdentities.has(identity)) {
      throw materializationError(
        "aggregate_split_manifest_program_duplicate",
        "manifest에 같은 제목/기관의 하위사업이 중복됩니다.",
      );
    }
    programIdentities.add(identity);
    programChars += ownedChars;
  }
  if (assigned.size !== segments.length) {
    throw materializationError(
      "aggregate_split_manifest_assignment_coverage_invalid",
      "manifest의 program/shared/navigation이 모든 segment를 정확히 한 번 포함하지 않습니다.",
    );
  }
  const navigationChars = sumSegmentChars(navigationSegmentIds, segmentById);
  const assignedChars = programChars + sharedChars + navigationChars;
  if (
    parentInput.totalChars !== assignedChars
    || manifest.coverage.inputChars !== parentInput.totalChars
    || manifest.coverage.segmentCount !== segments.length
    || manifest.coverage.assignedSegmentCount !== assigned.size
    || manifest.coverage.assignedChars !== assignedChars
    || manifest.coverage.programChars !== programChars
    || manifest.coverage.sharedChars !== sharedChars
    || manifest.coverage.navigationChars !== navigationChars
    || navigationChars > parentInput.totalChars * 0.4
  ) {
    throw materializationError(
      "aggregate_split_manifest_coverage_evidence_invalid",
      "manifest coverage evidence가 재계산 결과와 다릅니다.",
    );
  }
  return segments;
}

function buildChildGrantSourceFields(input: {
  parent: AggregateSplitParentGrantSnapshot;
  sourceId: string;
  title: string;
  agencyPrimary: string | null;
}): Record<string, unknown> {
  return {
    source: input.parent.source,
    sourceId: input.sourceId,
    title: input.title,
    url: input.parent.url,
    agencyJurisdiction: input.parent.agencyJurisdiction,
    agencyOperator: input.agencyPrimary ?? input.parent.agencyOperator,
    agencyPrimary: input.agencyPrimary,
    categoryL1: input.parent.categoryL1,
    categoryL2: input.parent.categoryL2,
    applyStart: input.parent.applyStart,
    applyEnd: input.parent.applyEnd,
    applyMethod: input.parent.applyMethod,
    supportAmount: null,
    benefits: null,
    requiredDocuments: null,
    status: input.parent.status,
  };
}

function parseParentGrantSnapshot(
  chunks: DeepAnalysisInputChunk[],
): AggregateSplitParentGrantSnapshot {
  const structuredText = reconstructInputSources(chunks).get(
    sourceKey("structured", "grant"),
  );
  if (structuredText === undefined) {
    throw materializationError(
      "aggregate_split_parent_snapshot_missing",
      "분리 input에 봉인된 parent 공고 스냅샷이 없습니다.",
    );
  }
  const structured = parseRecordJson(
    structuredText,
    "aggregate split structured parent source",
  );
  if (
    structured.schema !== "deep-analysis-structured-source-v1"
    || !isRecord(structured.grant)
  ) {
    throw materializationError(
      "aggregate_split_parent_snapshot_invalid",
      "분리 input의 parent 공고 스냅샷 계약이 올바르지 않습니다.",
    );
  }
  const grant = structured.grant;
  return {
    source: requiredEnum(
      grant.source,
      ["kstartup", "bizinfo", "bizinfo_event"] as const,
      "structured.grant.source",
    ),
    sourceId: requiredString(grant.sourceId, "structured.grant.sourceId"),
    url: nullableString(grant.url, "structured.grant.url"),
    agencyJurisdiction: nullableString(
      grant.agencyJurisdiction,
      "structured.grant.agencyJurisdiction",
    ),
    agencyOperator: nullableString(
      grant.agencyOperator,
      "structured.grant.agencyOperator",
    ),
    agencyPrimary: nullableString(
      grant.agencyPrimary,
      "structured.grant.agencyPrimary",
    ),
    categoryL1: nullableString(grant.categoryL1, "structured.grant.categoryL1"),
    categoryL2: nullableString(grant.categoryL2, "structured.grant.categoryL2"),
    applyStart: nullableTimestamp(grant.applyStart, "structured.grant.applyStart"),
    applyEnd: nullableTimestamp(grant.applyEnd, "structured.grant.applyEnd"),
    applyMethod: nullableStringRecord(
      grant.applyMethod,
      "structured.grant.applyMethod",
    ),
    status: requiredEnum(
      grant.status,
      ["upcoming", "open", "closed", "unknown"] as const,
      "structured.grant.status",
    ),
  };
}

function reconstructInputSources(
  chunks: DeepAnalysisInputChunk[],
): Map<string, string> {
  const sources = new Map<string, DeepAnalysisInputChunk[]>();
  for (const chunk of chunks) {
    const key = sourceKey(chunk.sourceKind, chunk.sourceId);
    sources.set(key, [...(sources.get(key) ?? []), chunk]);
  }
  return new Map([...sources].map(([key, sourceChunks]) => [
    key,
    sourceChunks
      .sort((left, right) => left.index - right.index)
      .map((chunk) => chunk.text)
      .join(""),
  ]));
}

function parseInputChunks(value: unknown): DeepAnalysisInputChunk[] {
  if (!Array.isArray(value)) {
    throw materializationError(
      "aggregate_split_input_chunks_invalid",
      "분리 input chunks가 배열이 아닙니다.",
    );
  }
  return value.map((candidate, index) => {
    if (!isRecord(candidate)) {
      throw materializationError(
        "aggregate_split_input_chunks_invalid",
        `input chunk ${index}가 객체가 아닙니다.`,
      );
    }
    return {
      id: requiredString(candidate.id, `chunks[${index}].id`),
      sourceKind: requiredEnum(
        candidate.sourceKind,
        ["structured", "attachment"] as const,
        `chunks[${index}].sourceKind`,
      ),
      sourceId: requiredString(candidate.sourceId, `chunks[${index}].sourceId`),
      index: requiredNonnegativeInteger(candidate.index, `chunks[${index}].index`),
      startChar: requiredNonnegativeInteger(
        candidate.startChar,
        `chunks[${index}].startChar`,
      ),
      endChar: requiredNonnegativeInteger(candidate.endChar, `chunks[${index}].endChar`),
      chars: requiredNonnegativeInteger(candidate.chars, `chunks[${index}].chars`),
      sha256: requiredSha256(candidate.sha256, `chunks[${index}].sha256`),
      text: requiredString(candidate.text, `chunks[${index}].text`, true),
    };
  });
}

function validateInputChunks(chunks: DeepAnalysisInputChunk[]): void {
  const bySource = new Map<string, DeepAnalysisInputChunk[]>();
  for (const chunk of chunks) {
    const key = sourceKey(chunk.sourceKind, chunk.sourceId);
    bySource.set(key, [...(bySource.get(key) ?? []), chunk]);
  }
  for (const [key, sourceChunks] of bySource) {
    const ordered = sourceChunks.sort((left, right) => left.index - right.index);
    let expectedStart = 0;
    for (const [index, chunk] of ordered.entries()) {
      if (
        chunk.index !== index
        || chunk.startChar !== expectedStart
        || chunk.endChar !== chunk.startChar + chunk.text.length
        || chunk.chars !== chunk.text.length
        || chunk.sha256 !== sha256Hex(chunk.text)
        || chunk.id !== `${chunk.sourceKind}:${chunk.sourceId}:${index}`
      ) {
        throw materializationError(
          "aggregate_split_input_chunk_sequence_invalid",
          `분리 input ${key} chunk가 연속·무손실 계약을 위반했습니다.`,
        );
      }
      expectedStart = chunk.endChar;
    }
  }
}

function validateProgramShape(
  program: AggregateSplitProgram,
  index: number,
): void {
  if (
    !isRecord(program)
    || !/^p\d{3}-[0-9a-f]{12}$/.test(program.stableKey)
    || typeof program.title !== "string"
    || !program.title.trim()
    || (
      program.agency !== null
      && (typeof program.agency !== "string" || !program.agency.trim())
    )
    || !Array.isArray(program.segmentIds)
    || !Number.isInteger(program.ownedChars)
    || !Number.isInteger(program.projectedInputChars)
  ) {
    throw materializationError(
      "aggregate_split_manifest_program_invalid",
      `manifest program ${index} 계약이 올바르지 않습니다.`,
    );
  }
}

function validateSegmentIdList(
  value: unknown,
  segments: Map<string, AggregateSplitSegment>,
  assigned: Set<string>,
  label: string,
): string[] {
  if (!Array.isArray(value)) {
    throw materializationError(
      "aggregate_split_manifest_assignment_invalid",
      `${label}가 배열이 아닙니다.`,
    );
  }
  return value.map((candidate, index) => {
    const id = requiredString(candidate, `${label}[${index}]`);
    if (!segments.has(id) || assigned.has(id)) {
      throw materializationError(
        "aggregate_split_manifest_assignment_invalid",
        `${label}의 ${id}가 누락·중복·위조됐습니다.`,
      );
    }
    assigned.add(id);
    return id;
  });
}

function sumSegmentChars(
  segmentIds: string[],
  segments: Map<string, AggregateSplitSegment>,
): number {
  return segmentIds.reduce(
    (sum, segmentId) => sum + requiredSegment(segments, segmentId).chars,
    0,
  );
}

function requiredSegment(
  segments: Map<string, AggregateSplitSegment>,
  segmentId: string,
): AggregateSplitSegment {
  const segment = segments.get(segmentId);
  if (!segment) throw new Error(`Unknown aggregate split segment: ${segmentId}`);
  return segment;
}

function assertCompletedCaseIdentity(
  splitCase: AggregateSplitCompletedCaseIdentity,
): void {
  assertSha256(splitCase.sourceRevisionSha256, "sourceRevisionSha256");
  assertSha256(splitCase.inputSha256, "inputSha256");
  assertSha256(splitCase.manifestSha256, "manifestSha256");
  if (
    !splitCase.id
    || !splitCase.grantId
    || !splitCase.inputArtifactKey
    || !splitCase.manifestArtifactKey
    || !splitCase.model
    || splitCase.segmentCount < 1
    || splitCase.programCount < 2
  ) {
    throw new Error("Completed aggregate split case identity is incomplete");
  }
}

function parseRecordJson(value: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw materializationError(
      "aggregate_split_artifact_json_invalid",
      `${label}가 JSON이 아닙니다.`,
    );
  }
  if (!isRecord(parsed)) {
    throw materializationError(
      "aggregate_split_artifact_json_invalid",
      `${label}가 object가 아닙니다.`,
    );
  }
  return parsed;
}

function requiredString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw materializationError(
      "aggregate_split_artifact_contract_invalid",
      `${label}가 올바른 문자열이 아닙니다.`,
    );
  }
  return value;
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label, true);
}

function nullableTimestamp(value: unknown, label: string): string | null {
  const timestamp = nullableString(value, label);
  if (timestamp !== null) {
    const parsed = new Date(timestamp);
    if (
      Number.isNaN(parsed.getTime())
      || parsed.toISOString() !== timestamp
    ) {
      throw materializationError(
        "aggregate_split_artifact_contract_invalid",
        `${label}가 canonical ISO timestamp가 아닙니다.`,
      );
    }
  }
  return timestamp;
}

function nullableStringRecord(
  value: unknown,
  label: string,
): Record<string, string | null> | null {
  if (value === null) return null;
  if (
    !isRecord(value)
    || Object.values(value).some(
      (item) => item !== null && typeof item !== "string",
    )
  ) {
    throw materializationError(
      "aggregate_split_artifact_contract_invalid",
      `${label}가 string 또는 null 값의 객체가 아닙니다.`,
    );
  }
  return value as Record<string, string | null>;
}

function requiredNonnegativeInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw materializationError(
      "aggregate_split_artifact_contract_invalid",
      `${label}가 음이 아닌 정수가 아닙니다.`,
    );
  }
  return value;
}

function requiredSha256(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw materializationError(
      "aggregate_split_artifact_contract_invalid",
      `${label}가 문자열이 아닙니다.`,
    );
  }
  assertSha256(value, label);
  return value;
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw materializationError(
      "aggregate_split_artifact_contract_invalid",
      `${label}가 ${values.join(",")} 중 하나가 아닙니다.`,
    );
  }
  return value as T[number];
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw materializationError(
      "aggregate_split_artifact_contract_invalid",
      `${label}가 lowercase SHA-256이 아닙니다.`,
    );
  }
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("ko-KR");
}

function sourceKey(
  sourceKind: DeepAnalysisInputChunk["sourceKind"],
  sourceId: string,
): string {
  return `${sourceKind}\u0000${sourceId}`;
}

function materializationError(
  code: string,
  message: string,
  retryable = false,
): AggregateSplitMaterializationError {
  return new AggregateSplitMaterializationError(code, message, retryable);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
