import { deflateRawSync, inflateRawSync, inflateSync } from "node:zlib";
import * as CFB from "cfb";
import { replaceOleStream } from "./ole-stream";

const TAG_PARA_HEADER = 66;
const TAG_PARA_TEXT = 67;
const TAG_CHAR_SHAPE = 68;
const TAG_PARA_LINE_SEG = 69;
const TAG_PARA_RANGE_TAG = 70;

const FLAG_COMPRESSED = 1 << 0;
const MAX_RECORDS = 500_000;
const MAX_SECTIONS = 256;
const MAX_DECOMPRESSED_SECTION_BYTES = 100 * 1024 * 1024;
const LINE_SEG_BYTES = 36;
const CHAR_SHAPE_BYTES = 8;
const RANGE_TAG_BYTES = 12;

interface HwpRecord {
  tagId: number;
  level: number;
  data: Buffer;
}

interface HwpSection {
  sectionIndex: number;
  path: string;
  stream: Buffer;
}

export interface HwpIntegrityIssue {
  code:
    | "record_stream"
    | "paragraph_text_length"
    | "char_shape_size"
    | "char_shape_count"
    | "line_segment_size"
    | "line_segment_count"
    | "line_segment_position"
    | "range_tag_size"
    | "range_tag_count";
  sectionIndex: number;
  paragraphIndex: number | null;
  message: string;
}

export interface HwpRoundtripIntegrityResult {
  data: Uint8Array;
  repairedLineSegmentParagraphs: number;
  validatedParagraphs: number;
  baselineIssueCount: number;
  finalIssueCount: number;
}

export class HwpRoundtripIntegrityError extends Error {
  constructor(message: string, readonly issues: HwpIntegrityIssue[] = []) {
    super(message);
    this.name = "HwpRoundtripIntegrityError";
  }
}

/**
 * Kordoc patchHwp 뒤에 남을 수 있는 HWP5 줄 배치 캐시 불일치를 보정한다.
 *
 * 원본 다중행 레이아웃은 보존하되, 새 nChars 범위를 벗어나거나 순서가 깨진
 * LINE_SEG부터 뒤쪽 세그먼트만 제거한다. 보정 뒤에는 문단 레코드 정합성과
 * 비대상 OLE 스트림 보존 여부를 다시 검사한다.
 */
export function finalizeHwpRoundtrip(
  originalBytes: Uint8Array,
  candidateBytes: Uint8Array,
): HwpRoundtripIntegrityResult {
  const original = Buffer.from(originalBytes.buffer, originalBytes.byteOffset, originalBytes.byteLength);
  const candidate = Buffer.from(candidateBytes.buffer, candidateBytes.byteOffset, candidateBytes.byteLength);
  const baseline = inspectHwpIntegrity(original);
  const repaired = repairInvalidLineSegmentTails(candidate);
  verifyOnlyBodyTextStreamsChanged(original, repaired.data);
  const finalInspection = inspectHwpIntegrity(repaired.data);
  const baselineIssues = new Set(baseline.issues.map(issueFingerprint));
  const introducedIssues = finalInspection.issues.filter((issue) => !baselineIssues.has(issueFingerprint(issue)));
  if (introducedIssues.length > 0) {
    throw new HwpRoundtripIntegrityError(
      `HWP 저장본 문단 무결성 검사에서 새 구조 위반 ${introducedIssues.length}건을 발견했습니다: ${introducedIssues[0]!.message}`,
      introducedIssues,
    );
  }
  return {
    data: new Uint8Array(repaired.data),
    repairedLineSegmentParagraphs: repaired.repairedParagraphs,
    validatedParagraphs: finalInspection.paragraphCount,
    baselineIssueCount: baseline.issues.length,
    finalIssueCount: finalInspection.issues.length,
  };
}

