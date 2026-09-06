import { and, eq } from "drizzle-orm";
import type { GrantSource } from "@cunote/contracts";
import type { ApplicationRoundtripRun } from "../application-analysis/contract";
import { readRoundtripRunArtifacts, type RoundtripRunManifest } from "./application-roundtrip/store";
import { readLabRun } from "./run-store";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import type { R2ObjectStorage } from "../storage/r2ObjectStorage";
import { buildApplicationPrecomputeMaterializationPlan, type PreparedGrantApplicationPrecompute, type PreparedApplicationPrecomputeSurface } from "../documents/applicationPrecomputeMaterialization";
import { createFieldCandidateStore } from "../documents/fieldCandidateStore";

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
  receiptBoundRoundtrip?: {
    parentLabRunId: string;
    roundtripRunId: string;
  };
}): Promise<PreparedGrantApplicationPrecompute | null> {
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
    ...(input.receiptBoundRoundtrip
      ? { receiptBoundRoundtrip: input.receiptBoundRoundtrip }
      : {}),
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
