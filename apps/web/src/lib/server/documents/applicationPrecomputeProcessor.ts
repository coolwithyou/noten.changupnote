import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { VERSION as KORDOC_VERSION } from "kordoc";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { analyzeRoundtripDocument } from "@/lib/server/analysis-lab/application-roundtrip/analyze-document";
import { likelyApplicationRole } from "@/lib/server/analysis-lab/application-roundtrip/core";
import { ROUNDTRIP_FIELD_CANDIDATE_LIMIT } from "@/lib/server/analysis-lab/application-roundtrip/field-planner";
import type { CunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import type { R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";
import {
  applyPreparedGrantApplicationPrecompute,
  buildApplicationPrecomputeSurfacePlan,
  type PreparedApplicationPrecomputeSurface,
} from "./applicationPrecomputeMaterialization";
import {
  recordApplicationPrecomputeAttemptUsage,
  renewApplicationPrecomputeLease,
  type ApplicationPrecomputeJob,
} from "./applicationPrecomputeQueue";
import type { ApplicationPrecomputeWorkerPolicy } from "./applicationPrecomputePolicy";
import { createFieldCandidateStore } from "./fieldCandidateStore";

export class ApplicationPrecomputeProcessingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly blocked = false,
  ) {
    super(message);
    this.name = "ApplicationPrecomputeProcessingError";
  }
}

