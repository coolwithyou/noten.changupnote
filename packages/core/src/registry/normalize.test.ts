/**
 * registry 정규화 유틸 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/registry/normalize.test.ts
 */
import assert from "node:assert/strict";
import {
  normalizeCompanyName,
  parseKoreanDate,
  sanitizeBizNo,
  sanitizeCorpNo,
} from "./normalize.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

check("sanitizeBizNo: 하이픈 제거 후 10자리", () => {
  assert.equal(sanitizeBizNo("123-45-67890"), "1234567890");
  assert.equal(sanitizeBizNo("1234567890"), "1234567890");
});

check("sanitizeBizNo: 자릿수 오류·빈값 → null", () => {
  assert.equal(sanitizeBizNo("12345"), null);
  assert.equal(sanitizeBizNo("12345678901"), null);
  assert.equal(sanitizeBizNo(""), null);
  assert.equal(sanitizeBizNo(null), null);
  assert.equal(sanitizeBizNo(undefined), null);
});

check("sanitizeCorpNo: 13자리 검증", () => {
  assert.equal(sanitizeCorpNo("110111-1234567"), "1101111234567");
  assert.equal(sanitizeCorpNo("1101111234567"), "1101111234567");
  assert.equal(sanitizeCorpNo("123"), null);
  assert.equal(sanitizeCorpNo(null), null);
});

check("normalizeCompanyName: 법인격 표기 3형이 동일 정규형으로 수렴", () => {
  const a = normalizeCompanyName("㈜가나다");
  const b = normalizeCompanyName("가나다 주식회사");
  const c = normalizeCompanyName("(주)가나다");
  assert.equal(a, "가나다");
  assert.equal(a, b);
  assert.equal(b, c);
});

check("normalizeCompanyName: 특수문자·공백·영문 소문자 정리", () => {
  assert.equal(normalizeCompanyName("  A-B·C, Corp  "), "abccorp");
  assert.equal(normalizeCompanyName("유한회사 라마바"), "라마바");
  assert.equal(normalizeCompanyName(null), "");
  assert.equal(normalizeCompanyName(""), "");
});

check("parseKoreanDate: 3형식이 같은 UTC 타임스탬프", () => {
  const expected = Date.UTC(2026, 0, 15);
  assert.equal(parseKoreanDate("20260115")!.getTime(), expected);
  assert.equal(parseKoreanDate("2026-01-15")!.getTime(), expected);
  assert.equal(parseKoreanDate("2026.01.15")!.getTime(), expected);
});

check("parseKoreanDate: 빈값·무효 → null", () => {
  assert.equal(parseKoreanDate(""), null);
  assert.equal(parseKoreanDate(null), null);
  assert.equal(parseKoreanDate(undefined), null);
  assert.equal(parseKoreanDate("2026"), null);
  assert.equal(parseKoreanDate("20260230"), null); // 존재하지 않는 날짜
});

console.log(`\nregistry normalize: ${passed} cases passed.`);
