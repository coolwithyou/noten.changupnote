import { createHash } from "node:crypto";
import { deflateRawSync, inflateRawSync, inflateSync } from "node:zlib";
import * as CFB from "cfb";
import type {
  RoundtripChoiceGroup,
  RoundtripChoiceSelectionMode,
} from "@/features/dev/analysis-lab/application-roundtrip-contract";
import { normalizeRoundtripLabel } from "./core";
import { replaceOleStream } from "./ole-stream";

const TAG_PARA_TEXT = 67;
const TAG_CTRL_HEADER = 71;
const TAG_LIST_HEADER = 72;
const TAG_TABLE = 77;
const TAG_FORM_OBJECT = 91;

const FLAG_COMPRESSED = 1 << 0;
const FLAG_ENCRYPTED = 1 << 1;
const FLAG_DISTRIBUTION = 1 << 2;
const FLAG_DRM = 1 << 4;
const MAX_RECORDS = 500_000;
const MAX_SECTIONS = 256;
const MAX_DECOMPRESSED_SECTION_BYTES = 100 * 1024 * 1024;

interface HwpRecord {
  tagId: number;
  level: number;
  data: Buffer;
  dataOffset: number;
}

interface FormControlRef {
  caption: string;
  value: number;
  valueOffset: number;
  recordIndex: number;
}

interface TableCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  text: string;
  controls: FormControlRef[];
}

interface InternalChoiceGroup extends RoundtripChoiceGroup {
  refs: Array<FormControlRef & { optionId: string }>;
}

interface SectionScan {
  sectionIndex: number;
  path: string;
  stream: Buffer;
  groups: InternalChoiceGroup[];
}

interface HwpFormScan {
  compressed: boolean;
  sections: SectionScan[];
  groups: InternalChoiceGroup[];
}

export interface HwpFormChoicePatchResult {
  data: Uint8Array;
  formControlPatchedCount: number;
  groups: RoundtripChoiceGroup[];
  warnings: string[];
}

export function extractHwpFormChoiceGroups(
  bytes: Uint8Array,
  stableSourceSha256: string,
): RoundtripChoiceGroup[] {
  return publicGroups(scanHwpFormControls(bytes, stableSourceSha256).groups);
}

/**
 * Kordoc가 아직 IR로 노출하지 않는 HWP 5.x 네이티브 CheckBox 양식 개체의
 * Caption/Value를 읽어, 같은 길이의 Value:int:0|1 값만 바꾼다.
 */
export function patchHwpFormChoices(
  bytes: Uint8Array,
  stableSourceSha256: string,
  choices: Record<string, string[]>,
): HwpFormChoicePatchResult {
  const scan = scanHwpFormControls(bytes, stableSourceSha256);
  const requestedGroupIds = new Set(Object.keys(choices));
  if (requestedGroupIds.size === 0) {
    return {
      data: new Uint8Array(bytes),
      formControlPatchedCount: 0,
      groups: publicGroups(scan.groups),
      warnings: [],
    };
  }

  const knownGroups = new Map(scan.groups.map((group) => [group.groupId, group]));
  for (const groupId of requestedGroupIds) {
    if (!knownGroups.has(groupId)) throw new Error(`HWP 저장본에서 선택 그룹을 다시 찾지 못했습니다: ${groupId}`);
  }

  let formControlPatchedCount = 0;
  const changedSections = new Set<string>();
  const replacementStreams = new Map<string, Buffer>();
  for (const section of scan.sections) {
    const nextStream = Buffer.from(section.stream);
    let sectionChanged = false;
    for (const group of section.groups) {
      if (!requestedGroupIds.has(group.groupId)) continue;
      const selected = new Set(choices[group.groupId] ?? []);
      for (const ref of group.refs) {
        const nextValue = selected.has(ref.optionId) ? 1 : 0;
        if (ref.value === nextValue) continue;
        if (nextStream.readUInt16LE(ref.valueOffset) !== 48 + ref.value) {
          throw new Error(`HWP CheckBox Value 원본 검증에 실패했습니다: ${group.label} / ${ref.caption}`);
        }
        nextStream.writeUInt16LE(48 + nextValue, ref.valueOffset);
        formControlPatchedCount += 1;
        sectionChanged = true;
      }
    }
    if (!sectionChanged) continue;
    const content = scan.compressed ? deflateRawSync(nextStream) : nextStream;
    replacementStreams.set(section.path, content);
    changedSections.add(section.path);
  }

  if (formControlPatchedCount === 0) {
    return {
      data: new Uint8Array(bytes),
      formControlPatchedCount,
      groups: publicGroups(scan.groups),
      warnings: [],
    };
  }

  let written = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (const [path, content] of replacementStreams) written = replaceOleStream(written, path, content);
  verifyUnmodifiedStreams(bytes, written, changedSections);
  const outputGroups = extractHwpFormChoiceGroups(written, stableSourceSha256);
  return {
    data: new Uint8Array(written),
    formControlPatchedCount,
    groups: outputGroups,
    warnings: [],
  };
}