export async function processApplicationPrecomputeJob(input: {
  db: CunoteDb;
  storage: R2ObjectStorage;
  apiKey: string;
  job: ApplicationPrecomputeJob;
  policy: ApplicationPrecomputeWorkerPolicy;
}): Promise<{
  resultStatus: PreparedApplicationPrecomputeSurface["status"];
  artifactId: string;
  summary: Record<string, unknown>;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}> {
  const [row] = await input.db
    .select({
      surfaceId: schema.grantApplicationSurfaces.id,
      grantId: schema.grantApplicationSurfaces.grantId,
      source: schema.grantApplicationSurfaces.source,
      sourceId: schema.grantApplicationSurfaces.sourceId,
      title: schema.grantApplicationSurfaces.title,
      type: schema.grantApplicationSurfaces.type,
      format: schema.grantApplicationSurfaces.format,
      extractionStatus: schema.grantApplicationSurfaces.extractionStatus,
      sourceAttachment: schema.grantApplicationSurfaces.sourceAttachment,
      filename: schema.grantAttachmentArchives.filename,
      storageKey: schema.grantAttachmentArchives.storageKey,
      archiveSha256: schema.grantAttachmentArchives.sha256,
    })
    .from(schema.grantApplicationSurfaces)
    .innerJoin(schema.grantAttachmentArchives, and(
      eq(schema.grantAttachmentArchives.source, schema.grantApplicationSurfaces.source),
      eq(schema.grantAttachmentArchives.sourceId, schema.grantApplicationSurfaces.sourceId),
      eq(schema.grantAttachmentArchives.storageKey, schema.grantApplicationSurfaces.sourceAttachment),
    ))
    .where(eq(schema.grantApplicationSurfaces.id, input.job.surfaceId))
    .limit(1);
  if (!row || !row.storageKey || !row.archiveSha256) {
    throw new ApplicationPrecomputeProcessingError(
      "source_archive_missing",
      `Kordoc 원본 archive가 없습니다: ${input.job.surfaceId}`,
      false,
      true,
    );
  }
  if (
    row.grantId !== input.job.grantId
    || row.type !== "file_template"
    || (row.format !== "hwp" && row.format !== "hwpx")
    || (row.extractionStatus !== "preview_ready" && row.extractionStatus !== "fields_ready")
  ) {
    throw new ApplicationPrecomputeProcessingError(
      "surface_not_eligible",
      `Kordoc 선분석 대상 surface 계약이 바뀌었습니다: ${input.job.surfaceId}`,
      false,
      true,
    );
  }
  if (row.archiveSha256 !== input.job.sourceSha256) {
    throw new ApplicationPrecomputeProcessingError(
      "source_revision_changed",
      `Kordoc 원본 SHA가 enqueue 이후 변경됐습니다: ${input.job.surfaceId}`,
      false,
      true,
    );
  }

  const started = new Date();
  const object = await input.storage.getObjectBytes(row.storageKey);
  const actualSha256 = createHash("sha256").update(object.body).digest("hex");
  if (actualSha256 !== input.job.sourceSha256) {
    throw new ApplicationPrecomputeProcessingError(
      "source_sha_mismatch",
      `R2 Kordoc 원본 바이트와 DB SHA가 다릅니다: ${input.job.surfaceId}`,
      false,
      true,
    );
  }
  const document = (await analyzeRoundtripDocument({
    attachmentId: createHash("sha256").update(`${row.storageKey}:${actualSha256}`).digest("hex").slice(0, 20),
    filename: row.filename,
    declaredFormat: row.format,
    sourceSha256: actualSha256,
    body: object.body,
    apiKey: input.apiKey,
    model: input.policy.model,
    timeoutMs: input.policy.timeoutMs,
    transport: "api",
    candidateConcurrency: input.policy.candidateConcurrency,
    onPlannerUsage: (usage) => recordApplicationPrecomputeAttemptUsage({
      db: input.db,
      job: input.job,
      requestCount: usage.requestCount,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.costUsd,
    }),
  })).document;

  await renewApplicationPrecomputeLease({
    db: input.db,
    job: input.job,
    leaseSeconds: input.policy.leaseSeconds,
  });

  if (likelyApplicationRole(document.role) && document.fieldPlanning.status !== "llm") {
    const code = document.fieldPlanning.failureCode ?? "field_planner_failed";
    throw new ApplicationPrecomputeProcessingError(
      code,
      document.fieldPlanning.warning ?? `Kordoc 필드 모델 판정이 완료되지 않았습니다: ${code}`,
      isRetryableFailure(code),
    );
  }
  if (
    document.fieldPlanning.status === "llm"
    && (
      document.fieldPlanning.costUsd === null
      || document.fieldPlanning.costUsd === undefined
      || (document.fieldPlanning.inputTokens ?? 0) + (document.fieldPlanning.outputTokens ?? 0) === 0
    )
  ) {
    throw new ApplicationPrecomputeProcessingError(
      "usage_capture_missing",
      "Anthropic Kordoc 필드 판정 usage 또는 비용을 기록하지 못했습니다.",
      false,
      true,
    );
  }

  const run: ApplicationRoundtripRun = {
    version: APPLICATION_ROUNDTRIP_VERSION,
    runId: `application-precompute-${input.job.id}`,
    grantId: row.grantId,
    source: row.source,
    sourceId: row.sourceId,
    title: row.title,
    engine: "kordoc",
    engineVersion: KORDOC_VERSION,
    parentLabRunId: null,
    transport: "api",
    requestedModel: input.policy.model,
    timeoutMs: input.policy.timeoutMs,
    candidateLimit: document.fieldPlanning.candidateLimit ?? ROUNDTRIP_FIELD_CANDIDATE_LIMIT,
    candidateConcurrency: input.policy.candidateConcurrency,
    failureCode: document.fieldPlanning.failureCode ?? null,
    startedAt: started.toISOString(),
    durationMs: Date.now() - started.getTime(),
    sourceCount: 1,
    skippedDocumentCount: 0,
    documents: [document],
    recommendedAttachmentId: likelyApplicationRole(document.role) ? document.attachmentId : null,
    recommendationReason: likelyApplicationRole(document.role)
      ? "운영 Kordoc 선분석 대상 지원 문서"
      : "지원서가 아닌 문서로 분류됨",
    error: null,
  };
  const plan = buildApplicationPrecomputeSurfacePlan({
    surface: {
      id: row.surfaceId,
      title: row.title,
      type: row.type,
      format: row.format,
      sourceAttachment: row.sourceAttachment,
      sourceSha256: actualSha256,
    },
    run,
    analysisVersion: input.job.analysisVersion,
    sourceSha256: actualSha256,
    document,
    parentDeepAnalysisRunId: input.job.deepAnalysisRunId,
  });
  const store = createFieldCandidateStore({ db: input.db, storage: input.storage });
  const saved = await store.saveFieldCandidates({
    surfaceId: plan.surfaceId,
    set: plan.candidateSet,
    metadata: plan.metadata,
  });
  const prepared: PreparedApplicationPrecomputeSurface = {
    ...plan,
    artifactId: saved.artifactId,
    artifactSha256: saved.sha256,
  };
  const applied = await input.db.transaction(async (tx) => {
    await renewApplicationPrecomputeLease({
      db: tx,
      job: input.job,
      leaseSeconds: input.policy.leaseSeconds,
    });
    return applyPreparedGrantApplicationPrecompute({
      db: tx,
      prepared: {
        grantId: row.grantId,
        parentLabRunId: null,
        roundtripRunId: run.runId,
        surfaces: [prepared],
      },
    });
  });
  const planning = document.fieldPlanning;
  return {
    resultStatus: plan.status,
    artifactId: saved.artifactId,
    summary: {
      surfaceId: row.surfaceId,
      sourceSha256: actualSha256,
      sourceCount: 1,
      documentCount: 1,
      fieldCount: plan.fields.length,
      candidateCount: plan.candidateSet.candidates.length,
      role: document.role,
      coverageStatus: document.fieldCoverage.status,
      transport: "api",
      model: input.policy.model,
      analysisVersion: input.job.analysisVersion,
      deepAnalysisRunId: input.job.deepAnalysisRunId,
      materialization: applied,
    },
    requestCount: planning.requestCount ?? 0,
    inputTokens: planning.inputTokens ?? 0,
    outputTokens: planning.outputTokens ?? 0,
    costUsd: planning.costUsd ?? null,
  };
}

function isRetryableFailure(code: string): boolean {
  return code === "request_timeout"
    || code === "http_error"
    || code === "request_failed";
}
