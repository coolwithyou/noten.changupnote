import { parse } from "kordoc";
import type {
  RoundtripDocumentFormat,
  RoundtripFieldPlanningSummary,
  RoundtripLlmTransport,
  RoundtripParsedDocument,
} from "@/lib/server/analysis-lab/application-roundtrip/contract";
import {
  classifyRoundtripDocument,
  extractLocatedRoundtripFields,
  likelyApplicationRole,
} from "./core";
import { extractContextualRoundtripFields } from "./editable-regions";
import {
  planRoundtripFields,
  resolveRoundtripFieldPlannerRuntimeConfig,
  type RoundtripFieldPlannerUsageEvent,
} from "./field-planner";
import { finalizeRoundtripFieldCoverage } from "./field-coverage";
import { extractHwpFormChoiceGroups } from "./hwp-form-controls";
import { verifyRoundtripParagraphFieldBindings } from "./native-paragraph-bindings";

export interface AnalyzeRoundtripDocumentInput {
  attachmentId: string;
  filename: string;
  declaredFormat: RoundtripDocumentFormat;
  sourceSha256: string;
  body: Uint8Array;
  apiKey: string | null;
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  transport?: RoundtripLlmTransport;
  candidateConcurrency?: number;
  parentLabRunId?: string | null;
  onPlannerUsage?: (usage: RoundtripFieldPlannerUsageEvent) => Promise<void> | void;
}

/**
 * KorDoc 파싱부터 문맥 판정·HWP 객관식 보강까지 한 문서에서 끝내는 공용 모듈.
 * dev 왕복 실험과 production workspace field 분석이 같은 안전 규칙을 공유한다.
 */
export async function analyzeRoundtripDocument(
  input: AnalyzeRoundtripDocumentInput,
): Promise<{ document: RoundtripParsedDocument; markdown: string }> {
  const startedMs = Date.now();
  const plannerRuntime = resolveRoundtripFieldPlannerRuntimeConfig(input);
  const parsed = await parse(Buffer.from(input.body));
  if (!parsed.success) throw new Error(`${parsed.code}: ${parsed.error}`);
  if (parsed.fileType !== "hwp" && parsed.fileType !== "hwpx") {
    throw new Error(`확장자는 ${input.declaredFormat}이지만 실제 감지 형식은 ${parsed.fileType}입니다.`);
  }

  const located = extractLocatedRoundtripFields(parsed.blocks, input.sourceSha256);
  const contextualFields = extractContextualRoundtripFields(parsed.blocks, input.sourceSha256);
  const allFields = [...located.fields, ...contextualFields];
  const warnings = (parsed.warnings ?? []).map((warning) => `${warning.code}: ${warning.message}`);
  let choiceGroups: RoundtripParsedDocument["choiceGroups"] = [];
  if (parsed.fileType === "hwp") {
    try {
      choiceGroups = extractHwpFormChoiceGroups(input.body, input.sourceSha256);
      suppressChoiceBackedTextFields(allFields, choiceGroups.map((group) => group.normalizedLabel));
    } catch (error) {
      warnings.push(`HWP_FORM_CONTROL_SCAN_FAILED: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const classification = classifyRoundtripDocument({
    filename: input.filename,
    markdown: parsed.markdown,
    fields: allFields,
    formConfidence: located.formConfidence,
  });
  const planned = likelyApplicationRole(classification.role)
    ? await planRoundtripFields({
        fields: allFields,
        markdown: parsed.markdown,
        apiKey: input.apiKey,
        model: plannerRuntime.requestedModel,
        timeoutMs: plannerRuntime.timeoutMs,
        transport: plannerRuntime.transport,
        candidateConcurrency: plannerRuntime.candidateConcurrency,
        parentLabRunId: plannerRuntime.parentLabRunId,
        ...(input.onPlannerUsage ? { onUsage: input.onPlannerUsage } : {}),
        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
      })
    : {
        fields: allFields,
        summary: skippedFieldPlanning(allFields.length, plannerRuntime),
      };
  if (parsed.fileType === "hwp" || parsed.fileType === "hwpx") {
    const paragraphBindings = await verifyRoundtripParagraphFieldBindings({
      body: input.body,
      fields: planned.fields,
    });
    for (const warning of paragraphBindings.warnings) {
      warnings.push(`FIELD_NATIVE_BINDING_SKIPPED: ${warning}`);
    }
  }
  suppressContextBackedFormFields(planned.fields);
  suppressUnsafeKordocHeaderFields(planned.fields);
  const fieldCoverage = finalizeRoundtripFieldCoverage(planned.fields);
  planned.summary = finalizeFieldPlanning(planned.summary, planned.fields);
  if (planned.summary.warning) warnings.push(`FIELD_PLAN: ${planned.summary.warning}`);
  for (const issue of fieldCoverage.unresolvedCandidates) {
    warnings.push(`FIELD_COVERAGE_REVIEW: ${issue.label} — ${issue.reason}`);
  }
  for (const issue of fieldCoverage.structuralWarnings) {
    warnings.push(`FIELD_COVERAGE_PARTIAL: ${issue.label} — ${issue.reason}`);
  }

  return {
    document: {
      attachmentId: input.attachmentId,
      filename: input.filename,
      declaredFormat: input.declaredFormat,
      detectedFormat: parsed.fileType,
      sourceSha256: input.sourceSha256,
      byteLength: input.body.byteLength,
      parseDurationMs: Date.now() - startedMs,
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
      emptyFieldCount: planned.fields.filter((field) => field.source !== "contextual-region" && field.empty).length,
      recommendedInputFieldCount: planned.fields.filter((field) => field.recommendedInput).length,
      recommendedChoiceGroupCount: choiceGroups.length,
      fieldPlanning: planned.summary,
      fieldCoverage,
      markdownPreview: parsed.markdown.slice(0, 2_400),
      warnings,
      error: null,
    },
    markdown: parsed.markdown,
  };
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
    if (field.source !== "kordoc-form" && field.source !== "rhwp-structural") continue;
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
  const knownLabels = new Set(
    fields.filter((field) => field.recommendedInput).map((field) => field.normalizedLabel),
  );
  for (const field of fields) {
    if ((field.source !== "kordoc-form" && field.source !== "rhwp-structural") || !field.recommendedInput) continue;
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
        ? "인접 표 머리글을 값으로 오인한 KorDoc 후보 안전 차단"
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

function skippedFieldPlanning(
  candidateCount: number,
  runtime: ReturnType<typeof resolveRoundtripFieldPlannerRuntimeConfig>,
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
    failureCode: null,
  };
}
