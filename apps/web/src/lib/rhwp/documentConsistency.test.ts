import assert from "node:assert/strict";
import { inspectDocumentConsistency } from "./documentConsistency";
import type { RhwpDocument } from "./client";

const body = ["사업명: 문서에 남은 이전 이름", "2026년목표매출: 1억원", "총사업비: 1억원", "정부지원금: 6천만원", "자부담: 3천만원"];
let merged = false; let unreadable = false;
const cells = ["2026년목표매출", "9000만원", "2025년실적매출", "2억원", "사업기간", "2026-12-31 ~ 2026-01-01"];
const document = {
  getSectionCount: () => 1, getParagraphCount: () => body.length, getParagraphLength: (_s: number, p: number) => body[p]!.length,
  getTextRange: (_s: number, p: number) => body[p], pageCount: () => 2,
  getPageControlLayout: () => JSON.stringify({ controls: [{ type: "table", stableIndex: [0, 5, 0], secIdx: 0, paraIdx: 5, controlIdx: 0 }] }),
  getTableDimensions: () => { if (unreadable) throw new Error("unsupported"); return JSON.stringify({ cellCount: cells.length }); },
  getCellInfo: (_s: number, _p: number, _c: number, index: number) => JSON.stringify({ row: Math.floor(index / 2), col: index % 2, rowSpan: merged ? 2 : 1, colSpan: 1 }),
  getCellParagraphCount: () => 1,
  getCellParagraphLength: (_s: number, _p: number, _c: number, index: number) => cells[index]!.length,
  getTextInCell: (_s: number, _p: number, _c: number, index: number) => cells[index],
} as unknown as RhwpDocument;
const brief = { projectName: "이번 사업", budget: "" };
const first = inspectDocumentConsistency(document, "a".repeat(64), brief);
assert.deepEqual(first.report.issues.map(issue => issue.kind).sort(), ["budget_total", "conflicting_value", "date_order", "project_name"]);
assert.equal(first.report.issues.find(issue => issue.kind === "conflicting_value")!.entries.length, 2, "같은 표가 두 페이지에 걸쳐도 중복 계산하지 않는다");
assert.match(first.report.issues.find(issue => issue.kind === "date_order")!.entries[0]!.label, /1쪽 표/);
assert.equal(first.skippedTables, 0);
merged = true;
const conservative = inspectDocumentConsistency(document, "b".repeat(64), brief);
assert.deepEqual(conservative.report.issues.map(issue => issue.kind).sort(), ["budget_total", "project_name"], "병합 셀의 항목/값을 임의 연결하지 않는다");
unreadable = true;
assert.equal(inspectDocumentConsistency(document, "c".repeat(64), brief).skippedTables, 1);
assert.equal(body[0], "사업명: 문서에 남은 이전 이름", "점검은 문안을 바꾸지 않는다");
console.log("Document consistency: body and table evidence, budget, period, distinct years, merged-cell abstention PASS");
