import { createHash } from "node:crypto";
import { and, eq, like, sql } from "drizzle-orm";
import type { CandidateKind, CandidateSet, ReconciledField } from "@cunote/core";
import type { GrantSource } from "@cunote/contracts";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
  type RoundtripFieldType,
  type RoundtripParsedDocument,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import type { LabRun } from "@/features/dev/analysis-lab/contract";
import { readRoundtripRunArtifacts, type RoundtripRunManifest } from "../analysis-lab/application-roundtrip/store";
import { readLabRun } from "../analysis-lab/run-store";
import { type CunoteDb, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import { buildReconciledApplicationFields } from "./applicationFieldAnalysis";
import {
  APPLICATION_FIELD_PARSER_PREFIX,
  APPLICATION_FIELD_PARSER_VERSION,
  classifyApplicationFieldMap,
} from "./applicationFieldVersion";
import {
  APPLICATION_PRECOMPUTE_ENGINE,
  APPLICATION_PRECOMPUTE_VERSION_PREFIX,
  type ApplicationPrecomputeArtifactMetadata,
  type ApplicationPrecomputeStatus,
} from "./applicationPrecomputeState";
import { applyReconciledFields } from "./applyReconciledFields";
import { createFieldCandidateStore } from "./fieldCandidateStore";

export interface MaterializationSurface {
  id: string;
  title: string;
  type: string;
  format: string;
  sourceAttachment: string | null;
  sourceSha256: string | null;
}

export interface ApplicationPrecomputeSurfacePlan {
  surfaceId: string;
  sourceSha256: string;
  analysisVersion: string;
  status: ApplicationPrecomputeStatus;
  errorCode: ApplicationPrecomputeArtifactMetadata["errorCode"];
  fields: ReconciledField[];
  candidateSet: CandidateSet;
  metadata: ApplicationPrecomputeArtifactMetadata;
}

export interface PreparedApplicationPrecomputeSurface extends ApplicationPrecomputeSurfacePlan {
  artifactId: string;
  artifactSha256: string;
}

export interface PreparedGrantApplicationPrecompute {
  grantId: string;
  parentLabRunId: string | null;
  roundtripRunId: string;
  surfaces: PreparedApplicationPrecomputeSurface[];
}

export interface AppliedGrantApplicationPrecompute {
  materialized: number;
  reused: number;
  protected: number;
  terminalOnly: number;
  fields: number;
}

/** 불변 lab/roundtrip 산출물을 검증하고 surface별 저장·materialization 계획으로 낮춘다. */
export function buildApplicationPrecomputeMaterializationPlan(input: {
  labRun: LabRun;
  roundtripRun: ApplicationRoundtripRun;
  manifest: RoundtripRunManifest;
  surfaces: MaterializationSurface[];
}): ApplicationPrecomputeSurfacePlan[] {
  const { labRun, roundtripRun: run, manifest } = input;
  const reference = labRun.applicationRoundtrip;
  if (!reference?.runId || reference.runId !== run.runId) {
    throw new Error("LabRun의 Kordoc 참조와 roundtrip runId가 일치하지 않습니다.");
  }
  if (
    run.version !== APPLICATION_ROUNDTRIP_VERSION
    || run.grantId !== labRun.grantId
    || run.parentLabRunId !== labRun.runId
    || manifest.runId !== run.runId
    || manifest.grantId !== run.grantId
    || manifest.source !== run.source
    || manifest.sourceId !== run.sourceId
  ) {
    throw new Error("Kordoc 선분석 산출물의 grant·parent·version seal이 일치하지 않습니다.");
  }

  const analysisVersion = applicationPrecomputeAnalysisVersion(run);
  const manifestByStorageKey = new Map(manifest.attachments.map((item) => [item.storageKey, item]));
  const documentByAttachmentId = new Map(run.documents.map((document) => [document.attachmentId, document]));
  for (const attachment of manifest.attachments) {
    const document = documentByAttachmentId.get(attachment.attachmentId);
    if (!document || document.sourceSha256 !== attachment.sourceSha256) {
      throw new Error(`Kordoc 문서와 manifest SHA가 일치하지 않습니다: ${attachment.filename}`);
    }
  }

  return input.surfaces
    .filter((surface) =>
      surface.type === "file_template"
      && (surface.format === "hwp" || surface.format === "hwpx")
      && surface.sourceAttachment
      && surface.sourceSha256)
    .map((surface) => {
      const sourceAttachment = surface.sourceAttachment!;
      const sourceSha256 = surface.sourceSha256!;
      const attachment = manifestByStorageKey.get(sourceAttachment);
      if (!attachment) {
        const skipped = (run.sourceCount ?? run.documents.length) > run.documents.length;
        return surfacePlan({
          surface,
          run,
          analysisVersion,
          sourceSha256,
          document: null,
          status: skipped ? "review_required" : "failed",
          errorCode: skipped ? "document_limit_exceeded" : "roundtrip_surface_missing",
          fields: [],
        });
      }
      if (attachment.sourceSha256 !== sourceSha256) {
        throw new Error(`surface 원본 SHA와 roundtrip manifest가 일치하지 않습니다: ${surface.id}`);
      }
      const document = documentByAttachmentId.get(attachment.attachmentId);
      if (!document) throw new Error(`roundtrip manifest 문서가 누락됐습니다: ${attachment.attachmentId}`);
      return buildApplicationPrecomputeSurfacePlan({
        surface,
        run,
        analysisVersion,
        sourceSha256,
        document,
      });
    });
}

/** 운영 worker와 lab 승격이 공유하는 단일 surface 판정·artifact 계약. */
export function buildApplicationPrecomputeSurfacePlan(input: {
  surface: MaterializationSurface;
  run: ApplicationRoundtripRun;
  analysisVersion: string;
  sourceSha256: string;
  document: RoundtripParsedDocument;
  parentDeepAnalysisRunId?: string | null;
}): ApplicationPrecomputeSurfacePlan {
  const outcome = classifyApplicationPrecomputeDocument(input.document);
  return surfacePlan({
    ...input,
    status: outcome.status,
    errorCode: outcome.errorCode,
    fields: outcome.materialize ? buildReconciledApplicationFields(input.document) : [],
  });
}

/** local immutable 산출물을 읽고 content-addressed R2 artifact를 먼저 준비한다. DB field projection은 건드리지 않는다. */
export async function prepareGrantApplicationPrecompute(input: {
  grantId: string;
  parentLabRunId: string;
  db: CunoteDb;
  storage: R2ObjectStorage;
  roundtripArtifacts?: {
    run: ApplicationRoundtripRun;
    manifest: RoundtripRunManifest;
  };
}): Promise<PreparedGrantApplicationPrecompute | null> {
  const labRun = await readLabRun(input.grantId, input.parentLabRunId);
  if (!labRun?.applicationRoundtrip?.runId) return null;
  const artifacts = input.roundtripArtifacts
    ? { ...input.roundtripArtifacts, dir: "(release-bundle)" }
    : await readRoundtripRunArtifacts(input.grantId, labRun.applicationRoundtrip.runId);
  if (!artifacts) throw new Error(`Kordoc 선분석 artifact를 찾지 못했습니다: ${input.grantId}`);

  const surfaceRows = await input.db
    .select({
      id: schema.grantApplicationSurfaces.id,
      title: schema.grantApplicationSurfaces.title,
      type: schema.grantApplicationSurfaces.type,
      format: schema.grantApplicationSurfaces.format,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
    })
    .from(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.grantId, input.grantId));
  const archiveRows = await input.db
    .select({
      storageKey: schema.grantAttachmentArchives.storageKey,
      sha256: schema.grantAttachmentArchives.sha256,
    })
    .from(schema.grantAttachmentArchives)
    .where(and(
      eq(schema.grantAttachmentArchives.source, artifacts.run.source as GrantSource),
      eq(schema.grantAttachmentArchives.sourceId, artifacts.run.sourceId),
    ));
  const shaByStorageKey = new Map(
    archiveRows.flatMap((row) => row.storageKey && row.sha256 ? [[row.storageKey, row.sha256] as const] : []),
  );
  const plan = buildApplicationPrecomputeMaterializationPlan({
    labRun,
    roundtripRun: artifacts.run,
    manifest: artifacts.manifest,
    surfaces: surfaceRows.map((surface) => ({
      ...surface,
      sourceSha256: surface.sourceAttachment ? shaByStorageKey.get(surface.sourceAttachment) ?? null : null,
    })),
  });
  const store = createFieldCandidateStore({ db: input.db, storage: input.storage });
  const surfaces: PreparedApplicationPrecomputeSurface[] = [];
  for (const item of plan) {
    const saved = await store.saveFieldCandidates({
      surfaceId: item.surfaceId,
      set: item.candidateSet,
      metadata: item.metadata,
    });
    surfaces.push({ ...item, artifactId: saved.artifactId, artifactSha256: saved.sha256 });
  }
  return {
    grantId: input.grantId,
    parentLabRunId: input.parentLabRunId,
    roundtripRunId: artifacts.run.runId,
    surfaces,
  };
}

