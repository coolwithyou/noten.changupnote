import type { DraftFieldAnswers } from "@/lib/server/documents/fieldAnswers";
import type { ConnectedDocumentField } from "@/lib/server/documents/documentFieldLink";
import { applyRhwpEditFields, buildRhwpEditFields, type RhwpEditField, type RhwpEditableDocument } from "./editPlan";
import { resolveRhwpFieldAnchors, type RhwpAnchorDocument, type RhwpFieldAnchor } from "./fieldAnchors";
import { exportVerifiedRhwpDocument, loadRhwp, type RhwpDocumentFormat } from "./client";

export interface RhwpWorkingDocument {
  draftId: string;
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  filename: string;
  /** Studio 스냅샷에 이미 반영된 빠른 작성 값. fieldId를 키로 쓴다. */
  materializedAnswers: Record<string, string>;
  skipped: Array<{ label: string; reason: string }>;
}

interface SourceDocument {
  bytes: Uint8Array;
  format: RhwpDocumentFormat;
  filename: string;
}

export interface RhwpStudioCompatibilityDocument {
  getValidationWarnings(): string;
  reflowLinesegs(): number;
}

export async function fetchRhwpSourceDocument(draftId: string): Promise<SourceDocument> {
  const response = await fetch(
    `/api/web/document-drafts/${encodeURIComponent(draftId)}/source-file`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(await sourceFileErrorMessage(response));
  const format = response.headers.get("x-cunote-document-format");
  if (format !== "hwp" && format !== "hwpx") throw new Error("원본 문서 형식을 확인하지 못했습니다.");
  const encodedFilename = response.headers.get("x-cunote-document-filename");
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    format,
    filename: encodedFilename ? decodeHeaderValue(encodedFilename) : `지원서-양식.${format}`,
  };
}

export async function prepareRhwpWorkingDocument(input: {
  draftId: string;
  answers: DraftFieldAnswers;
  connectedFields: readonly ConnectedDocumentField[];
  manualAnchors: readonly RhwpFieldAnchor[];
  duplicateLabels?: ReadonlySet<string>;
  base?: RhwpWorkingDocument | null;
}): Promise<RhwpWorkingDocument> {
  const source = input.base?.draftId === input.draftId
    ? input.base
    : await fetchRhwpSourceDocument(input.draftId);
  const rhwp = await loadRhwp();
  const document = new rhwp.HwpDocument(source.bytes);
  try {
    const plan = buildRhwpEditFields({
      answers: input.answers,
      connectedFields: input.connectedFields,
      ...(input.duplicateLabels ? { duplicateLabels: input.duplicateLabels } : {}),
    });
    const materialized = { ...(input.base?.materializedAnswers ?? {}) };
    const conflicts: Array<{ label: string; value: string; reason: string }> = [];
    const pendingFields = prepareRhwpDeltaFields({
      document,
      fields: plan.fields,
      previous: materialized,
      manualAnchors: input.manualAnchors,
      conflicts,
    });
    const applied = applyRhwpEditFields(document, pendingFields, input.manualAnchors);
    for (const entry of applied.filled) {
      const field = pendingFields.find((candidate) => candidate.label === entry.label);
      if (field?.fieldId) materialized[field.fieldId] = entry.value;
    }
    // 셀 텍스트 삽입이 기존 lineseg를 다시 무효화할 수 있으므로 모든 자동 입력이 끝난 최종
    // 문서에서 검사한다. Studio의 "자동 보정 (권장)"과 같은 core API로 정규화한 바이트만 넘긴다.
    normalizeRhwpStudioCompatibility(document, source.format);
    const verification = exportVerifiedRhwpDocument({ rhwp, document, format: source.format });
    return {
      draftId: input.draftId,
      bytes: verification.bytes,
      format: source.format,
      filename: source.filename,
      materializedAnswers: materialized,
      skipped: [...plan.skipped, ...conflicts, ...applied.skipped]
        .map(({ label, reason }) => ({ label, reason })),
    };
  } finally {
    document.free();
  }
}

/**
 * Studio에서 편집하기 전에 HWPX의 비표준 lineseg를 rhwp 권장 경로로 정규화한다.
 * HWP에는 적용하지 않으며, 구버전/비정상 경고 응답은 원본을 손상시키지 않도록 건너뛴다.
 */
export function normalizeRhwpStudioCompatibility(
  document: RhwpStudioCompatibilityDocument,
  format: RhwpDocumentFormat,
): number {
  if (format !== "hwpx") return 0;
  try {
    const report = JSON.parse(document.getValidationWarnings()) as { count?: unknown };
    if (typeof report.count !== "number" || !Number.isFinite(report.count) || report.count <= 0) return 0;
    const reflowed = document.reflowLinesegs();
    return Number.isFinite(reflowed) && reflowed > 0 ? reflowed : 0;
  } catch {
    return 0;
  }
}

