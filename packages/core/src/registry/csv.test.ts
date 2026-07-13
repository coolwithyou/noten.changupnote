/**
 * registry CSV 파서 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/registry/csv.test.ts
 */
import assert from "node:assert/strict";
import { parseCsv } from "./csv.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

check("기본 파싱 → 헤더+데이터 행렬", () => {
  const rows = parseCsv("a,b,c\n1,2,3");
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", "2", "3"],
  ]);
});

check("따옴표로 감싼 필드 내 콤마 보존", () => {
  const rows = parseCsv('name,city\n"가나다, 주식회사",서울');
  assert.deepEqual(rows, [
    ["name", "city"],
    ["가나다, 주식회사", "서울"],
  ]);
});

check('이스케이프된 "" → 리터럴 따옴표', () => {
  const rows = parseCsv('q\n"She said ""hi"""');
  assert.deepEqual(rows, [["q"], ['She said "hi"']]);
});

check("따옴표 필드 내 개행은 같은 필드로 유지", () => {
  const rows = parseCsv('a,b\n"line1\nline2",x');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["line1\nline2", "x"],
  ]);
});

check("CRLF/LF 혼용 정상 처리", () => {
  const rows = parseCsv("a,b\r\n1,2\r\n3,4\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
    ["3", "4"],
  ]);
});

check("후행 빈 줄 무시", () => {
  const rows = parseCsv("a,b\n1,2\n\n\n");
  assert.deepEqual(rows, [
    ["a", "b"],
    ["1", "2"],
  ]);
});

check("따옴표로 감싼 빈 필드는 데이터로 유지", () => {
  const rows = parseCsv('a,b\n"",2');
  assert.deepEqual(rows, [
    ["a", "b"],
    ["", "2"],
  ]);
});

check("완전 빈 입력 → 빈 행렬", () => {
  assert.deepEqual(parseCsv(""), []);
});

check("탭 구분 TSV와 필드 내부 콤마", () => {
  assert.deepEqual(parseCsv('a\tb\n"가나다, 주식회사"\t서울', { delimiter: "\t" }), [
    ["a", "b"],
    ["가나다, 주식회사", "서울"],
  ]);
});

console.log(`\nregistry csv: ${passed} cases passed.`);
