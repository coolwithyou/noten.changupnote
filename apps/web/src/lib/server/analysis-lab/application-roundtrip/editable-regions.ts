import { createHash } from "node:crypto";
import type { IRBlock, IRCell, IRTable } from "kordoc";
import type {
  RoundtripFieldCandidate,
  RoundtripFieldInputKind,
  RoundtripFieldOption,
  RoundtripFieldWriteOperation,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { normalizeRoundtripLabel } from "./core";

const UNIT_PATTERN = /^\(\s*(천원|원|만원|백만원|억원|명|건|개|회|%|년|개월|일|시간)\s*\)$/;
const YEAR_PATTERN = /^(?:19|20)\d{2}년$/;
const CHOICE_MARKER_PATTERN = /[□■☐☑☒✓]/g;
const SELECTED_MARKERS = new Set(["■", "☑", "☒", "✓"]);
const INSTRUCTION_PATTERN = /(○|체크|선택).{0,20}(표시|기재)|(?:보유|해당).{0,30}(○|체크).{0,10}표시/;
const NARRATIVE_ACTION_PATTERN = /(서술|제시|작성|기재|설명|명시|기술)/;
const CONTEXTUAL_FIELD_LIMIT = 240;

export function extractContextualRoundtripFields(
  blocks: IRBlock[],
  sourceSha256: string,
): RoundtripFieldCandidate[] {
  const fields: RoundtripFieldCandidate[] = [];

  blocks.forEach((block, blockIndex) => {
    if (fields.length >= CONTEXTUAL_FIELD_LIMIT) return;
    if (block.type === "table" && block.table) {
      extractTableContextualFields(block.table, blockIndex, block.pageNumber ?? null, sourceSha256, fields);
      return;
    }
    if (block.type === "paragraph" || block.type === "list") {
      extractNarrativeFields(blocks, blockIndex, block, sourceSha256, fields);
    }
  });

  return deduplicateContextualFields(fields).slice(0, CONTEXTUAL_FIELD_LIMIT);
}

function extractTableContextualFields(
  table: IRTable,
  blockIndex: number,
  pageNumber: number | null,
  sourceSha256: string,
  fields: RoundtripFieldCandidate[],
): void {
  table.cells.forEach((row, rowIndex) => {
    row.forEach((cell, colIndex) => {
      const text = cell.text.trim();
      if (!text) return;

      const choiceOptions = parseTextChoiceOptions(text, sourceSha256, blockIndex, rowIndex, colIndex);
      if (choiceOptions.length >= 2) {
        const label = findRowLabel(table, rowIndex, colIndex) ?? `선택 항목 ${rowIndex + 1}`;
        const inputKind = inferChoiceInputKind(label, choiceOptions);
        fields.push(createContextualField({
          sourceSha256,
          blockIndex,
          row: rowIndex,
          col: colIndex,
          pageNumber,
          label,
          originalValue: text,
          inputKind,
          writeOperation: "toggle_text_choice",
          helperText: text,
          unit: null,
          options: choiceOptions,
          expectedText: text,
          textStart: cell.text.indexOf(text),
          sampleValue: "",
          sampleReason: inputKind === "single_choice" ? "객관식 첫 항목 샘플" : "객관식 복수 항목 샘플",
          signals: ["셀 안의 □/☐ 선택 마커", "인접 행 라벨 결합"],
          confidence: 0.97,
        }));
        return;
      }

      const unitMatch = text.match(UNIT_PATTERN);
      if (unitMatch) {
        const rowLabel = findRowLabel(table, rowIndex, colIndex);
        if (!rowLabel) return;
        const columnLabel = findColumnHeader(table, rowIndex, colIndex, YEAR_PATTERN);
        const unit = unitMatch[1]!;
        const label = columnLabel ? `${rowLabel} · ${columnLabel}` : rowLabel;
        fields.push(createContextualField({
          sourceSha256,
          blockIndex,
          row: rowIndex,
          col: colIndex,
          pageNumber,
          label,
          originalValue: text,
          inputKind: "number",
          writeOperation: "insert_before_unit",
          helperText: columnLabel ? `${columnLabel} 기준, 문서 단위 ${unit}` : `문서 단위 ${unit}`,
          unit,
          options: [],
          expectedText: text,
          textStart: cell.text.indexOf(text),
          sampleValue: sampleNumericValue(rowLabel),
          sampleReason: `${unit} 단위 숫자 샘플`,
          signals: ["단위만 들어 있는 값 셀", columnLabel ? `열 머리글 ${columnLabel}` : "행 라벨 기반"],
          confidence: 0.98,
        }));
        return;
      }

      if (INSTRUCTION_PATTERN.test(text)) {
        const label = findColumnHeader(table, rowIndex, colIndex) ?? findRowLabel(table, rowIndex, colIndex);
        if (!label || label === text) return;
        fields.push(createContextualField({
          sourceSha256,
          blockIndex,
          row: rowIndex,
          col: colIndex,
          pageNumber,
          label: `${label} 보유 여부`,
          originalValue: text,
          inputKind: "single_choice",
          writeOperation: "replace_instruction",
          helperText: text,
          unit: null,
          options: buildBooleanOptions(sourceSha256, blockIndex, rowIndex, colIndex),
          expectedText: text,
          textStart: cell.text.indexOf(text),
          sampleValue: "",
          sampleReason: "보유 여부 ‘있음’ 샘플",
          signals: ["○ 표시 지시문", "윗행 항목 라벨 결합"],
          confidence: 0.96,
        }));
        return;
      }

      const referenceIndex = cell.text.search(/\n?\s*\[참고\]/);
      if (referenceIndex > 0) {
        const exampleText = cell.text.slice(0, referenceIndex).trim();
        const label = findRowLabel(table, rowIndex, colIndex);
        if (!label || !exampleText) return;
        const start = cell.text.indexOf(exampleText);
        fields.push(createContextualField({
          sourceSha256,
          blockIndex,
          row: rowIndex,
          col: colIndex,
          pageNumber,
          label,
          originalValue: exampleText,
          inputKind: "text",
          writeOperation: "replace_span",
          helperText: cell.text,
          unit: null,
          options: [],
          expectedText: exampleText,
          textStart: start,
          sampleValue: sampleExampleValue(label),
          sampleReason: "참고문 앞 예시 텍스트 교체 샘플",
          signals: ["값 셀의 예시 텍스트", "[참고] 안내문은 보존"],
          confidence: 0.94,
        }));
      }
    });
  });
}

function extractNarrativeFields(
  blocks: IRBlock[],
  blockIndex: number,
  block: IRBlock,
  sourceSha256: string,
  fields: RoundtripFieldCandidate[],
): void {
  const text = block.text ?? "";
  if (!text || !NARRATIVE_ACTION_PATTERN.test(text) || !/[（(][^\n)）]{2,40}[)）]/.test(text)) return;
  const sectionLabel = findSectionLabel(blocks, blockIndex);
  let offset = 0;
  for (const line of text.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    const trimmed = line.trim();
    const match = trimmed.match(/^[-·]\s*[（(]([^\n)）]{2,40})[)）]\s*(.+)$/);
    if (!match || !NARRATIVE_ACTION_PATTERN.test(match[2]!)) continue;
    const expectedStart = lineStart + line.indexOf(trimmed);
    const label = match[1]!.trim();
    fields.push(createContextualField({
      sourceSha256,
      blockIndex,
      row: null,
      col: null,
      pageNumber: block.pageNumber ?? null,
      label: sectionLabel ? `${sectionLabel} · ${label}` : label,
      originalValue: "",
      inputKind: "textarea",
      writeOperation: "replace_span",
      helperText: trimmed,
      unit: null,
      options: [],
      expectedText: trimmed,
      textStart: expectedStart,
      sampleValue: sampleNarrativeValue(label),
      sampleReason: "파란 작성 안내문을 대체하는 서술 샘플",
      signals: ["괄호형 작성 주제", "서술·제시 지시문"],
      confidence: 0.93,
    }));
  }
}