export function prepareRhwpDeltaFields(input: {
  document: RhwpEditableDocument;
  fields: readonly RhwpEditField[];
  previous: Readonly<Record<string, string>>;
  manualAnchors: readonly RhwpFieldAnchor[];
  conflicts: Array<{ label: string; value: string; reason: string }>;
}): RhwpEditField[] {
  const changedTextFields = input.fields.filter((field) => {
    if (!field.fieldId || field.options?.length) return false;
    const previous = input.previous[field.fieldId];
    return previous !== undefined && previous !== field.value;
  });
  const descriptors = changedTextFields.map((field) => ({
    fieldId: field.fieldId!,
    label: field.label,
    fieldType: field.fieldType ?? "text",
    ...(field.fieldKey !== undefined ? { fieldKey: field.fieldKey } : {}),
    ...(field.sourceSpan !== undefined ? { sourceSpan: field.sourceSpan } : {}),
    ...(field.position !== undefined ? { position: field.position } : {}),
    ...(field.options !== undefined ? { options: field.options } : {}),
  }));
  const structural = canResolveAnchors(input.document)
    ? resolveRhwpFieldAnchors(input.document as RhwpAnchorDocument, descriptors)
    : [];
  const anchors = new Map(structural.map((anchor) => [anchor.fieldId, anchor]));
  for (const anchor of input.manualAnchors) anchors.set(anchor.fieldId, anchor);

  const pending: RhwpEditField[] = [];
  for (const field of input.fields) {
    const fieldId = field.fieldId;
    const previous = fieldId ? input.previous[fieldId] : undefined;
    if (previous === field.value) continue;
    if (previous === undefined || field.options?.length) {
      pending.push(field);
      continue;
    }
    const anchor = fieldId ? anchors.get(fieldId) : undefined;
    if (!anchor || !input.document.getTextInCell || !input.document.deleteTextInCell) {
      input.conflicts.push({
        label: field.label,
        value: field.value,
        reason: "Studio 편집본에서 이전 자동 입력 위치를 안전하게 확인하지 못해 새 값으로 덮어쓰지 않았습니다.",
      });
      continue;
    }
    const target = anchor.target;
    const length = input.document.getCellParagraphLength(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      target.cellParagraph,
    );
    const current = textFromCellResult(input.document.getTextInCell(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      target.cellParagraph,
      0,
      length,
    ));
    if (!current.startsWith(previous) || !isBlankOrUnit(current.slice(previous.length))) {
      input.conflicts.push({
        label: field.label,
        value: field.value,
        reason: "Studio에서 이 칸을 직접 고친 것으로 보여 빠른 작성 값으로 덮어쓰지 않았습니다.",
      });
      continue;
    }
    if (!parsedOk(input.document.deleteTextInCell(
      target.section,
      target.parentPara,
      target.controlIndex,
      target.cellIndex,
      target.cellParagraph,
      0,
      previous.length,
    ))) {
      input.conflicts.push({ label: field.label, value: field.value, reason: "이전 자동 입력값을 지우지 못했습니다." });
      continue;
    }
    pending.push(field);
  }
  return pending;
}

function canResolveAnchors(document: RhwpEditableDocument): document is RhwpEditableDocument & {
  pageCount(): number;
  getPageInfo(page: number): string;
  getTableCellBboxes(section: number, parentPara: number, controlIndex: number, pageHint?: number | null): string;
} {
  return Boolean(document.pageCount && document.getPageInfo && document.getTableCellBboxes);
}

function textFromCellResult(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "string") return parsed;
    if (parsed && typeof parsed === "object" && typeof (parsed as { text?: unknown }).text === "string") {
      return (parsed as { text: string }).text;
    }
  } catch {
    // rhwp 버전에 따라 일반 문자열을 직접 반환한다.
  }
  return value;
}

function isBlankOrUnit(value: string): boolean {
  return /^\s*(?:[([]?\s*(?:천원|백만원|억원|만원|원|명|개|건|년|개월|일|%|㎡|m²|km²)\s*[)\]]?)?\s*$/iu.test(value);
}

function parsedOk(value: string): boolean {
  try {
    return (JSON.parse(value) as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

function decodeHeaderValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function sourceFileErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } };
    if (payload.error?.message) return payload.error.message;
  } catch {
    // 비 JSON 응답은 기본 문구를 사용한다.
  }
  return "원본 HWP/HWPX 양식을 불러오지 못했습니다.";
}