export function inspectHwpIntegrity(bytes: Uint8Array): {
  paragraphCount: number;
  issues: HwpIntegrityIssue[];
} {
  let parsed: ReturnType<typeof readHwpSections>;
  try {
    parsed = readHwpSections(bytes);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      paragraphCount: 0,
      issues: [{ code: "record_stream", sectionIndex: -1, paragraphIndex: null, message }],
    };
  }
  const issues: HwpIntegrityIssue[] = [];
  let paragraphCount = 0;
  for (const section of parsed.sections) {
    let records: HwpRecord[];
    try {
      records = readRecordsStrict(section.stream);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      issues.push({
        code: "record_stream",
        sectionIndex: section.sectionIndex,
        paragraphIndex: null,
        message,
      });
      continue;
    }
    let sectionParagraphIndex = 0;
    for (let index = 0; index < records.length; index += 1) {
      const header = records[index]!;
      if (header.tagId !== TAG_PARA_HEADER || header.data.length < 18) continue;
      const paragraphIndex = sectionParagraphIndex;
      sectionParagraphIndex += 1;
      paragraphCount += 1;
      const children = directChildren(records, index);
      const nChars = header.data.readUInt32LE(0) & 0x7fffffff;
      validateParagraphText(children, nChars, section.sectionIndex, paragraphIndex, issues);
      validateFixedWidthRecords({
        children,
        tagId: TAG_CHAR_SHAPE,
        recordBytes: CHAR_SHAPE_BYTES,
        declaredCount: header.data.readUInt16LE(12),
        sizeCode: "char_shape_size",
        countCode: "char_shape_count",
        sectionIndex: section.sectionIndex,
        paragraphIndex,
        label: "CHAR_SHAPE",
        issues,
      });
      validateLineSegments(children, nChars, header.data.readUInt16LE(16), section.sectionIndex, paragraphIndex, issues);
      validateFixedWidthRecords({
        children,
        tagId: TAG_PARA_RANGE_TAG,
        recordBytes: RANGE_TAG_BYTES,
        declaredCount: header.data.readUInt16LE(14),
        sizeCode: "range_tag_size",
        countCode: "range_tag_count",
        sectionIndex: section.sectionIndex,
        paragraphIndex,
        label: "RANGE_TAG",
        issues,
      });
    }
  }
  return { paragraphCount, issues };
}

function repairInvalidLineSegmentTails(bytes: Buffer): { data: Buffer; repairedParagraphs: number } {
  const parsed = readHwpSections(bytes);
  let output: Buffer<ArrayBufferLike> = Buffer.from(bytes);
  let repairedParagraphs = 0;
  for (const section of parsed.sections) {
    const records = readRecordsStrict(section.stream);
    if (!serializeRecords(records).equals(section.stream)) {
      throw new HwpRoundtripIntegrityError(`HWP Section${section.sectionIndex} 레코드 재직렬화가 원본과 다릅니다.`);
    }
    const replacements = new Map<number, Buffer>();
    for (let index = 0; index < records.length; index += 1) {
      const header = records[index]!;
      if (header.tagId !== TAG_PARA_HEADER || header.data.length < 18) continue;
      const lineSegmentIndexes = directChildIndexes(records, index).filter(
        (childIndex) => records[childIndex]!.tagId === TAG_PARA_LINE_SEG,
      );
      if (lineSegmentIndexes.length !== 1) continue;
      const lineIndex = lineSegmentIndexes[0]!;
      const lineData = records[lineIndex]!.data;
      if (lineData.length < LINE_SEG_BYTES || lineData.length % LINE_SEG_BYTES !== 0) continue;
      const nChars = header.data.readUInt32LE(0) & 0x7fffffff;
      const segmentCount = lineData.length / LINE_SEG_BYTES;
      if (header.data.readUInt16LE(16) !== segmentCount) continue;
      const validPrefixCount = countValidLineSegmentPrefix(lineData, nChars);
      if (validPrefixCount === 0 || validPrefixCount === segmentCount) continue;
      const newHeader = Buffer.from(header.data);
      newHeader.writeUInt16LE(validPrefixCount, 16);
      replacements.set(index, newHeader);
      replacements.set(lineIndex, Buffer.from(lineData.subarray(0, validPrefixCount * LINE_SEG_BYTES)));
      repairedParagraphs += 1;
    }
    if (replacements.size === 0) continue;
    const nextStream = serializeRecords(records, replacements);
    const content = parsed.compressed ? deflateRawSync(nextStream) : nextStream;
    output = replaceOleStream(output, section.path, content);
  }
  return { data: output, repairedParagraphs };
}

function countValidLineSegmentPrefix(data: Buffer, nChars: number): number {
  let previous = -1;
  let validCount = 0;
  for (let offset = 0; offset < data.length; offset += LINE_SEG_BYTES) {
    const position = data.readUInt32LE(offset);
    const firstPositionValid = offset > 0 || position === 0;
    const withinParagraph = nChars === 0 ? position === 0 : position < nChars;
    const increasing = offset === 0 || position > previous;
    if (!firstPositionValid || !withinParagraph || !increasing) break;
    validCount += 1;
    previous = position;
  }
  return validCount;
}

function validateParagraphText(
  children: HwpRecord[],
  nChars: number,
  sectionIndex: number,
  paragraphIndex: number,
  issues: HwpIntegrityIssue[],
): void {
  const textRecords = children.filter((record) => record.tagId === TAG_PARA_TEXT);
  if (textRecords.some((record) => record.data.length % 2 !== 0)) {
    issues.push({
      code: "paragraph_text_length",
      sectionIndex,
      paragraphIndex,
      message: `Section${sectionIndex} 문단 ${paragraphIndex + 1}의 PARA_TEXT 바이트 길이가 홀수입니다.`,
    });
    return;
  }
  const textUnits = textRecords.reduce((sum, record) => sum + record.data.length / 2, 0);
  const emptyParagraph = textRecords.length === 0 && (nChars === 0 || nChars === 1);
  if (!emptyParagraph && textUnits !== nChars) {
    issues.push({
      code: "paragraph_text_length",
      sectionIndex,
      paragraphIndex,
      message: `Section${sectionIndex} 문단 ${paragraphIndex + 1}의 nChars=${nChars}, PARA_TEXT=${textUnits}가 다릅니다.`,
    });
  }
}

