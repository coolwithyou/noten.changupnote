import assert from "node:assert/strict";
import type { RhwpModule } from "./client";
import { assertTableLayoutDoesNotOverflow } from "./tableLayoutGuard";

const target = { section: 0, parentPara: 1, controlIndex: 0 };
type Box = { cellIdx: number; pageIndex: number; x: number; y: number; w: number; h: number };
const cell: Box = { cellIdx: 0, pageIndex: 0, x: 10, y: 10, w: 60, h: 50 };
function check(before: Box[], after: Box[]) {
  let freed = 0;
  class Document {
    constructor(private bytes: Uint8Array) {}
    pageCount() { return 2; }
    getTableDimensions() { return '{"cellCount":1}'; }
    getTableCellBboxes() { return JSON.stringify(this.bytes[0] ? after : before); }
    getPageInfo() { return '{"width":100,"height":100}'; }
    free() { freed++; }
  }
  try { assertTableLayoutDoesNotOverflow({ rhwp: { HwpDocument: Document } as unknown as RhwpModule, before: Uint8Array.of(0), after: Uint8Array.of(1), target }); }
  finally { assert.equal(freed, 2); }
}
check([cell], [cell]);
check([cell], [{ ...cell, h: 80 }, { ...cell, pageIndex: 1, h: 20 }]);
check([{ ...cell, h: 110 }], [{ ...cell, h: 105 }]); // 기존 넘침이 줄어든 경우
assert.throws(() => check([cell], [{ ...cell, h: 100 }]), /용지 밖/u);
assert.throws(() => check([cell], [{ ...cell, x: 90 }]), /용지 밖/u);
assert.throws(() => check([cell], []), /일부 셀/u);
assert.throws(() => check([cell], [{ ...cell, pageIndex: 2 }]), /표시 위치/u);
console.log("PASS: table layout guard accepts bounded/split/improved cells and rejects new overflow, missing cells and invalid page references");