function scanHwpFormControls(bytes: Uint8Array, stableSourceSha256: string): HwpFormScan {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const cfb = CFB.read(input, { type: "buffer" });
  const header = CFB.find(cfb, "/FileHeader");
  if (!header?.content) throw new Error("HWP FileHeader 스트림이 없습니다.");
  const headerBytes = Buffer.from(header.content);
  if (headerBytes.length < 40) throw new Error("HWP FileHeader가 너무 짧습니다.");
  const flags = headerBytes.readUInt32LE(36);
  if (flags & (FLAG_ENCRYPTED | FLAG_DISTRIBUTION | FLAG_DRM)) {
    throw new Error("암호화·배포용·DRM HWP의 CheckBox 분석은 지원하지 않습니다.");
  }
  const compressed = (flags & FLAG_COMPRESSED) !== 0;
  const sectionEntries = cfb.FullPaths
    .map((fullPath, index) => ({
      path: normalizeCfbPath(fullPath),
      entry: cfb.FileIndex[index],
    }))
    .filter((item): item is { path: string; entry: CFB.CFB$Entry } =>
      Boolean(item.entry) && /^\/BodyText\/Section\d+$/.test(item.path))
    .sort((a, b) => sectionIndexFromPath(a.path) - sectionIndexFromPath(b.path))
    .slice(0, MAX_SECTIONS);
  if (sectionEntries.length === 0) throw new Error("HWP BodyText 섹션을 찾지 못했습니다.");

  const sections: SectionScan[] = [];
  let tableOrdinal = 0;
  for (const { path, entry } of sectionEntries) {
    const raw = Buffer.from(entry.content);
    const stream = compressed ? decompressStream(raw) : raw;
    const sectionIndex = sectionIndexFromPath(path);
    const scanned = scanSection(stream, sectionIndex, tableOrdinal, stableSourceSha256);
    tableOrdinal += scanned.tableCount;
    sections.push({ sectionIndex, path, stream, groups: scanned.groups });
  }
  return { compressed, sections, groups: sections.flatMap((section) => section.groups) };
}

