import { createHash } from "node:crypto";
import { and, eq, isNotNull } from "drizzle-orm";
import { parse, VERSION } from "kordoc";
import {
  APPLICATION_ROUNDTRIP_VERSION,
  type ApplicationRoundtripRun,
  type RoundtripChoiceGroup,
  type RoundtripFieldPlanningSummary,
  type RoundtripParsedDocument,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import {
  classifyRoundtripDocument,
  declaredRoundtripFormat,
  extractLocatedRoundtripFields,
  likelyApplicationRole,
} from "./core";
import { extractContextualRoundtripFields } from "./editable-regions";
import { planRoundtripFields } from "./field-planner";
import {
  buildRoundtripRunId,
  saveRoundtripRun,
  type RoundtripRunManifest,
} from "./store";
import { extractHwpFormChoiceGroups } from "./hwp-form-controls";

const MAX_DOCUMENTS = 10;
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 120 * 1024 * 1024;

export class ApplicationRoundtripAnalyzeError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
    this.name = "ApplicationRoundtripAnalyzeError";
  }
}

export async function runApplicationRoundtripAnalysis(grantId: string): Promise<ApplicationRoundtripRun> {
  const started = new Date();
  const startedMs = Date.now();
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

      const parsed = await parse(object.body);
      if (!parsed.success) throw new Error(`${parsed.code}: ${parsed.error}`);
      if (parsed.fileType !== "hwp" && parsed.fileType !== "hwpx") {
        throw new Error(`확장자는 ${attachment.format}이지만 실제 감지 형식은 ${parsed.fileType}입니다.`);
      }

      const located = extractLocatedRoundtripFields(parsed.blocks, sourceSha256);
      const contextualFields = extractContextualRoundtripFields(parsed.blocks, sourceSha256);
      const allFields = [...located.fields, ...contextualFields];
      const warnings = (parsed.warnings ?? []).map((warning) => `${warning.code}: ${warning.message}`);
      let choiceGroups: RoundtripChoiceGroup[] = [];
      if (parsed.fileType === "hwp") {
        try {
          choiceGroups = extractHwpFormChoiceGroups(object.body, sourceSha256);
          suppressChoiceBackedTextFields(allFields, choiceGroups.map((group) => group.normalizedLabel));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          warnings.push(`HWP_FORM_CONTROL_SCAN_FAILED: ${message}`);
        }
      }
      const classification = classifyRoundtripDocument({
        filename: attachment.filename,
        markdown: parsed.markdown,
        fields: allFields,
        formConfidence: located.formConfidence,
      });
      const planned = likelyApplicationRole(classification.role)
        ? await planRoundtripFields({
          fields: allFields,
          markdown: parsed.markdown,
          apiKey: resolveAnthropicApiKey(),
        })
        : {
          fields: allFields,
          summary: skippedFieldPlanning(allFields.length),
        };
      suppressContextBackedFormFields(planned.fields);
      suppressUnsafeKordocHeaderFields(planned.fields);
      planned.summary = finalizeFieldPlanning(planned.summary, planned.fields);
      if (planned.summary.warning) warnings.push(`FIELD_PLAN: ${planned.summary.warning}`);
      const attachmentId = createHash("sha256")
        .update(`${attachment.storageKey}:${sourceSha256}`)
        .digest("hex")
        .slice(0, 20);
      const document: RoundtripParsedDocument = {
        attachmentId,
        filename: attachment.filename,
        declaredFormat: attachment.format,
        detectedFormat: parsed.fileType,
        sourceSha256,
        byteLength,
        parseDurationMs: Date.now() - parseStarted,
        parsedChars: parsed.markdown.length,
        blockCount: parsed.blocks.length,
        tableCount: parsed.blocks.filter((block) => block.type === "table").length,
        formConfidence: located.formConfidence,
        role: classification.role,
        roleConfidence: classification.confidence,
        roleScores: classification.scores,
        roleSignals: classification.signals,
        fields: planned.fields,
        choiceGroups,
        emptyFieldCount: planned.fields.filter((field) => field.source === "kordoc-form" && field.empty).length,
        recommendedInputFieldCount: planned.fields.filter((field) => field.recommendedInput).length,
        recommendedChoiceGroupCount: choiceGroups.length,
        fieldPlanning: planned.summary,
        markdownPreview: parsed.markdown.slice(0, 2_400),
        warnings,
        error: null,
      };
      documents.push(document);
      markdownByAttachmentId.set(attachmentId, parsed.markdown);
      manifest.attachments.push({
        attachmentId,
        filename: attachment.filename,
        storageKey: attachment.storageKey,
        sourceSha256,
        detectedFormat: parsed.fileType,
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
        fieldPlanning: skippedFieldPlanning(0),
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
  const run: ApplicationRoundtripRun = {
    version: APPLICATION_ROUNDTRIP_VERSION,
    runId,
    grantId: grant.id,
    source: grant.source,
    sourceId: grant.sourceId,
    title: grant.title,
    engine: "kordoc",
    engineVersion: VERSION,
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

function suppressChoiceBackedTextFields(
  fields: RoundtripParsedDocument["fields"],
  normalizedChoiceLabels: string[],
): void {
  const labels = new Set(normalizedChoiceLabels);
  for (const field of fields) {
    if (!labels.has(field.normalizedLabel)) continue;
    field.recommendedInput = false;
    field.inputLikelihood = Math.min(field.inputLikelihood, 0.1);
    field.inputSignals.push("HWP 네이티브 객관식 양식 개체로 대체");
  }
}

function suppressContextBackedFormFields(fields: RoundtripParsedDocument["fields"]): void {
  const contextual = fields.filter((field) => field.source === "contextual-region" && field.recommendedInput);
  for (const field of fields) {
    if (field.source !== "kordoc-form") continue;
    const duplicate = contextual.find((candidate) => {
      if (candidate.location.blockIndex !== field.location.blockIndex) return false;
      const labelsOverlap = candidate.normalizedLabel === field.normalizedLabel
        || candidate.normalizedLabel.startsWith(field.normalizedLabel)
        || field.normalizedLabel.startsWith(candidate.normalizedLabel);
      if (!labelsOverlap) return false;
      return candidate.location.row === field.location.row
        || Math.abs(candidate.location.row - field.location.row) <= 1;
    });
    if (!duplicate) continue;
    field.recommendedInput = false;
    field.inputLikelihood = Math.min(field.inputLikelihood, 0.1);
    field.inputSignals.push(`구조가 더 구체적인 “${duplicate.label}” 입력으로 대체`);
  }
}

function suppressUnsafeKordocHeaderFields(fields: RoundtripParsedDocument["fields"]): void {
  const knownLabels = new Set(fields.map((field) => field.normalizedLabel));
  for (const field of fields) {
    if (field.source !== "kordoc-form" || !field.recommendedInput) continue;
    const valueLabel = field.originalValue ? normalizeLoose(field.originalValue) : "";
    const valueLooksLikeAnotherLabel = valueLabel.length > 0
      && valueLabel !== field.normalizedLabel
      && (knownLabels.has(valueLabel)
        || /^(성명|직위|전화번호|이메일|특허등록|책임자|본과제에서역할|개인정보이용동의자필서명)$/.test(valueLabel));
    const ambiguousChoiceWithoutOptions = field.options.length === 0
      && field.inputKind === "text"
      && /(여부|체크)/.test(field.normalizedLabel);
    if (!valueLooksLikeAnotherLabel && !ambiguousChoiceWithoutOptions) continue;
    field.recommendedInput = false;
    field.inputLikelihood = Math.min(field.inputLikelihood, 0.1);
    field.inputSignals.push(
      valueLooksLikeAnotherLabel
        ? "인접 표 머리글을 값으로 오인한 Kordoc 후보 안전 차단"
        : "선택지 위치가 없는 여부·체크 필드 안전 차단",
    );
  }
}

function normalizeLoose(value: string): string {
  return value.normalize("NFKC").replace(/[\s:：·ㆍ._\-()\[\]{}<>「」『』]/g, "").toLowerCase();
}

function finalizeFieldPlanning(
  summary: RoundtripFieldPlanningSummary,
  fields: RoundtripParsedDocument["fields"],
): RoundtripFieldPlanningSummary {
  const acceptedCount = fields.filter((field) => field.recommendedInput).length;
  return {
    ...summary,
    candidateCount: fields.length,
    acceptedCount,
    rejectedCount: fields.length - acceptedCount,
  };
}

function resolveAnthropicApiKey(): string | null {
  return process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTROPHIC_API_KEY?.trim() || null;
}

function skippedFieldPlanning(candidateCount: number): RoundtripFieldPlanningSummary {
  return {
    status: "skipped",
    model: null,
    durationMs: 0,
    candidateCount,
    acceptedCount: 0,
    rejectedCount: candidateCount,
    warning: null,
  };
}

function roleLabel(role: RoundtripParsedDocument["role"]): string {
  if (role === "application_form") return "지원·신청서";
  if (role === "business_plan") return "사업계획서";
  if (role === "mixed_form") return "신청서+사업계획서 혼합 양식";
  if (role === "announcement") return "공고문";
  if (role === "evidence") return "증빙·동의서";
  return "미분류 문서";
}
