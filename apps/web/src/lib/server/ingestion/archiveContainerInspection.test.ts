import assert from "node:assert/strict";
import { writeHwpx } from "@cunote/core/documents/hwpx-fill";
import {
  extractOfficeContainerMarkdown,
  extractSupportedArchiveEntries,
  inspectArchiveContainer,
  isArchiveContainerFilename,
} from "./archiveContainerInspection";

assert.equal(isArchiveContainerFilename("첨부파일.zip"), true);
assert.equal(isArchiveContainerFilename("목록.xlsx"), true);
assert.equal(isArchiveContainerFilename("포스터.png"), false);

const safe = await inspectArchiveContainer("첨부파일.zip", writeHwpx([
  { name: "notice.pdf", data: Buffer.from("pdf"), method: 0 },
  { name: "notes/readme.txt", data: Buffer.from("지원대상"), method: 0 },
]));
assert.equal(safe.entryCount, 2);
assert.deepEqual(safe.supportedDocumentEntries, ["notice.pdf", "notes/readme.txt"]);
assert.equal(safe.actionable, true);
assert.deepEqual(extractSupportedArchiveEntries("첨부파일.zip", writeHwpx([
  { name: "notice.pdf", data: Buffer.from("pdf"), method: 0 },
  { name: "notes/readme.txt", data: Buffer.from("지원대상"), method: 0 },
])).map((entry) => entry.filename), ["notes/readme.txt", "notice.pdf"]);

const traversal = await inspectArchiveContainer("첨부파일.zip", writeHwpx([
  { name: "../outside.txt", data: Buffer.from("unsafe"), method: 0 },
]));
assert.deepEqual(traversal.suspiciousEntries, ["../outside.txt"]);
assert.equal(traversal.actionable, false);
assert.throws(() => extractSupportedArchiveEntries("첨부파일.zip", writeHwpx([
  { name: "../outside.txt", data: Buffer.from("unsafe"), method: 0 },
])), /suspicious path/);
assert.throws(() => extractSupportedArchiveEntries("첨부파일.zip", writeHwpx([
  { name: "large.txt", data: Buffer.alloc(2_048, 1), method: 0 },
]), { maxEntryBytes: 1_024 }), /exceeds 1024 bytes/);

const workbook = await inspectArchiveContainer("목록.xlsx", writeHwpx([
  { name: "xl/sharedStrings.xml", data: Buffer.from("<sst/>"), method: 0 },
  { name: "xl/worksheets/sheet1.xml", data: Buffer.from("<worksheet/>"), method: 0 },
]));
assert.equal(workbook.format, "xlsx");
assert.deepEqual(workbook.textPayloadEntries, ["xl/sharedStrings.xml", "xl/worksheets/sheet1.xml"]);
assert.equal(workbook.actionable, true);
const workbookMarkdown = extractOfficeContainerMarkdown("목록.xlsx", writeHwpx([
  { name: "xl/sharedStrings.xml", data: Buffer.from('<sst><si><t>지원대상</t></si><si><t>중소기업</t></si></sst>'), method: 0 },
  { name: "xl/worksheets/sheet1.xml", data: Buffer.from('<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row></sheetData></worksheet>'), method: 0 },
]));
assert.match(workbookMarkdown ?? "", /지원대상 \| 중소기업/);

console.log("archive-container-inspection: ok");
