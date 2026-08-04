import { createHash } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { VERSION } from "kordoc";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
  type RoundtripFailureCode,
  type RoundtripFieldPlanningSummary,
  type RoundtripLlmTransport,
  type RoundtripParsedDocument,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  classifyRoundtripDocument,
  declaredRoundtripFormat,
  likelyApplicationRole,
} from "./core";
import { analyzeRoundtripDocument } from "./analyze-document";
import { resolveRoundtripFieldPlannerRuntimeConfig } from "./field-planner";
import { emptyRoundtripFieldCoverage } from "./field-coverage";
import {
  buildRoundtripRunId,
  saveRoundtripRun,
  type RoundtripRunManifest,
} from "./store";

const MAX_DOCUMENTS = 10;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;

export class ApplicationRoundtripAnalyzeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ApplicationRoundtripAnalyzeError";
  }
}

export interface ApplicationRoundtripAnalysisOptions {
  apiKey?: string | null;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  transport?: RoundtripLlmTransport;
  candidateConcurrency?: number;
  parentLabRunId?: string | null;
}

export async function runApplicationRoundtripAnalysis(
  grantId: string,
  options?: ApplicationRoundtripAnalysisOptions,
): Promise<ApplicationRoundtripRun> {
  const started = new Date();
  const startedMs = Date.now();
  const plannerRuntime = resolveRoundtripFieldPlannerRuntimeConfig(options);
  const apiKey = options?.apiKey === undefined ? resolveAnthropicApiKey() : options.apiKey;
  const db = getCunoteDb();
  const grantRows = await db
    .select({
      id: schema.grants.id,
      source: schema.grants.source,
      sourceId: schema.grants.sourceId,
      title: schema.grants.title,
    })
    .from(schema.grants)
    .where(eq(schema.grants.id, grantId))
    .limit(1);
  const grant = grantRows[0];
  if (!grant) throw new ApplicationRoundtripAnalyzeError("grant_not_found", "공고를 찾지 못했습니다.", 404);

  const archiveRows = await db
    .select({
      filename: schema.grantAttachmentArchives.filename,
      storageKey: schema.grantAttachmentArchives.storageKey,
      sha256: schema.grantAttachmentArchives.sha256,
      bytes: schema.grantAttachmentArchives.bytes,
    })
    .from(schema.grantAttachmentArchives)
    .where(
      and(
        eq(schema.grantAttachmentArchives.source, grant.source),
        eq(schema.grantAttachmentArchives.sourceId, grant.sourceId),
        isNotNull(schema.grantAttachmentArchives.storageKey),
      ),
    );

  const seenStorageKeys = new Set<string>();
  const eligible = archiveRows
    .flatMap((row) => {
      const format = declaredRoundtripFormat(row.filename);
      return format && row.storageKey ? [{ ...row, format, storageKey: row.storageKey }] : [];
    })
    .filter((row) => {
      if (seenStorageKeys.has(row.storageKey)) return false;
      seenStorageKeys.add(row.storageKey);
      return true;
    })
    .sort((a, b) => filenamePriority(b.filename) - filenamePriority(a.filename))
    .slice(0, MAX_DOCUMENTS);
  if (eligible.length === 0) {
    throw new ApplicationRoundtripAnalyzeError(
      "hwp_attachment_not_found",
      "보관 원본이 있는 HWP/HWPX 첨부를 찾지 못했습니다.",
      404,
    );
  }

  const declaredTotal = eligible.reduce((sum, item) => sum + (item.bytes ?? 0), 0);
  if (declaredTotal > MAX_TOTAL_BYTES) {
    throw new ApplicationRoundtripAnalyzeError(
      "attachments_too_large",
      `HWP/HWPX 첨부 합계가 실험 상한 ${Math.round(MAX_TOTAL_BYTES / 1024 / 1024)}MB를 넘습니다.`,
      413,
    );
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    throw new ApplicationRoundtripAnalyzeError(
      "storage_not_configured",
      "R2 환경 설정이 없어 보관 원본을 불러올 수 없습니다.",
      503,
    );
  }

  const runId = buildRoundtripRunId(started);
  const documents: RoundtripParsedDocument[] = [];
  const markdownByAttachmentId = new Map<string, string>();
  const manifest: RoundtripRunManifest = {
    version: 1,
    runId,
    grantId: grant.id,
    source: grant.source,
    sourceId: grant.sourceId,
    attachments: [],
  };
  let downloadedBytes = 0;

  // 로컬 dev 실험이라도 R2와 파서에 순간 부하를 주지 않도록 문서 단위로 순차 처리한다.
  for (const attachment of eligible) {
    const parseStarted = Date.now();
    let sourceSha256: string | null = null;
    let byteLength: number | null = null;
    try {
      const object = await storage.getObjectBytes(attachment.storageKey);
      byteLength = object.body.byteLength;
      downloadedBytes += byteLength;
      if (byteLength > MAX_DOCUMENT_BYTES || downloadedBytes > MAX_TOTAL_BYTES) {
        throw new Error("파일 또는 누적 다운로드 크기가 실험 상한을 넘었습니다.");
      }
      sourceSha256 = createHash("sha256").update(object.body).digest("hex");
      if (attachment.sha256 && /^[a-f0-9]{64}$/i.test(attachment.sha256) && attachment.sha256 !== sourceSha256) {
        throw new Error("DB의 원본 SHA-256과 R2에서 읽은 바이트가 일치하지 않습니다.");
      }

      const attachmentId = createHash("sha256")
        .update(`${attachment.storageKey}:${sourceSha256}`)
        .digest("hex")
        .slice(0, 20);
      const analyzed = await analyzeRoundtripDocument({
        attachmentId,
        filename: attachment.filename,
        declaredFormat: attachment.format,
        sourceSha256,
        body: object.body,
        apiKey,
        model: plannerRuntime.requestedModel,
        timeoutMs: plannerRuntime.timeoutMs,
        transport: plannerRuntime.transport,
        candidateConcurrency: plannerRuntime.candidateConcurrency,
        parentLabRunId: plannerRuntime.parentLabRunId,
        ...(options?.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
      });
      documents.push(analyzed.document);
      markdownByAttachmentId.set(attachmentId, analyzed.markdown);
      manifest.attachments.push({
        attachmentId,
        filename: attachment.filename,
        storageKey: attachment.storageKey,
        sourceSha256,
        detectedFormat: analyzed.document.detectedFormat as "hwp" | "hwpx",
      });
    } catch (error) {
      const attachmentId = createHash("sha256")
        .update(`${attachment.storageKey}:${attachment.filename}`)
        .digest("hex")
        .slice(0, 20);
      documents.push({
        attachmentId,
        filename: attachment.filename,
        declaredFormat: attachment.format,
        detectedFormat: null,
        sourceSha256,
        byteLength,
        parseDurationMs: Date.now() - parseStarted,
        parsedChars: 0,
        blockCount: 0,
        tableCount: 0,
        formConfidence: 0,
        role: "unknown",
        roleConfidence: 0,
        roleScores: { applicationForm: 0, businessPlan: 0, announcement: 0, evidence: 0 },
        roleSignals: [],
        fields: [],
        choiceGroups: [],
        emptyFieldCount: 0,
        recommendedInputFieldCount: 0,
        recommendedChoiceGroupCount: 0,
        fieldPlanning: skippedFieldPlanning(0, plannerRuntime, "document_analysis_failed"),
        fieldCoverage: emptyRoundtripFieldCoverage(),
        markdownPreview: "",
        warnings: [],
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const recommended = [...documents]
    .filter((document) => document.error === null
      && (document.recommendedInputFieldCount > 0 || document.recommendedChoiceGroupCount > 0))
    .sort((a, b) => recommendationScore(b) - recommendationScore(a))[0] ?? null;
  const successful = documents.filter((document) => document.error === null).length;
  const failureCode = aggregateFailureCode(documents, successful);
  const run: ApplicationRoundtripRun = {
    version: APPLICATION_ROUNDTRIP_VERSION,
    runId,
    grantId: grant.id,
    source: grant.source,
    sourceId: grant.sourceId,
    title: grant.title,
    engine: "kordoc",
    engineVersion: VERSION,
    parentLabRunId: plannerRuntime.parentLabRunId,
    transport: plannerRuntime.transport,
    requestedModel: plannerRuntime.requestedModel,
    timeoutMs: plannerRuntime.timeoutMs,
    candidateLimit: plannerRuntime.candidateLimit,
    candidateConcurrency: plannerRuntime.candidateConcurrency,
    failureCode,
    startedAt: started.toISOString(),
    durationMs: Date.now() - startedMs,
    documents,
    recommendedAttachmentId: recommended?.attachmentId ?? null,
    recommendationReason: recommended
      ? `${roleLabel(recommended.role)}로 분류됐고 텍스트 입력 ${recommended.recommendedInputFieldCount}개, 객관식 ${recommended.recommendedChoiceGroupCount}개가 있어 우선 선택했습니다.`
      : "파싱 성공 문서 중 텍스트 또는 객관식 입력 대상을 찾은 문서가 없습니다. 문서별 결과를 직접 확인해 주세요.",
    error: successful > 0 ? null : "모든 HWP/HWPX 첨부 파싱에 실패했습니다.",
  };
  await saveRoundtripRun({ run, manifest, markdownByAttachmentId });
  return run;
}

function filenamePriority(filename: string): number {
  const classification = classifyRoundtripDocument({ filename, markdown: "", fields: [], formConfidence: 0 });
  return (likelyApplicationRole(classification.role) ? 100 : 0) + Math.max(...Object.values(classification.scores));
}

function recommendationScore(document: RoundtripParsedDocument): number {
  const role = likelyApplicationRole(document.role) ? 100 : document.role === "unknown" ? 0 : -50;
  return role
    + document.recommendedInputFieldCount * 2
    + document.recommendedChoiceGroupCount * 3
    + document.formConfidence * 10
    + document.roleConfidence * 5;
}

function resolveAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTROPHIC_API_KEY?.trim() || null;
}

function skippedFieldPlanning(
  candidateCount: number,
  runtime: ReturnType<typeof resolveRoundtripFieldPlannerRuntimeConfig>,
  failureCode: RoundtripFailureCode | null,
): RoundtripFieldPlanningSummary {
  return {
    status: "skipped",
    model: null,
    durationMs: 0,
    candidateCount,
    acceptedCount: 0,
    rejectedCount: candidateCount,
    warning: null,
    transport: runtime.transport,
    requestedModel: runtime.requestedModel,
    timeoutMs: runtime.timeoutMs,
    candidateLimit: runtime.candidateLimit,
    candidateConcurrency: runtime.candidateConcurrency,
    parentLabRunId: runtime.parentLabRunId,
    failureCode,
  };
}

function aggregateFailureCode(
  documents: RoundtripParsedDocument[],
  successfulCount: number,
): RoundtripFailureCode | null {
  if (successfulCount === 0) return "all_documents_failed";
  const fieldPlanningCodes = new Set(
    documents.flatMap((document) => document.fieldPlanning.failureCode ? [document.fieldPlanning.failureCode] : []),
  );
  const priorities: RoundtripFailureCode[] = [
    "window_exhausted",
    "document_analysis_failed",
    "request_timeout",
    "transport_not_configured",
    "http_error",
    "invalid_response",
    "request_failed",
    "api_key_missing",
  ];
  for (const code of priorities) {
    if (fieldPlanningCodes.has(code)) return code;
  }
  return documents.some((document) => document.error !== null) ? "document_analysis_failed" : null;
}

function roleLabel(role: RoundtripParsedDocument["role"]): string {
  if (role === "application_form") return "지원·신청서";
  if (role === "business_plan") return "사업계획서";
  if (role === "mixed_form") return "신청서+사업계획서 혼합 양식";
  if (role === "announcement") return "공고문";
  if (role === "evidence") return "증빙·동의서";
  return "미분류 문서";
}