function scanSection(
  stream: Buffer,
  sectionIndex: number,
  firstTableOrdinal: number,
  stableSourceSha256: string,
): { groups: InternalChoiceGroup[]; tableCount: number } {
  const records = readRecordsStrict(stream);
  const parents = buildParentIndexes(records);
  const groups: InternalChoiceGroup[] = [];
  let tableCount = 0;

  for (let ctrlIndex = 0; ctrlIndex < records.length; ctrlIndex += 1) {
    if (!isControl(records[ctrlIndex]!, "tbl ") || hasAncestorTable(ctrlIndex, records, parents)) continue;
    const ctrlLevel = records[ctrlIndex]!.level;
    const childEnd = findControlEnd(records, ctrlIndex, ctrlLevel);
    let tableRecordIndex = -1;
    for (let index = ctrlIndex + 1; index < childEnd; index += 1) {
      const record = records[index]!;
      if (record.level === ctrlLevel + 1 && record.tagId === TAG_TABLE && record.data.length >= 8) {
        tableRecordIndex = index;
        break;
      }
    }
    if (tableRecordIndex < 0) continue;
    const tableIndex = firstTableOrdinal + tableCount;
    tableCount += 1;
    const cells = readTableCells(records, tableRecordIndex + 1, childEnd);
    const buckets = new Map<string, { labelCell: TableCell; controls: FormControlRef[] }>();

    for (const controlCell of cells.filter((cell) => cell.controls.length > 0)) {
      const labelCell = findOwningLabelCell(cells, controlCell);
      if (!labelCell) continue;
      const key = `${labelCell.row}:${labelCell.col}`;
      const bucket = buckets.get(key) ?? { labelCell, controls: [] };
      bucket.controls.push(...controlCell.controls);
      buckets.set(key, bucket);
    }

    for (const { labelCell, controls } of buckets.values()) {
      const label = cleanVisibleText(labelCell.text);
      const normalizedLabel = normalizeRoundtripLabel(label);
      if (!normalizedLabel || controls.length < 2) continue;
      const groupId = stableId(
        `${stableSourceSha256}:${sectionIndex}:${tableIndex}:${labelCell.row}:${labelCell.col}:${normalizedLabel}`,
      );
      const refs = controls
        .sort((a, b) => a.recordIndex - b.recordIndex)
        .map((control, optionIndex) => ({
          ...control,
          optionId: stableId(`${groupId}:${optionIndex}:${normalizeRoundtripLabel(control.caption)}`),
        }));
      groups.push({
        groupId,
        label,
        normalizedLabel,
        selectionMode: inferSelectionMode(label, refs.map((ref) => ref.caption)),
        source: "hwp-form-control",
        options: refs.map((ref) => ({
          optionId: ref.optionId,
          label: cleanVisibleText(ref.caption),
          selected: ref.value === 1,
        })),
        location: {
          sectionIndex,
          tableIndex,
          row: labelCell.row,
          col: labelCell.col,
          pageNumber: null,
        },
        refs,
      });
    }
  }

  return { groups, tableCount };
}

function readTableCells(records: HwpRecord[], start: number, end: number): TableCell[] {
  const cells: TableCell[] = [];
  let index = start;
  while (index < end) {
    const record = records[index]!;
    if (record.tagId !== TAG_LIST_HEADER) {
      index += 1;
      continue;
    }
    const cellLevel = record.level;
    let next = index + 1;
    while (next < end) {
      const candidate = records[next]!;
      if (candidate.level < cellLevel) break;
      if (candidate.level === cellLevel && (candidate.tagId === TAG_LIST_HEADER || candidate.tagId === TAG_TABLE)) break;
      next += 1;
    }
    if (record.data.length >= 16) {
      const textParts: string[] = [];
      const controls: FormControlRef[] = [];
      for (let child = index + 1; child < next; child += 1) {
        const candidate = records[child]!;
        if (candidate.tagId === TAG_PARA_TEXT) textParts.push(decodeParagraphText(candidate.data));
        if (candidate.tagId === TAG_FORM_OBJECT) {
          const form = parseCheckBoxFormObject(candidate, child);
          if (form) controls.push(form);
        }
      }
      cells.push({
        col: record.data.readUInt16LE(8),
        row: record.data.readUInt16LE(10),
        colSpan: Math.max(1, record.data.readUInt16LE(12)),
        rowSpan: Math.max(1, record.data.readUInt16LE(14)),
        text: cleanVisibleText(textParts.join(" ")),
        controls,
      });
    }
    index = next;
  }
  return cells;
}

function findOwningLabelCell(cells: TableCell[], controlCell: TableCell): TableCell | null {
  const candidates = cells.filter((cell) =>
    cell.controls.length === 0
    && cleanVisibleText(cell.text).length > 0
    && cell.row <= controlCell.row
    && cell.row + cell.rowSpan > controlCell.row
    && cell.col + cell.colSpan <= controlCell.col);
  return candidates.sort((a, b) => {
    const aEdge = a.col + a.colSpan;
    const bEdge = b.col + b.colSpan;
    if (aEdge !== bEdge) return bEdge - aEdge;
    if (a.row !== b.row) return b.row - a.row;
    return b.col - a.col;
  })[0] ?? null;
}

