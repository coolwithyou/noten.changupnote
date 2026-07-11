/**
 * registry 인메모리 매처 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/registry/matcher.test.ts
 */
import assert from "node:assert/strict";
import { matchRegistry } from "./matcher.js";
import type { RegistryRecord } from "./types.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const NOW = new Date("2026-07-12T00:00:00Z");
const FUTURE = new Date("2030-01-01T00:00:00Z");
const PAST = new Date("2020-01-01T00:00:00Z");

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
    confidence: 0.95,
    ...overrides,
  };
}

check("사업자번호 정확 매칭 → exact_biz_no, score 1", () => {
  const records = [
    makeRecord({ bizNo: "1111111111", nameNormalized: "가나다라마바" }),
    makeRecord({ bizNo: "2222222222", nameNormalized: "서울전자통신" }),
  ];
  const matches = matchRegistry(records, { bizNo: "111-11-11111", now: NOW });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.method, "exact_biz_no");
  assert.equal(matches[0]!.score, 1);
  assert.equal(matches[0]!.record.bizNo, "1111111111");
});

check("법인번호 폴백 → exact_corp_no", () => {
  const records = [
    makeRecord({ bizNo: null, corpNo: "1101111234567", nameNormalized: "서울전자통신" }),
  ];
  const matches = matchRegistry(records, { corpNo: "110111-1234567", now: NOW });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.method, "exact_corp_no");
  assert.equal(matches[0]!.score, 1);
});

check("이름 퍼지 매칭 → fuzzy_name(기본 임계값 0.6)", () => {
  const records = [
    makeRecord({ nameNormalized: "가나다라마바" }), // 0.8
    makeRecord({ nameNormalized: "가나다라마사" }), // 1.0
    makeRecord({ nameNormalized: "서울전자통신" }), // ~0
  ];
  const matches = matchRegistry(records, { name: "가나다라마사", now: NOW });
  assert.equal(matches.length, 2);
  // 정렬: 점수 desc → 1.0 먼저.
  assert.equal(matches[0]!.method, "fuzzy_name");
  assert.equal(matches[0]!.record.nameNormalized, "가나다라마사");
  assert.equal(matches[1]!.record.nameNormalized, "가나다라마바");
});

check("퍼지 임계값 경계: 높은 임계값은 근사치 배제", () => {
  const records = [
    makeRecord({ nameNormalized: "가나다라마바" }), // 0.8
    makeRecord({ nameNormalized: "가나다라마사" }), // 1.0
  ];
  const strict = matchRegistry(records, { name: "가나다라마사", now: NOW }, { fuzzyThreshold: 0.9 });
  assert.equal(strict.length, 1);
  assert.equal(strict[0]!.record.nameNormalized, "가나다라마사");
});

check("임계값 미만 이름은 미매치", () => {
  const records = [makeRecord({ nameNormalized: "가나다라마바" })];
  const matches = matchRegistry(records, { name: "가나마바사아", now: NOW }); // ~0.4
  assert.equal(matches.length, 0);
});

check("활성창: validUntil 미래=active, 과거=inactive, null=active", () => {
  const records = [
    makeRecord({ bizNo: "1111111111", validUntil: FUTURE }),
    makeRecord({ bizNo: "1111111111", validUntil: PAST }),
    makeRecord({ bizNo: "1111111111", validUntil: null }),
  ];
  const matches = matchRegistry(records, { bizNo: "1111111111", now: NOW });
  assert.equal(matches.length, 3);
  const byActive = matches.map((m) => m.active);
  // 정렬상 active(true)가 앞: [true, true, false].
  assert.deepEqual(byActive, [true, true, false]);
});

check("활성창 경계: validUntil == now 는 active(>= 판정)", () => {
  const records = [makeRecord({ bizNo: "1111111111", validUntil: NOW })];
  const matches = matchRegistry(records, { bizNo: "1111111111", now: NOW });
  assert.equal(matches[0]!.active, true);
});

check("정렬: exact_biz_no > exact_corp_no > fuzzy_name", () => {
  const records = [
    makeRecord({ bizNo: null, corpNo: null, nameNormalized: "가나다라마사" }), // fuzzy
    makeRecord({ bizNo: null, corpNo: "1101111234567", nameNormalized: "서울전자통신" }), // corp
    makeRecord({ bizNo: "1111111111", corpNo: null, nameNormalized: "부산기계공업" }), // biz
  ];
  const matches = matchRegistry(
    records,
    { bizNo: "1111111111", corpNo: "110111-1234567", name: "가나다라마사", now: NOW },
  );
  assert.equal(matches.length, 3);
  assert.deepEqual(
    matches.map((m) => m.method),
    ["exact_biz_no", "exact_corp_no", "fuzzy_name"],
  );
});

console.log(`\nregistry matcher: ${passed} cases passed.`);
