/**
 * registry 퍼지 매칭 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/registry/fuzzy-match.test.ts
 */
import assert from "node:assert/strict";
import { fuzzyNameScore, nameSimilarity } from "./fuzzy-match.js";
import type { RegistryRecord } from "./types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

/** 테스트용 record 팩토리(nameNormalized·representative·regionSido만 관심). */
function makeRecord(overrides: Partial<RegistryRecord>): RegistryRecord {
  return {
    registryType: "sanction",
    flagOrCert: "participation_restricted",
    polarity: "known_on_absence",
    bizNo: null,
    corpNo: null,
    nameNormalized: "가나다라마바",
    representative: null,
    regionSido: null,
    validFrom: null,
    validUntil: null,
    detail: null,
    source: "test",
    sourceFetchedAt: new Date(0),
    confidence: 0.9,
    ...overrides,
  };
}

check("완전일치 = 1", () => {
  assert.equal(nameSimilarity("가나다라마바", "가나다라마바"), 1);
});

check("오타 1자 근사 ≥ 0.6", () => {
  const score = nameSimilarity("가나다라마바", "가나다라마사");
  assert.ok(score >= 0.6, `score=${score}`);
  assert.ok(score < 1);
});

check("무관한 상호 ≈ 0", () => {
  const score = nameSimilarity("가나다라마바", "서울전자통신");
  assert.ok(score < 0.2, `score=${score}`);
});

check("짧은 문자열 방어: 길이 1은 완전일치만", () => {
  assert.equal(nameSimilarity("가", "가"), 1);
  assert.equal(nameSimilarity("가", "나"), 0);
  assert.equal(nameSimilarity("가", "가나다"), 0);
  assert.equal(nameSimilarity("", ""), 0);
});

check("fuzzyNameScore: query.name 정규화 후 유사도", () => {
  const record = makeRecord({ nameNormalized: "가나다" });
  // "㈜가나다" → 정규화 "가나다" 완전일치.
  assert.equal(fuzzyNameScore({ name: "㈜가나다" }, record), 1);
  assert.equal(fuzzyNameScore({ name: null }, record), 0);
  assert.equal(fuzzyNameScore({ name: "" }, record), 0);
});

check("fuzzyNameScore: representative 일치 시 가산(상한 1.0)", () => {
  const record = makeRecord({ nameNormalized: "가나다라마바", representative: "홍길동" });
  const base = fuzzyNameScore({ name: "가나다라마사" }, record); // 0.8, rep 미제공
  const boosted = fuzzyNameScore({ name: "가나다라마사", representative: "홍길동" }, record);
  assert.ok(Math.abs(base - 0.8) < 1e-9, `base=${base}`);
  assert.ok(boosted > base, `boosted=${boosted} base=${base}`);
  assert.ok(boosted <= 1);
});

check("fuzzyNameScore: representative 불일치·한쪽만 있으면 가산 없음", () => {
  const record = makeRecord({ nameNormalized: "가나다라마바", representative: "홍길동" });
  const mismatch = fuzzyNameScore({ name: "가나다라마사", representative: "김철수" }, record);
  const base = fuzzyNameScore({ name: "가나다라마사" }, record);
  assert.equal(mismatch, base); // 불일치 → 가산 없음
  const recordNoRep = makeRecord({ nameNormalized: "가나다라마바", representative: null });
  const oneSided = fuzzyNameScore({ name: "가나다라마사", representative: "홍길동" }, recordNoRep);
  assert.equal(oneSided, base); // 한쪽만 존재 → 가산 없음
});

check("fuzzyNameScore: 완전일치 + representative 가산은 1.0 상한", () => {
  const record = makeRecord({ nameNormalized: "가나다", representative: "홍길동" });
  const score = fuzzyNameScore({ name: "가나다", representative: "홍길동" }, record);
  assert.equal(score, 1);
});

console.log(`\nregistry fuzzy-match: ${passed} cases passed.`);