/** prepared artifact를 짧은 DB transaction 안에서 workspace field projection으로 낮춘다. */
export async function applyPreparedGrantApplicationPrecompute(input: {
  db: CunoteDbSession;
  prepared: PreparedGrantApplicationPrecompute;
}): Promise<AppliedGrantApplicationPrecompute> {
  const result: AppliedGrantApplicationPrecompute = {
    materialized: 0,
    reused: 0,
    protected: 0,
    terminalOnly: 0,
    fields: 0,
  };
  for (const item of input.prepared.surfaces) {
    await input.db.execute(sql`select pg_advisory_xact_lock(hashtext(${item.surfaceId}))`);
    const [surface] = await input.db
      .select({
        source: schema.grantApplicationSurfaces.source,
        sourceId: schema.grantApplicationSurfaces.sourceId,
        sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
        extractionStatus: schema.grantApplicationSurfaces.extractionStatus,
        extractionVersion: schema.grantApplicationSurfaces.extractionVersion,
      })
      .from(schema.grantApplicationSurfaces)
      .where(eq(schema.grantApplicationSurfaces.id, item.surfaceId))
      .limit(1);
    if (!surface?.sourceAttachment) throw new Error(`materialization surface가 사라졌습니다: ${item.surfaceId}`);
    const [archive] = await input.db
      .select({ sha256: schema.grantAttachmentArchives.sha256 })
      .from(schema.grantAttachmentArchives)
      .where(and(
        eq(schema.grantAttachmentArchives.source, surface.source),
        eq(schema.grantAttachmentArchives.sourceId, surface.sourceId),
        eq(schema.grantAttachmentArchives.storageKey, surface.sourceAttachment),
      ))
      .limit(1);
    if (archive?.sha256 !== item.sourceSha256) {
      throw new Error(`materialization 직전 원본 SHA가 변경됐습니다: ${item.surfaceId}`);
    }
    if (item.status !== "complete" && item.status !== "partial") {
      result.terminalOnly += 1;
      continue;
    }
    if (item.fields.length === 0) throw new Error(`materialize 가능한 필드가 0건입니다: ${item.surfaceId}`);
    const mapRows = await input.db
      .select({ parserVersion: schema.grantDocumentFields.parserVersion })
      .from(schema.grantDocumentFields)
      .where(eq(schema.grantDocumentFields.surfaceId, item.surfaceId));
    const mapState = classifyApplicationFieldMap(mapRows.map((row) => row.parserVersion));
    if (mapState === "protected") {
      result.protected += 1;
      continue;
    }
    if (
      surface.extractionStatus === "fields_ready"
      && surface.extractionVersion === item.analysisVersion
      && mapState === "current_automated"
    ) {
      result.reused += 1;
      result.fields += mapRows.length;
      continue;
    }
    if (mapState !== "empty") {
      await input.db
        .delete(schema.grantDocumentFields)
        .where(and(
          eq(schema.grantDocumentFields.surfaceId, item.surfaceId),
          like(schema.grantDocumentFields.parserVersion, `${APPLICATION_FIELD_PARSER_PREFIX}%`),
        ));
    }
    const applied = await applyReconciledFields({
      db: input.db,
      surfaceId: item.surfaceId,
      fields: item.fields,
      parserVersion: APPLICATION_FIELD_PARSER_VERSION,
      extractionVersion: item.analysisVersion,
      extractionConfidence: item.status === "complete" ? 1 : 0.75,
      defaults: { documentCategory: "application_form" },
    });
    result.materialized += 1;
    result.fields += applied.inserted + applied.updated;
  }
  return result;
}