function validateFixedWidthRecords(input: {
  children: HwpRecord[];
  tagId: number;
  recordBytes: number;
  declaredCount: number;
  sizeCode: "char_shape_size" | "range_tag_size";
  countCode: "char_shape_count" | "range_tag_count";
  sectionIndex: number;
  paragraphIndex: number;
  label: string;
  issues: HwpIntegrityIssue[];
}): void {
  const records = input.children.filter((record) => record.tagId === input.tagId);
  const malformed = records.some((record) => record.data.length % input.recordBytes !== 0);
  if (malformed) {
    input.issues.push({
      code: input.sizeCode,
      sectionIndex: input.sectionIndex,
      paragraphIndex: input.paragraphIndex,
      message: `Section${input.sectionIndex} 문단 ${input.paragraphIndex + 1}의 ${input.label} 크기가 ${input.recordBytes}바이트 배수가 아닙니다.`,
    });
    return;
  }
  const actualCount = records.reduce((sum, record) => sum + record.data.length / input.recordBytes, 0);
  if (actualCount !== input.declaredCount) {
    input.issues.push({
      code: input.countCode,
      sectionIndex: input.sectionIndex,
      paragraphIndex: input.paragraphIndex,
      message: `Section${input.sectionIndex} 문단 ${input.paragraphIndex + 1}의 ${input.label} 선언=${input.declaredCount}, 실제=${actualCount}가 다릅니다.`,
    });
  }
}

function validateLineSegments(
  children: HwpRecord[],
  nChars: number,
  declaredCount: number,
  sectionIndex: number,
  paragraphIndex: number,
  issues: HwpIntegrityIssue[],
): void {
  const records = children.filter((record) => record.tagId === TAG_PARA_LINE_SEG);
  if (records.some((record) => record.data.length % LINE_SEG_BYTES !== 0)) {
    issues.push({
      code: "line_segment_size",
      sectionIndex,
      paragraphIndex,
      message: `Section${sectionIndex} 문단 ${paragraphIndex + 1}의 LINE_SEG 크기가 ${LINE_SEG_BYTES}바이트 배수가 아닙니다.`,
    });
    return;
  }
  const actualCount = records.reduce((sum, record) => sum + record.data.length / LINE_SEG_BYTES, 0);
  if (actualCount !== declaredCount) {
    issues.push({
      code: "line_segment_count",
      sectionIndex,
      paragraphIndex,
      message: `Section${sectionIndex} 문단 ${paragraphIndex + 1}의 LINE_SEG 선언=${declaredCount}, 실제=${actualCount}가 다릅니다.`,
    });
  }
  let previous = -1;
  let segmentOrdinal = 0;
  for (const record of records) {
    for (let offset = 0; offset < record.data.length; offset += LINE_SEG_BYTES) {
      const position = record.data.readUInt32LE(offset);
      const firstPositionValid = segmentOrdinal > 0 || position === 0;
      const withinParagraph = nChars === 0 ? position === 0 : position < nChars;
      const increasing = segmentOrdinal === 0 || position > previous;
      if (!firstPositionValid || !withinParagraph || !increasing) {
        issues.push({
          code: "line_segment_position",
          sectionIndex,
          paragraphIndex,
          message: `Section${sectionIndex} 문단 ${paragraphIndex + 1}의 LINE_SEG 위치 ${position}가 nChars=${nChars} 범위 또는 순서를 벗어났습니다.`,
        });
        return;
      }
      previous = position;
      segmentOrdinal += 1;
    }
  }
}