function createContextualField(input: {
  sourceSha256: string;
  blockIndex: number;
  row: number | null;
  col: number | null;
  pageNumber: number | null;
  label: string;
  originalValue: string;
  inputKind: RoundtripFieldInputKind;
  writeOperation: RoundtripFieldWriteOperation;
  helperText: string;
  unit: string | null;
  options: RoundtripFieldOption[];
  expectedText: string;
  textStart: number;
  sampleValue: string;
  sampleReason: string;
  signals: string[];
  confidence: number;
}): RoundtripFieldCandidate {
  const normalizedLabel = normalizeRoundtripLabel(input.label);
  const locationSeed = [input.sourceSha256, input.blockIndex, input.row ?? "block", input.col ?? "text", input.textStart, input.expectedText].join(":");
  return {
    fieldInstanceId: createHash("sha256").update(locationSeed).digest("hex").slice(0, 24),
    label: input.label,
    displayLabel: input.label,
    normalizedLabel,
    originalValue: input.originalValue,
    type: input.inputKind === "number" ? "amount" : "text",
    required: false,
    empty: input.originalValue.length === 0,
    recommendedInput: true,
    inputLikelihood: input.confidence,
    inputSignals: input.signals,
    sampleValue: input.sampleValue,
    sampleReason: input.sampleReason,
    source: "contextual-region",
    inputKind: input.inputKind,
    writeOperation: input.writeOperation,
    helperText: input.helperText,
    unit: input.unit,
    options: input.options,
    analysisSource: "heuristic",
    llmConfidence: null,
    location: {
      blockIndex: input.blockIndex,
      row: input.row ?? -1,
      col: input.col ?? -1,
      occurrence: 0,
      pageNumber: input.pageNumber,
      target: {
        kind: input.row === null ? "block_text" : "table_cell",
        row: input.row,
        col: input.col,
        textStart: input.textStart,
        textEnd: input.textStart + input.expectedText.length,
        expectedText: input.expectedText,
        expectedSha256: createHash("sha256").update(input.expectedText).digest("hex"),
      },
    },
  };
}