export function applicationPrecomputeAnalysisVersion(run: ApplicationRoundtripRun): string {
  return buildApplicationPrecomputeAnalysisVersion({
    contractVersion: run.version,
    engine: run.engine,
    engineVersion: run.engineVersion,
    transport: run.transport ?? "api",
    requestedModel: run.requestedModel ?? "unknown",
    candidateLimit: run.candidateLimit ?? null,
  });
}

export function buildApplicationPrecomputeAnalysisVersion(input: {
  contractVersion: string;
  engine: string;
  engineVersion: string;
  transport: "api" | "claude-cli";
  requestedModel: string;
  candidateLimit: number | null;
}): string {
  const identity = JSON.stringify({
    contractVersion: input.contractVersion,
    engine: input.engine,
    engineVersion: input.engineVersion,
    transport: input.transport,
    requestedModel: input.requestedModel,
    candidateLimit: input.candidateLimit,
  });
  return `${APPLICATION_PRECOMPUTE_VERSION_PREFIX}:${createHash("sha256").update(identity).digest("hex").slice(0, 20)}`;
}

function surfacePlan(input: {
  surface: MaterializationSurface;
  run: ApplicationRoundtripRun;
  analysisVersion: string;
  sourceSha256: string;
  document: RoundtripParsedDocument | null;
  status: ApplicationPrecomputeStatus;
  errorCode: ApplicationPrecomputeArtifactMetadata["errorCode"];
  fields: ReconciledField[];
  parentDeepAnalysisRunId?: string | null;
}): ApplicationPrecomputeSurfacePlan {
  const candidateSet = candidateSetFor(input.run, input.document);
  const metadata: ApplicationPrecomputeArtifactMetadata = {
    engine: APPLICATION_PRECOMPUTE_ENGINE,
    engineVersion: candidateSet.engineVersion,
    layer: "text_parser",
    candidateCount: candidateSet.candidates.length,
    extractedAt: candidateSet.extractedAt,
    analysisVersion: input.analysisVersion,
    contractVersion: APPLICATION_ROUNDTRIP_VERSION,
    sourceSha256: input.sourceSha256,
    resultStatus: input.status,
    roundtripRunId: input.run.runId,
    parentLabRunId: input.run.parentLabRunId ?? null,
    parentDeepAnalysisRunId: input.parentDeepAnalysisRunId ?? null,
    transport: input.run.transport ?? "api",
    requestedModel: input.run.requestedModel ?? "unknown",
    fieldCount: input.fields.length,
    coverageStatus: input.document?.fieldCoverage.status ?? null,
    errorCode: input.errorCode,
    requestCount: input.document?.fieldPlanning.requestCount ?? 0,
    inputTokens: input.document?.fieldPlanning.inputTokens ?? 0,
    outputTokens: input.document?.fieldPlanning.outputTokens ?? 0,
    costUsd: input.document?.fieldPlanning.costUsd ?? null,
  };
  return {
    surfaceId: input.surface.id,
    sourceSha256: input.sourceSha256,
    analysisVersion: input.analysisVersion,
    status: input.status,
    errorCode: input.errorCode,
    fields: input.fields,
    candidateSet,
    metadata,
  };
}

