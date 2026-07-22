import assert from "node:assert/strict";
import * as CFB from "cfb";
import {
  extractHwpFormChoiceGroups,
  patchHwpFormChoices,
} from "./hwp-form-controls";

const sourceSha256 = "a".repeat(64);
const original = buildSyntheticHwp();
const groups = extractHwpFormChoiceGroups(original, sourceSha256);

assert.equal(groups.length, 1);
assert.equal(groups[0]?.label, "기업형태");
assert.equal(groups[0]?.selectionMode, "single");
assert.deepEqual(groups[0]?.options.map((option) => option.label), ["개인", "법인"]);
assert.deepEqual(groups[0]?.options.map((option) => option.selected), [false, false]);

const group = groups[0]!;
const patched = patchHwpFormChoices(original, sourceSha256, {
  [group.groupId]: [group.options[1]!.optionId],
});
assert.equal(patched.formControlPatchedCount, 1);
assert.deepEqual(
  patched.groups[0]?.options.filter((option) => option.selected).map((option) => option.label),
  ["법인"],
);

const secondPass = patchHwpFormChoices(patched.data, sourceSha256, {
  [group.groupId]: [group.options[0]!.optionId],
});
assert.equal(secondPass.formControlPatchedCount, 2, "기존 선택 해제와 새 선택 적용을 함께 계산해야 한다");
assert.deepEqual(
  secondPass.groups[0]?.options.filter((option) => option.selected).map((option) => option.label),
  ["개인"],
);

console.log("application-roundtrip HWP form-control tests: ok");

function buildSyntheticHwp(): Uint8Array {
  const header = Buffer.alloc(40);
  Buffer.from("HWP Document File", "utf8").copy(header);
  const tableData = Buffer.alloc(8);
  tableData.writeUInt16LE(1, 4);
  tableData.writeUInt16LE(2, 6);
  const records = Buffer.concat([
    record(71, 0, Buffer.from("tbl ", "latin1")),
    record(77, 1, tableData),
    record(72, 1, cellHeader(0, 0)),
    record(67, 2, Buffer.from("기업형태", "utf16le")),
    record(72, 1, cellHeader(0, 1)),
    record(91, 2, formObject("CheckBox1", "개인", 0)),
    record(91, 2, formObject("CheckBox2", "법인", 0)),
  ]);
  const cfb = CFB.utils.cfb_new();
  CFB.utils.cfb_add(cfb, "FileHeader", header);
  CFB.utils.cfb_add(cfb, "BodyText/Section0", records);
  return new Uint8Array(CFB.write(cfb, { type: "buffer", fileType: "cfb" }) as Uint8Array);
}

function record(tagId: number, level: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUInt32LE((tagId | (level << 10) | (data.length << 20)) >>> 0);
  return Buffer.concat([header, data]);
}

function cellHeader(row: number, col: number): Buffer {
  const data = Buffer.alloc(16);
  data.writeUInt16LE(col, 8);
  data.writeUInt16LE(row, 10);
  data.writeUInt16LE(1, 12);
  data.writeUInt16LE(1, 14);
  return data;
}

function formObject(name: string, caption: string, value: 0 | 1): Buffer {
  return Buffer.from(
    `Name:wstring:${name.length}:${name} Caption:wstring:${caption.length}:${caption} Value:int:${value} TriState:bool:0 `,
    "utf16le",
  );
}