function parseTextChoiceOptions(
  text: string,
  sourceSha256: string,
  blockIndex: number,
  row: number,
  col: number,
): RoundtripFieldOption[] {
  const markers = [...text.matchAll(CHOICE_MARKER_PATTERN)];
  return markers.flatMap((marker, index) => {
    const start = (marker.index ?? 0) + marker[0].length;
    const end = markers[index + 1]?.index ?? text.length;
    const rawLabel = text.slice(start, end).trim();
    const label = rawLabel.replace(/[（(]\s*[)）]$/, "").trim();
    if (!label || label.length > 80) return [];
    return [{
      optionId: createHash("sha256")
        .update(`${sourceSha256}:${blockIndex}:${row}:${col}:${index}:${label}`)
        .digest("hex")
        .slice(0, 20),
      label,
      selected: SELECTED_MARKERS.has(marker[0]),
    }];
  });
}

function inferChoiceInputKind(label: string, options: RoundtripFieldOption[]): RoundtripFieldInputKind {
  const normalized = normalizeRoundtripLabel(label);
  const optionLabels = options.map((option) => normalizeRoundtripLabel(option.label)).join("|");
  if (/(구분|형태|여부|경험|대표자참여|상태)/.test(normalized)) return "single_choice";
  if (/(개인.*법인|있음.*없음|유.*무|예.*아니오)/.test(optionLabels)) return "single_choice";
  return "multiple_choice";
}

function buildBooleanOptions(
  sourceSha256: string,
  blockIndex: number,
  row: number,
  col: number,
): RoundtripFieldOption[] {
  return [
    { optionId: hashOption(sourceSha256, blockIndex, row, col, "yes"), label: "있음", selected: false, writeValue: "○" },
    { optionId: hashOption(sourceSha256, blockIndex, row, col, "no"), label: "없음", selected: false, writeValue: "" },
  ];
}

function hashOption(sourceSha256: string, blockIndex: number, row: number, col: number, value: string): string {
  return createHash("sha256").update(`${sourceSha256}:${blockIndex}:${row}:${col}:${value}`).digest("hex").slice(0, 20);
}

function findRowLabel(table: IRTable, row: number, col: number): string | null {
  const cells = table.cells[row] ?? [];
  for (let index = col - 1; index >= 0; index -= 1) {
    const text = compactCellLabel(cells[index]?.text ?? "");
    if (isUsefulLabel(text)) return text;
  }
  return null;
}