export function classifyApplicationPrecomputeDocument(document: RoundtripParsedDocument): {
  status: ApplicationPrecomputeStatus;
  errorCode: ApplicationPrecomputeArtifactMetadata["errorCode"];
  materialize: boolean;
} {
  if (document.error) return { status: "failed", errorCode: "document_analysis_failed", materialize: false };
  if (document.role !== "application_form" && document.role !== "business_plan" && document.role !== "mixed_form") {
    return { status: "not_applicable", errorCode: null, materialize: false };
  }
  const errorCode = document.fieldPlanning.failureCode ?? null;
  if (document.fieldCoverage.status === "review_required") {
    return { status: "review_required", errorCode, materialize: false };
  }
  const fields = buildReconciledApplicationFields(document);
  if (fields.length === 0) return { status: "review_required", errorCode, materialize: false };
  if (document.fieldCoverage.status === "partial" || errorCode !== null) {
    return { status: "partial", errorCode, materialize: true };
  }
  return { status: "complete", errorCode: null, materialize: true };
}

function candidateSetFor(
  run: ApplicationRoundtripRun,
  document: RoundtripParsedDocument | null,
): CandidateSet {
  return {
    engine: APPLICATION_PRECOMPUTE_ENGINE,
    engineVersion: run.engineVersion,
    layer: "text_parser",
    extractedAt: run.startedAt,
    candidates: document
      ? [
          ...document.fields.map((field) => ({
            page: field.location.pageNumber,
            bbox: null,
            bboxSource: "text_parser" as const,
            layer: "text_parser" as const,
            kind: candidateKind(field.type),
            label: field.displayLabel || field.label,
            text: field.originalValue,
            confidence: field.llmConfidence ?? field.inputLikelihood,
            rotationDeg: null,
            raw: {
              fieldInstanceId: field.fieldInstanceId,
              recommendedInput: field.recommendedInput,
              inputKind: field.inputKind,
              location: field.location,
              sourceSha256: document.sourceSha256,
            },
          })),
          ...document.choiceGroups.map((choice) => ({
            page: choice.location.pageNumber,
            bbox: null,
            bboxSource: "text_parser" as const,
            layer: "text_parser" as const,
            kind: "checkbox" as const,
            label: choice.label,
            text: choice.options.map((option) => option.label).join(" | "),
            confidence: document.roleConfidence,
            rotationDeg: null,
            raw: { groupId: choice.groupId, selectionMode: choice.selectionMode, location: choice.location },
          })),
        ]
      : [],
  };
}

function candidateKind(type: RoundtripFieldType): CandidateKind {
  if (type === "checkbox") return "checkbox";
  return "text_input";
}
