import assert from "node:assert/strict";
import * as CFB from "cfb";
import {
  finalizeHwpRoundtrip,
  HwpRoundtripIntegrityError,
  inspectHwpIntegrity,
} from "./hwp-integrity";

const originalText = "※1건 이상 보유시 ○ 표시";
const original = buildSyntheticHwp({ text: originalText, nChars: originalText.length + 1, linePositions: [0, 7] });
const staleCandidate = buildSyntheticHwp({ text: "○", nChars: 2, linePositions: [0, 7] });

const beforeRepair = inspectHwpIntegrity(staleCandidate);
assert.equal(beforeRepair.issues.length, 1);
assert.equal(beforeRepair.issues[0]?.code, "line_segment_position");

const repaired = finalizeHwpRoundtrip(original, staleCandidate);
assert.equal(repaired.repairedLineSegmentParagraphs, 1);
assert.equal(repaired.validatedParagraphs, 1);
assert.equal(repaired.finalIssueCount, 0);
assert.deepEqual(readLineSegmentState(repaired.data), { declaredCount: 1, positions: [0] });

const validMultiline = finalizeHwpRoundtrip(original, original);
assert.equal(validMultiline.repairedLineSegmentParagraphs, 0, "유효한 원본 다중행 LINE_SEG는 보존해야 한다");
assert.deepEqual(readLineSegmentState(validMultiline.data), { declaredCount: 2, positions: [0, 7] });

const wrongTextLength = buildSyntheticHwp({ text: "○", nChars: 3, linePositions: [0] });
assert.throws(
  () => finalizeHwpRoundtrip(original, wrongTextLength),
  (error: unknown) => error instanceof HwpRoundtripIntegrityError
    && error.issues.some((issue) => issue.code === "paragraph_text_length"),
);

console.log("application-roundtrip HWP integrity tests: ok");

function buildSyntheticHwp(input: { text: string; nChars: number; linePositions: number[] }): Uint8Array {
  const fileHeader = Buffer.alloc(40);
  Buffer.from("HWP Document File", "utf8").copy(fileHeader);
  const paraHeader = Buffer.alloc(24);
  paraHeader.writeUInt32LE(input.nChars, 0);
  paraHeader.writeUInt16LE(1, 12);
  paraHeader.writeUInt16LE(input.linePositions.length, 16);
  const charShape = Buffer.alloc(8);
  const lineSegments = Buffer.alloc(input.linePositions.length * 36);
  input.linePositions.forEach((position, index) => lineSegments.writeUInt32LE(position, index * 36));
  const section = Buffer.concat([
    record(66, 0, paraHeader),
    record(67, 1, Buffer.concat([Buffer.from(input.text, "utf16le"), Buffer.from([13, 0])])),
    record(68, 1, charShape),
    record(69, 1, lineSegments),
  ]);
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, "FileHeader", fileHeader);
  CFB.utils.cfb_add(cfb, "BodyText/Section0", section);
  return new Uint8Array(CFB.write(cfb, { type: "buffer", fileType: "cfb" }) as Uint8Array);
}

function readLineSegmentState(bytes: Uint8Array): { declaredCount: number; positions: number[] } {
  const cfb = CFB.read(bytes, { type: "buffer" });
  const section = CFB.find(cfb, "/BodyText/Section0");
  assert.ok(section?.content);
  const records = readRecords(Buffer.from(section.content));
  const header = records.find((item) => item.tagId === 66);
  const lineSegments = records.find((item) => item.tagId === 69);
  assert.ok(header && lineSegments);
  const positions: number[] = [];
  for (let offset = 0; offset < lineSegments.data.length; offset += 36) {
    positions.push(lineSegments.data.readUInt32LE(offset));
  }
  return { declaredCount: header.data.readUInt16LE(16), positions };
}

function readRecords(stream: Buffer): Array<{ tagId: number; data: Buffer }> {
  const records: Array<{ tagId: number; data: Buffer }> = [];
  let offset = 0;
  while (offset < stream.length) {
    const header = stream.readUInt32LE(offset);
    offset += 4;
    let size = (header >>> 20) & 4095;
    if (size === 4095) {
      size = stream.readUInt32LE(offset);
      offset += 4;
    }
    records.push({ tagId: header & 1023, data: stream.subarray(offset, offset + size) });
    offset += size;
  }
  return records;
}

function record(tagId: number, level: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE((tagId | (level << 10) | (data.length << 20)) >>> 0);
  return Buffer.concat([header, data]);
}
