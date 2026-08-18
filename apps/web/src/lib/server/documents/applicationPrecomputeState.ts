import { and, desc, eq } from "drizzle-orm";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  type RoundtripFailureCode,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import { getCunoteDb, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { FIELD_CANDIDATES_ARTIFACT_KIND } from "./fieldCandidateStore";

export const APPLICATION_PRECOMPUTE_ENGINE = "kordoc-roundtrip";
export const APPLICATION_PRECOMPUTE_VERSION_PREFIX = "kordoc-rhwp-application-precompute-v1";

export type ApplicationPrecomputeStatus =
  | "complete"
  | "partial"
  | "review_required"
  | "not_applicable"
  | "failed";

export interface ApplicationPrecomputeArtifactMetadata extends Record<string, unknown> {
  engine: typeof APPLICATION_PRECOMPUTE_ENGINE;
  engineVersion: string;
  layer: "text_parser";
  candidateCount: number;
  extractedAt: string;
  analysisVersion: string;
  contractVersion: typeof APPLICATION_ROUNDTRIP_VERSION;
  sourceSha256: string;
  resultStatus: ApplicationPrecomputeStatus;
  roundtripRunId: string;
  parentLabRunId: string | null;
  parentDeepAnalysisRunId?: string | null;
  transport: "api" | "claude-cli";
  requestedModel: string;
  fieldCount: number;
  coverageStatus: "complete" | "partial" | "review_required" | null;
  errorCode: RoundtripFailureCode | "roundtrip_surface_missing" | null;
  requestCount?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number | null;
}

export interface SurfaceApplicationPrecomputeState {
  status: ApplicationPrecomputeStatus | null;
  current: boolean;
  analysisVersion: string | null;
  sourceSha256: string | null;
  artifactId: string | null;
  fieldCount: number;
  errorCode: string | null;
}

/** artifact metadata를 불신 입력으로 다루고 workspace가 필요한 작은 상태로만 낮춘다. */
export function parseApplicationPrecomputeState(input: {
  artifactId: string;
  metadata: Record<string, unknown> | null;
  currentSourceSha256: string | null;
}): SurfaceApplicationPrecomputeState | null {
  const metadata = input.metadata;
  if (!metadata || metadata.engine !== APPLICATION_PRECOMPUTE_ENGINE) return null;
  const status = applicationPrecomputeStatus(metadata.resultStatus);
  const sourceSha256 = stringOrNull(metadata.sourceSha256);
  const analysisVersion = stringOrNull(metadata.analysisVersion);
  const contractVersion = stringOrNull(metadata.contractVersion);
  if (!status || !sourceSha256 || !analysisVersion) return null;
  const current = input.currentSourceSha256 !== null
    && sourceSha256 === input.currentSourceSha256
    && contractVersion === APPLICATION_ROUNDTRIP_VERSION
    && analysisVersion.startsWith(`${APPLICATION_PRECOMPUTE_VERSION_PREFIX}:`);
  return {
    status,
    current,
    analysisVersion,
    sourceSha256,
    artifactId: input.artifactId,
    fieldCount: nonNegativeInteger(metadata.fieldCount),
    errorCode: stringOrNull(metadata.errorCode),
  };
}

export function shouldRecoverApplicationPrecompute(
  state: SurfaceApplicationPrecomputeState | null,
  connectedFieldsCount: number,
): boolean {
  if (!state || !state.current) return true;
  return (state.status === "complete" || state.status === "partial") && connectedFieldsCount === 0;
}

export async function loadSurfaceApplicationPrecomputeState(input: {
  surfaceId: string;
  db?: CunoteDbSession;
}): Promise<SurfaceApplicationPrecomputeState | null> {
  const db = input.db ?? getCunoteDb();
  const [surface] = await db
    .select({
      source: schema.grantApplicationSurfaces.source,
      sourceId: schema.grantApplicationSurfaces.sourceId,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
    })
    .from(schema.grantApplicationSurfaces)
    .where(eq(schema.grantApplicationSurfaces.id, input.surfaceId))
    .limit(1);
  if (!surface?.sourceAttachment) return null;

  const [archiveRows, artifactRows] = await Promise.all([
    db
      .select({ sha256: schema.grantAttachmentArchives.sha256 })
      .from(schema.grantAttachmentArchives)
      .where(and(
        eq(schema.grantAttachmentArchives.source, surface.source),
        eq(schema.grantAttachmentArchives.sourceId, surface.sourceId),
        eq(schema.grantAttachmentArchives.storageKey, surface.sourceAttachment),
      ))
      .limit(1),
    db
      .select({
        id: schema.documentArtifacts.id,
        metadata: schema.documentArtifacts.metadata,
      })
      .from(schema.documentArtifacts)
      .where(and(
        eq(schema.documentArtifacts.surfaceId, input.surfaceId),
        eq(schema.documentArtifacts.kind, FIELD_CANDIDATES_ARTIFACT_KIND),
      ))
      .orderBy(desc(schema.documentArtifacts.createdAt)),
  ]);
  const currentSourceSha256 = archiveRows[0]?.sha256 ?? null;
  let latestStale: SurfaceApplicationPrecomputeState | null = null;
  for (const row of artifactRows) {
    const parsed = parseApplicationPrecomputeState({
      artifactId: row.id,
      metadata: row.metadata,
      currentSourceSha256,
    });
    if (parsed?.current) return parsed;
    if (parsed && !latestStale) latestStale = parsed;
  }
  return latestStale;
}

function applicationPrecomputeStatus(value: unknown): ApplicationPrecomputeStatus | null {
  return value === "complete"
    || value === "partial"
    || value === "review_required"
    || value === "not_applicable"
    || value === "failed"
    ? value
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