function readHwpSections(bytes: Uint8Array): { compressed: boolean; sections: HwpSection[] } {
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let cfb: CFB.CFB$Container;
  try {
    cfb = CFB.read(input, { type: "buffer" });
  } catch (error) {
    throw new HwpRoundtripIntegrityError(`HWP OLE 컨테이너를 읽지 못했습니다: ${errorMessage(error)}`);
  }
  const header = CFB.find(cfb, "/FileHeader");
  if (!header?.content || header.content.length < 40) {
    throw new HwpRoundtripIntegrityError("HWP FileHeader 스트림이 없거나 너무 짧습니다.");
  }
  const compressed = (Buffer.from(header.content).readUInt32LE(36) & FLAG_COMPRESSED) !== 0;
  const sections = cfb.FullPaths
    .map((fullPath, index) => ({ path: normalizeCfbPath(fullPath), entry: cfb.FileIndex[index] }))
    .filter((item): item is { path: string; entry: CFB.CFB$Entry } =>
      Boolean(item.entry) && /^\/BodyText\/Section\d+$/.test(item.path))
    .sort((left, right) => sectionIndexFromPath(left.path) - sectionIndexFromPath(right.path))
    .slice(0, MAX_SECTIONS)
    .map(({ path, entry }) => ({
      path,
      sectionIndex: sectionIndexFromPath(path),
      stream: compressed ? decompressStream(Buffer.from(entry.content)) : Buffer.from(entry.content),
    }));
  if (sections.length === 0) throw new HwpRoundtripIntegrityError("HWP BodyText 섹션을 찾지 못했습니다.");
  return { compressed, sections };
}

function readRecordsStrict(stream: Buffer): HwpRecord[] {
  const records: HwpRecord[] = [];
  let offset = 0;
  while (offset < stream.length) {
    if (offset + 4 > stream.length || records.length >= MAX_RECORDS) {
      throw new HwpRoundtripIntegrityError("HWP 레코드 헤더 또는 레코드 수 상한을 벗어났습니다.");
    }
    const header = stream.readUInt32LE(offset);
    offset += 4;
    const tagId = header & 1023;
    const level = (header >>> 10) & 1023;
    let size = (header >>> 20) & 4095;
    if (size === 4095) {
      if (offset + 4 > stream.length) throw new HwpRoundtripIntegrityError("HWP 확장 레코드 헤더가 잘렸습니다.");
      size = stream.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + size > stream.length) throw new HwpRoundtripIntegrityError("HWP 레코드 데이터가 잘렸습니다.");
    records.push({ tagId, level, data: stream.subarray(offset, offset + size) });
    offset += size;
  }
  return records;
}

function serializeRecords(records: HwpRecord[], replacements = new Map<number, Buffer>()): Buffer {
  const parts: Buffer[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const data = replacements.get(index) ?? record.data;
    const extended = data.length >= 4095;
    const header = Buffer.alloc(extended ? 8 : 4);
    header.writeUInt32LE((
      (record.tagId & 1023)
      | ((record.level & 1023) << 10)
      | ((extended ? 4095 : data.length) << 20)
    ) >>> 0, 0);
    if (extended) header.writeUInt32LE(data.length, 4);
    parts.push(header, data);
  }
  return Buffer.concat(parts);
}

function directChildren(records: HwpRecord[], headerIndex: number): HwpRecord[] {
  return directChildIndexes(records, headerIndex).map((index) => records[index]!);
}

function directChildIndexes(records: HwpRecord[], headerIndex: number): number[] {
  const indexes: number[] = [];
  const level = records[headerIndex]!.level;
  for (let index = headerIndex + 1; index < records.length && records[index]!.level > level; index += 1) {
    if (records[index]!.level === level + 1) indexes.push(index);
  }
  return indexes;
}

function verifyOnlyBodyTextStreamsChanged(original: Buffer, output: Buffer): void {
  const originalStreams = logicalStreamMap(CFB.read(original, { type: "buffer" }));
  const outputStreams = logicalStreamMap(CFB.read(output, { type: "buffer" }));
  for (const [path, content] of originalStreams) {
    const next = outputStreams.get(path);
    if (!next) throw new HwpRoundtripIntegrityError(`HWP 저장 중 OLE 스트림이 사라졌습니다: ${path}`);
    if (!/^\/BodyText\/Section\d+$/.test(path) && !next.equals(content)) {
      throw new HwpRoundtripIntegrityError(`HWP 저장 중 비대상 OLE 스트림이 달라졌습니다: ${path}`);
    }
  }
  for (const path of outputStreams.keys()) {
    if (!originalStreams.has(path)) throw new HwpRoundtripIntegrityError(`HWP 저장 중 예기치 않은 OLE 스트림이 추가됐습니다: ${path}`);
  }
}

function logicalStreamMap(cfb: CFB.CFB$Container): Map<string, Buffer> {
  const result = new Map<string, Buffer>();
  cfb.FullPaths.forEach((fullPath, index) => {
    const entry = cfb.FileIndex[index];
    if (!entry || entry.type !== 2) return;
    result.set(normalizeCfbPath(fullPath), Buffer.from(entry.content));
  });
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

function issueFingerprint(issue: HwpIntegrityIssue): string {
  return `${issue.code}:${issue.sectionIndex}:${issue.paragraphIndex ?? "section"}:${issue.message}`;
}

function normalizeCfbPath(path: string): string {
  return path.replace(/^Root Entry/, "").replace(/\/$/, "") || "/";
}

function sectionIndexFromPath(path: string): number {
  return Number(path.match(/\d+$/)?.[0] ?? 0);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