function findColumnHeader(table: IRTable, row: number, col: number, preferred?: RegExp): string | null {
  for (let index = row - 1; index >= 0; index -= 1) {
    const text = compactCellLabel(table.cells[index]?.[col]?.text ?? "");
    if (!isUsefulLabel(text)) continue;
    if (!preferred || preferred.test(text)) return text;
  }
  if (preferred) return findColumnHeader(table, row, col);
  return null;
}

function compactCellLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function isUsefulLabel(value: string): boolean {
  if (!value || value.length > 80 || UNIT_PATTERN.test(value)) return false;
  if (/^[신청기업현황담당\s]+$/.test(value.replace(/\n/g, ""))) return false;
  return !/^(구분|비고|번호|연번)$/.test(value);
}

function findSectionLabel(blocks: IRBlock[], blockIndex: number): string | null {
  for (let index = blockIndex - 1; index >= 0 && blockIndex - index <= 4; index -= 1) {
    const text = blocks[index]?.text?.trim();
    if (!text) continue;
    if (/^\d+(?:[-.]\d+)*[.)]?\s+/.test(text)) return text.replace(/^\d+(?:[-.]\d+)*[.)]?\s+/, "").trim();
  }
  return null;
}

function sampleNumericValue(label: string): string {
  if (/(종업원|인원|고용)/.test(label)) return "5";
  if (/(매출|연구개발비|금액|비용)/.test(label)) return "100000";
  return "10";
}

function sampleExampleValue(label: string): string {
  if (/(업종|표준산업분류)/.test(label.replace(/\s+/g, ""))) return "응용 소프트웨어 개발 및 공급업 (J58222)";
  return "사용자 입력 예시";
}

function sampleNarrativeValue(label: string): string {
  if (/정량/.test(label)) return "지원 기간 내 유료 고객 20개사 확보와 월 반복매출 3천만원 달성을 목표로 합니다.";
  if (/시급/.test(label)) return "시장 진입 시점을 놓치지 않기 위해 검증과 사업화를 이번 지원 기간 안에 완료해야 합니다.";
  if (/(일정|단계)/.test(label)) return "1개월차 요구사항 확정, 2~3개월차 개발, 4개월차 실증, 5개월차 성과 검증을 진행합니다.";
  return "보유 기술의 차별성과 사업화 계획을 근거와 수치 중심으로 구체적으로 작성한 샘플입니다.";
}