function parseCheckBoxFormObject(record: HwpRecord, recordIndex: number): FormControlRef | null {
  if (record.data.length < 20) return null;
  const serialized = record.data.toString("utf16le");
  const name = readSerializedString(serialized, "Name");
  if (name && !/^CheckBox/i.test(name.value)) return null;
  if (!name && !serialized.includes("CheckBox")) return null;
  const caption = readSerializedString(serialized, "Caption");
  if (!caption || !cleanVisibleText(caption.value)) return null;
  const valueMarker = " Value:int:";
  const markerIndex = serialized.indexOf(valueMarker, caption.end);
  if (markerIndex < 0) return null;
  const valueCharIndex = markerIndex + valueMarker.length;
  const valueText = serialized[valueCharIndex];
  if (valueText !== "0" && valueText !== "1" && valueText !== "2") return null;
  return {
    caption: caption.value,
    value: Number(valueText),
    valueOffset: record.dataOffset + valueCharIndex * 2,
    recordIndex,
  };
}

function readSerializedString(serialized: string, property: string): { value: string; end: number } | null {
  const marker = `${property}:wstring:`;
  const markerIndex = serialized.indexOf(marker);
  if (markerIndex < 0) return null;
  const lengthStart = markerIndex + marker.length;
  const lengthEnd = serialized.indexOf(":", lengthStart);
  if (lengthEnd < 0) return null;
  const length = Number(serialized.slice(lengthStart, lengthEnd));
  if (!Number.isSafeInteger(length) || length < 0 || length > 10_000) return null;
  const valueStart = lengthEnd + 1;
  const end = valueStart + length;
  if (end > serialized.length) return null;
  return { value: serialized.slice(valueStart, end), end };
}

function inferSelectionMode(label: string, captions: string[]): RoundtripChoiceSelectionMode {
  if (captions.length !== 2) return "multiple";
  const normalizedLabel = normalizeRoundtripLabel(label);
  const normalizedOptions = captions.map(normalizeRoundtripLabel);
  const oppositePair = normalizedOptions.some((option) => /없음|미참여|미동의|아니오|법인/.test(option))
    && normalizedOptions.some((option) => /있음|참여|동의|예|개인/.test(option));
  return /(형태|여부)$/.test(normalizedLabel) || oppositePair ? "single" : "multiple";
}

function readRecordsStrict(stream: Buffer): HwpRecord[] {
  const records: HwpRecord[] = [];
  let offset = 0;
  while (offset < stream.length) {
    if (offset + 4 > stream.length || records.length >= MAX_RECORDS) {
      throw new Error("HWP 레코드 헤더 또는 레코드 수 상한을 벗어났습니다.");
    }
    const header = stream.readUInt32LE(offset);
    offset += 4;
    const tagId = header & 1023;
    const level = (header >>> 10) & 1023;
    let size = (header >>> 20) & 4095;
    if (size === 4095) {
      if (offset + 4 > stream.length) throw new Error("HWP 확장 레코드 헤더가 잘렸습니다.");
      size = stream.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + size > stream.length) throw new Error("HWP 레코드 데이터가 잘렸습니다.");
    records.push({ tagId, level, data: stream.subarray(offset, offset + size), dataOffset: offset });
    offset += size;
  }
  return records;
}

function buildParentIndexes(records: HwpRecord[]): Int32Array {
  const parents = new Int32Array(records.length).fill(-1);
  const stack: number[] = [];
  for (let index = 0; index < records.length; index += 1) {
    while (stack.length > 0 && records[stack.at(-1)!]!.level >= records[index]!.level) stack.pop();
    parents[index] = stack.at(-1) ?? -1;
    stack.push(index);
  }
  return parents;
}

function hasAncestorTable(index: number, records: HwpRecord[], parents: Int32Array): boolean {
  for (let parent = parents[index]!; parent >= 0; parent = parents[parent]!) {
    if (isControl(records[parent]!, "tbl ")) return true;
  }
  return false;
}

function findControlEnd(records: HwpRecord[], index: number, level: number): number {
  let end = index + 1;
  while (end < records.length && records[end]!.level > level) end += 1;
  return end;
}

