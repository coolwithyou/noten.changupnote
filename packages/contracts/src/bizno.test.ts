/**
 * isValidBizNoChecksum 단위 테스트 (node:assert, tsx 실행).
 *
 * 실행: pnpm exec tsx packages/contracts/src/bizno.test.ts
 *
 * 커버: 국세청 검증숫자 알고리즘으로 계산한 유효 번호 통과 / 검증숫자 불일치 거부 /
 *       하이픈·공백 등 비숫자 문자 정규화 / 길이 오류(10자리 아님) 거부.
 */
import assert from "node:assert/strict";
import { isValidBizNoChecksum } from "./bizno.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 알고리즘으로 계산한 유효 번호(앞 9자리 + 검증숫자).
//   123456789 → 검증숫자 1 (합 165 + floor(9*5/10)=4 = 169, (10-9)%10=1)
//   567890123 → 검증숫자 0 (합 129 + floor(3*5/10)=1 = 130, (10-0)%10=0)
check("검증숫자가 맞는 번호는 유효", () => {
  assert.equal(isValidBizNoChecksum("1234567891"), true);
  assert.equal(isValidBizNoChecksum("5678901230"), true);
});

check("검증숫자가 틀린 번호는 거부", () => {
  assert.equal(isValidBizNoChecksum("1234567890"), false);
  assert.equal(isValidBizNoChecksum("5678901234"), false);
});

check("하이픈·공백은 정규화 후 검증", () => {
  assert.equal(isValidBizNoChecksum("123-45-67891"), true);
  assert.equal(isValidBizNoChecksum(" 123 45 67891 "), true);
  assert.equal(isValidBizNoChecksum("123-45-67890"), false);
});

check("10자리가 아니면 거부", () => {
  assert.equal(isValidBizNoChecksum(""), false);
  assert.equal(isValidBizNoChecksum("12345678"), false);
  assert.equal(isValidBizNoChecksum("123456789"), false);
  assert.equal(isValidBizNoChecksum("12345678911"), false);
  assert.equal(isValidBizNoChecksum("abcdefghij"), false);
});

console.log(`\nisValidBizNoChecksum: ${passed} groups passed.`);