function deduplicateContextualFields(fields: RoundtripFieldCandidate[]): RoundtripFieldCandidate[] {
  const seen = new Set<string>();
  return fields.filter((field) => {
    const target = field.location.target;
    const key = `${field.location.blockIndex}:${target?.kind}:${target?.row}:${target?.col}:${target?.textStart}:${target?.textEnd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export interface ContextualEditRequest {
  field: RoundtripFieldCandidate;
  inputValue: string;
  selectedOptionIds: string[];
  documentValue: string;
}

export function prepareContextualEdits(
  fields: RoundtripFieldCandidate[],
  submitted: Record<string, string>,
  fieldChoices: Record<string, string[]>,
): ContextualEditRequest[] {
  return fields.flatMap((field) => {
    if (field.source !== "contextual-region" || !field.location.target) return [];
    if (field.inputKind === "single_choice" || field.inputKind === "multiple_choice") {
      const selectedOptionIds = fieldChoices[field.fieldInstanceId];
      if (!selectedOptionIds) return [];
      const originalIds = field.options.filter((option) => option.selected).map((option) => option.optionId);
      if (sameStringArray(selectedOptionIds, originalIds)) return [];
      return [{
        field,
        inputValue: field.options.filter((option) => selectedOptionIds.includes(option.optionId)).map((option) => option.label).join(", "),
        selectedOptionIds,
        documentValue: buildContextualDocumentValue(field, "", selectedOptionIds),
      }];
    }
    const inputValue = submitted[field.fieldInstanceId]?.trim();
    if (!inputValue) return [];
    const documentValue = buildContextualDocumentValue(field, inputValue, []);
    if (documentValue === field.location.target.expectedText) return [];
    return [{ field, inputValue, selectedOptionIds: [], documentValue }];
  });
}

export function applyContextualEdits(blocks: IRBlock[], edits: ContextualEditRequest[]): void {
  const grouped = new Map<string, ContextualEditRequest[]>();
  for (const edit of edits) {
    const target = edit.field.location.target!;
    const key = `${edit.field.location.blockIndex}:${target.kind}:${target.row ?? "-"}:${target.col ?? "-"}`;
    const bucket = grouped.get(key) ?? [];
    bucket.push(edit);
    grouped.set(key, bucket);
  }

  for (const group of grouped.values()) {
    const ordered = [...group].sort(
      (left, right) => right.field.location.target!.textStart - left.field.location.target!.textStart,
    );
    for (const edit of ordered) applyOneContextualEdit(blocks, edit);
  }
}

function applyOneContextualEdit(blocks: IRBlock[], edit: ContextualEditRequest): void {
  const target = edit.field.location.target;
  if (!target) throw new Error(`직접 편집 위치가 없습니다: ${edit.field.label}`);
  const block = blocks[edit.field.location.blockIndex];
  if (!block) throw new Error(`직접 편집 블록을 찾지 못했습니다: ${edit.field.label}`);

  if (target.kind === "block_text") {
    const current = block.text ?? "";
    assertExpectedText(current, target.textStart, target.textEnd, target.expectedText, edit.field.label);
    block.text = replaceRange(current, target.textStart, target.textEnd, edit.documentValue);
    updateMatchingSpans(block, target.expectedText, edit.documentValue);
    return;
  }

  const cell = block.type === "table" && target.row !== null && target.col !== null
    ? block.table?.cells[target.row]?.[target.col]
    : undefined;
  if (!cell) throw new Error(`직접 편집 셀을 찾지 못했습니다: ${edit.field.label}`);
  assertExpectedText(cell.text, target.textStart, target.textEnd, target.expectedText, edit.field.label);
  const nextText = replaceRange(cell.text, target.textStart, target.textEnd, edit.documentValue);
  updateCellText(cell, cell.text, nextText, target.expectedText, edit.documentValue);
}

function buildContextualDocumentValue(
  field: RoundtripFieldCandidate,
  inputValue: string,
  selectedOptionIds: string[],
): string {
  if (field.writeOperation === "insert_before_unit") return `${inputValue} (${field.unit})`;
  if (field.writeOperation === "toggle_text_choice") {
    return toggleTextChoiceMarkers(field.location.target!.expectedText, field.options, selectedOptionIds);
  }
  if (field.writeOperation === "replace_instruction") {
    const selected = field.options.find((option) => selectedOptionIds.includes(option.optionId));
    return selected?.writeValue ?? selected?.label ?? "";
  }
  return inputValue;
}

function toggleTextChoiceMarkers(
  text: string,
  options: RoundtripFieldOption[],
  selectedOptionIds: string[],
): string {
  let optionIndex = 0;
  return text.replace(CHOICE_MARKER_PATTERN, () => {
    const option = options[optionIndex++];
    return option && selectedOptionIds.includes(option.optionId) ? "☑" : "□";
  });
}

function assertExpectedText(current: string, start: number, end: number, expected: string, label: string): void {
  const actual = current.slice(start, end);
  const actualHash = createHash("sha256").update(actual).digest("hex");
  const expectedHash = createHash("sha256").update(expected).digest("hex");
  if (actual !== expected || actualHash !== expectedHash) {
    throw new Error(`분석 뒤 원문 위치가 달라졌습니다: ${label}`);
  }
}

function replaceRange(value: string, start: number, end: number, replacement: string): string {
  return value.slice(0, start) + replacement + value.slice(end);
}

function updateCellText(cell: IRCell, previous: string, next: string, expected: string, replacement: string): void {
  cell.text = next;
  if (!cell.blocks) return;
  const nested = cell.blocks.find((block) => block.text?.includes(expected));
  if (!nested?.text) return;
  nested.text = nested.text.replace(expected, replacement);
  updateMatchingSpans(nested, expected, replacement);
  if (cell.blocks.length === 1 && cell.blocks[0]?.text === previous) cell.blocks[0].text = next;
}

function updateMatchingSpans(block: IRBlock, expected: string, replacement: string): void {
  if (!block.spans) return;
  const span = block.spans.find((item) => item.text.includes(expected));
  if (span) span.text = span.text.replace(expected, replacement);
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