function isControl(record: HwpRecord, id: string): boolean {
  if (record.tagId !== TAG_CTRL_HEADER || record.data.length < 4) return false;
  const raw = record.data.readUInt32LE(0);
  const expected = controlId(id);
  return raw === expected || swap32(raw) === expected;
}

function controlId(value: string): number {
  return (
    (value.charCodeAt(0) << 24)
    | (value.charCodeAt(1) << 16)
    | (value.charCodeAt(2) << 8)
    | value.charCodeAt(3)
  ) >>> 0;
}

function swap32(value: number): number {
  return (
    ((value & 255) << 24)
    | (((value >>> 8) & 255) << 16)
    | (((value >>> 16) & 255) << 8)
    | ((value >>> 24) & 255)
  ) >>> 0;
}

function decodeParagraphText(data: Buffer): string {
  let result = "";
  let offset = 0;
  while (offset + 1 < data.length) {
    const char = data.readUInt16LE(offset);
    offset += 2;
    if (char === 0 || char === 13) continue;
    if (char === 10) {
      if (offset + 16 <= data.length && data.readUInt16LE(offset) === 11) offset += 16;
      else result += "\n";
      continue;
    }
    if (char === 9) {
      result += "\t";
      if (offset + 14 <= data.length) offset += 14;
      continue;
    }
    if (char === 24) result += "-";
    else if (char === 30) result += "\u00a0";
    else if (char === 31) result += " ";
    else if (char >= 1 && char <= 31) {
      const extended = (char >= 1 && char <= 3) || (char >= 11 && char <= 12)
        || (char >= 14 && char <= 18) || (char >= 21 && char <= 23);
      const inline = (char >= 4 && char <= 9) || (char >= 19 && char <= 20);
      if ((extended || inline) && offset + 14 <= data.length) offset += 14;
    } else if (char >= 32) {
      result += String.fromCharCode(char);
    }
  }
  return result;
}

function decompressStream(data: Buffer): Buffer {
  const options = { maxOutputLength: MAX_DECOMPRESSED_SECTION_BYTES };
  if (data.length >= 2 && data[0] === 120) {
    try {
      return inflateSync(data, options);
    } catch {
      // 일반 HWP 5.x는 raw deflate다.
    }
  }
  return inflateRawSync(data, options);
}

function verifyUnmodifiedStreams(before: Uint8Array, after: Uint8Array, changedSections: Set<string>): void {
  const beforeStreams = logicalStreamMap(CFB.read(before, { type: "buffer" }));
  const afterStreams = logicalStreamMap(CFB.read(after, { type: "buffer" }));
  for (const [path, content] of beforeStreams) {
    if (changedSections.has(path)) continue;
    const output = afterStreams.get(path);
    if (!output || !output.equals(content)) {
      throw new Error(`HWP CheckBox 저장 중 비대상 스트림이 달라졌습니다: ${path}`);
    }
  }
  for (const path of afterStreams.keys()) {
    if (!beforeStreams.has(path)) throw new Error(`HWP CheckBox 저장 중 예기치 않은 스트림이 추가됐습니다: ${path}`);
  }
}

function logicalStreamMap(cfb: CFB.CFB$Container): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  cfb.FullPaths.forEach((fullPath, index) => {
    const entry = cfb.FileIndex[index];
    // cfb의 EntryType enum은 선언 파일에만 있고 런타임 export가 없다. stream 값은 CFB 명세상 2다.
    if (!entry || entry.type !== 2 || entry.size === 0) return;
    result.set(normalizeCfbPath(fullPath), Buffer.from(entry.content));
  });
  return result;
}

function normalizeCfbPath(path: string): string {
  return path.replace(/^Root Entry/, "").replace(/\/$/, "") || "/";
}

function sectionIndexFromPath(path: string): number {
  return Number(path.match(/\d+$/)?.[0] ?? 0);
}

function publicGroups(groups: InternalChoiceGroup[]): RoundtripChoiceGroup[] {
  return groups.map(({ refs: _refs, ...group }) => group);
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function cleanVisibleText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}
