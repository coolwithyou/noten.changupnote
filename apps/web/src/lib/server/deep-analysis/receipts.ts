import type {
  DeepAnalysisStageKey,
  DeepAnalysisStageStatus,
} from "@cunote/contracts";
import type { CunoteDbSession } from "@/lib/server/db/client";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import { putImmutableDeepAnalysisArtifact } from "./artifacts";
import { appendDeepAnalysisStageReceipt } from "./ledger";
import { stableJson } from "./sourceRevision";

export async function appendVerifiedDeepAnalysisStageReceipt(input: {
  db: CunoteDbSession;
  storage: R2ObjectStorage;
  grantId: string;
  sourceRevisionSha256: string;
  publicRunId: string;
  databaseRunId: string;
  stage: DeepAnalysisStageKey;
  status: DeepAnalysisStageStatus;
  verifierVersion: string;
  evidence: Record<string, unknown>;
  attempt?: number;
}): Promise<void> {
  const body = `${stableJson({
    schema: "deep-analysis-stage-evidence-v1",
    runId: input.publicRunId,
    stage: input.stage,
    status: input.status,
    verifierVersion: input.verifierVersion,
    evidence: input.evidence,
  })}\n`;
  const artifact = await putImmutableDeepAnalysisArtifact({
    storage: input.storage,
    identity: {
      grantId: input.grantId,
      sourceRevisionSha256: input.sourceRevisionSha256,
      runId: input.publicRunId,
      kind: "stage-evidence",
      extension: "json",
    },
    body,
    contentType: "application/json",
  });
  await appendDeepAnalysisStageReceipt(input.db, {
    runId: input.databaseRunId,
    stage: input.stage,
    status: input.status,
    verifierVersion: input.verifierVersion,
    evidence: input.evidence,
    artifactKey: artifact.key,
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
  });
}
