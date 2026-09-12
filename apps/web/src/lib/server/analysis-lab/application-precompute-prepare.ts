import { and, asc, eq } from "drizzle-orm";
import type { GrantSource } from "@cunote/contracts";
import type { ApplicationRoundtripRun } from "../application-analysis/contract";
import { readRoundtripRunArtifacts, type RoundtripRunManifest } from "./application-roundtrip/store";
import { readLabRun } from "./run-store";
import type { CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import {
  buildApplicationPrecomputeMaterializationPlan,
  type ApplicationPrecomputeSurfacePlan,
  type PreparedGrantApplicationPrecompute,
  type PreparedApplicationPrecomputeSurface,
} from "../documents/applicationPrecomputeMaterialization";
import {
  persistStagedFieldCandidates,
  stageFieldCandidates,
  type StagedFieldCandidates,
} from "../documents/fieldCandidateStore";
import { sha256Canonical } from "../analysis-serving/promotionReleaseContract";

export interface GrantApplicationPrecomputePlan {
  grantId: string;
  parentLabRunId: string;
  roundtripRunId: string;
  surfaces: ApplicationPrecomputeSurfacePlan[];
}

export interface StagedGrantApplicationPrecompute extends GrantApplicationPrecomputePlan {
  surfaces: Array<ApplicationPrecomputeSurfacePlan & { stagedArtifact: StagedFieldCandidates }>;
}

/** local immutable 산출물을 읽고 content-addressed R2 artifact를 먼저 준비한다. DB field projection은 건드리지 않는다. */
export async function prepareGrantApplicationPrecompute(input: {
  grantId: string;
  parentLabRunId: string;
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  roundtripArtifacts?: {
    run: ApplicationRoundtripRun;
    manifest: RoundtripRunManifest;
  };
  receiptBoundRoundtrip?: {
    parentLabRunId: string;
    roundtripRunId: string;
  };
}): Promise<PreparedGrantApplicationPrecompute | null> {
  const plan = await loadGrantApplicationPrecomputePlan(input);
  if (!plan) return null;
  const staged = await stageGrantApplicationPrecompute({
    db: input.db,
    storage: input.storage,
    plan,
  });
  return persistStagedGrantApplicationPrecompute({ db: input.db, staged });
}

/** bundled run + 현재 surface/source에서 쓰기 없는 exact materialization plan을 만든다. */
export async function loadGrantApplicationPrecomputePlan(input: {
  grantId: string;
  parentLabRunId: string;
  db: CunoteDbSession;
  roundtripArtifacts?: {
    run: ApplicationRoundtripRun;
    manifest: RoundtripRunManifest;
  };
  receiptBoundRoundtrip?: {
    parentLabRunId: string;
    roundtripRunId: string;
  };
}): Promise<GrantApplicationPrecomputePlan | null> {
  const labRun = await readLabRun(input.grantId, input.parentLabRunId);
  if (!labRun) return null;
  if (!labRun.applicationRoundtrip?.runId && !input.receiptBoundRoundtrip) return null;
  const roundtripRunId = input.receiptBoundRoundtrip?.roundtripRunId
    ?? labRun.applicationRoundtrip?.runId;
  if (!roundtripRunId) return null;
  const artifacts = input.roundtripArtifacts
    ? { ...input.roundtripArtifacts, dir: "(release-bundle)" }
    : await readRoundtripRunArtifacts(input.grantId, roundtripRunId);
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
    .where(eq(schema.grantApplicationSurfaces.grantId, input.grantId))
    .orderBy(asc(schema.grantApplicationSurfaces.id));
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
    ...(input.receiptBoundRoundtrip
      ? { receiptBoundRoundtrip: input.receiptBoundRoundtrip }
      : {}),
    surfaces: surfaceRows.map((surface) => ({
      ...surface,
      sourceSha256: surface.sourceAttachment ? shaByStorageKey.get(surface.sourceAttachment) ?? null : null,
    })),
  });
  return {
    grantId: input.grantId,
    parentLabRunId: input.parentLabRunId,
    roundtripRunId: artifacts.run.runId,
    surfaces: plan,
  };
}

export function grantApplicationPrecomputePlanSha256(plan: GrantApplicationPrecomputePlan): string {
  return sha256Canonical(plan);
}

/** immutable R2 bodies만 stage하며 document_artifacts는 아직 쓰지 않는다. */
export async function stageGrantApplicationPrecompute(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  plan: GrantApplicationPrecomputePlan;
}): Promise<StagedGrantApplicationPrecompute> {
  const surfaces = [] as StagedGrantApplicationPrecompute["surfaces"];
  for (const item of input.plan.surfaces) {
    const stagedArtifact = await stageFieldCandidates({
      db: input.db,
      storage: input.storage,
      surfaceId: item.surfaceId,
      set: item.candidateSet,
      metadata: item.metadata,
    });
    surfaces.push({ ...item, stagedArtifact });
  }
  return { ...input.plan, surfaces };
}

/** candidate pointer를 caller의 DB transaction 안에 기록한다. */
export async function persistStagedGrantApplicationPrecompute(input: {
  db: CunoteDbSession;
  staged: StagedGrantApplicationPrecompute;
}): Promise<PreparedGrantApplicationPrecompute> {
  const surfaces: PreparedApplicationPrecomputeSurface[] = [];
  for (const item of input.staged.surfaces) {
    const saved = await persistStagedFieldCandidates({ db: input.db, staged: item.stagedArtifact });
    const { stagedArtifact: _stagedArtifact, ...plan } = item;
    surfaces.push({ ...plan, artifactId: saved.artifactId, artifactSha256: saved.sha256 });
  }
  return { ...input.staged, surfaces };
}
