/**
 * 중대재해 명단 어댑터 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/registry/adapters/serious-accident.test.ts
 *
 * fixture 는 data.go.kr 15090150 실측 11컬럼 헤더를 그대로 쓰고, 정상 2행 +
 * 사업장명 결측 skip 1행으로 구성했다. 사업자번호·대표자가 없으므로 상호(사업장명)+
 * 지역 퍼지 조인만 가능함을 matchRegistry 로 확인한다.
 */
import assert from "node:assert/strict";
import {
  SERIOUS_ACCIDENT_SOURCE,
  parseSeriousAccidentCsv,
  seriousAccidentAdapter,
} from "./serious-accident.js";
import { matchRegistry } from "../matcher.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 실측 11컬럼 헤더 + 데이터 3행(마지막은 사업장명 결측 → skip 대상).
const FIXTURE_CSV = [
  "재해발생연도,지역,업종명(중분류),규모,사업장명(현장명),사업장 소재지,중대재해 재해자수(명),근로자수(명),재해자수(명),재해율(퍼센트),규모별 동종업종 평균재해율(퍼센트)",
  "2024,서울,건설업,50인이상,㈜가나건설,서울특별시 강남구,1,120,1,0.83,0.55",
  "2024,부산,제조업,300인이상,주식회사 마바산업,부산광역시 해운대구,2,300,3,1.00,0.72",
  "2024,대구,운수업,50인미만,,대구광역시 중구,1,40,1,2.50,1.10",
].join("\n");

const FETCHED = new Date("2026-07-12T00:00:00Z");
const NOW = new Date("2026-07-12T00:00:00Z");

check("파싱: 사업장명 결측 행 skip → 2행", () => {
  const records = parseSeriousAccidentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.equal(records.length, 2);
});

check("첫 행 필드 매핑(상호 정규화·지역·confidence 0.5·유효기간 null)", () => {
  const [r0] = parseSeriousAccidentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.ok(r0);
  assert.equal(r0.registryType, "sanction");
  assert.equal(r0.flagOrCert, "serious_accident_listed");
  assert.equal(r0.polarity, "present_only");
  assert.equal(r0.bizNo, null); // 사업자번호 없음.
  assert.equal(r0.corpNo, null);
  assert.equal(r0.nameNormalized, "가나건설"); // "㈜가나건설" 정규화
  assert.equal(r0.representative, null); // 대표자 없음.
  assert.equal(r0.regionSido, "서울");
  assert.equal(r0.validFrom, null); // 연도 스냅샷 — 유효기간 없음.
  assert.equal(r0.validUntil, null);
  assert.equal(r0.confidence, 0.5);
  assert.equal(r0.source, SERIOUS_ACCIDENT_SOURCE);
  assert.equal(r0.sourceFetchedAt.getTime(), FETCHED.getTime());
});

check("detail: 지정 필드만 있는 값으로 담기", () => {
  const [r0] = parseSeriousAccidentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.ok(r0?.detail);
  assert.equal(r0.detail["재해발생연도"], "2024");
  assert.equal(r0.detail["업종명(중분류)"], "건설업");
  assert.equal(r0.detail["규모"], "50인이상");
  assert.equal(r0.detail["사업장 소재지"], "서울특별시 강남구");
  assert.equal(r0.detail["재해율(퍼센트)"], "0.83");
  // 명시하지 않은 재해자수/근로자수 컬럼은 detail 에 넣지 않는다.
  assert.equal(r0.detail["근로자수(명)"], undefined);
});

check("둘째 행: 법인격 접미 표기 정규화·지역", () => {
  const records = parseSeriousAccidentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  const r1 = records[1]!;
  assert.equal(r1.nameNormalized, "마바산업"); // "주식회사 마바산업"
  assert.equal(r1.regionSido, "부산");
  assert.equal(r1.confidence, 0.5);
});

check("어댑터 객체: source·registryType·parse 위임", () => {
  assert.equal(seriousAccidentAdapter.source, SERIOUS_ACCIDENT_SOURCE);
  assert.equal(seriousAccidentAdapter.registryType, "sanction");
  const records = seriousAccidentAdapter.parse(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.equal(records.length, 2);
});

check("fetchedAt 미제공 시 sourceFetchedAt 자동 Date", () => {
  const [r0] = parseSeriousAccidentCsv(FIXTURE_CSV);
  assert.ok(r0?.sourceFetchedAt instanceof Date);
});

check("헤더에 사업장명 컬럼 없으면 전체 skip(빈 배열)", () => {
  const noNameHeader = ["재해발생연도,지역,규모", "2024,서울,50인이상"].join("\n");
  assert.deepEqual(parseSeriousAccidentCsv(noNameHeader), []);
});

check("조회: 상호+지역 정규화 정확 일치 → fuzzy_name, score 1", () => {
  const records = parseSeriousAccidentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  // 사업자번호가 없으므로 이름 퍼지 경로로 매칭된다. 법인격 표기가 붙은 원문을
  // 넘겨도 정규화 후 "가나건설" 로 수렴해 정확 일치(=1) 한다.
  const matches = matchRegistry(records, {
    name: "㈜가나건설",
    regionSido: "서울",
    now: NOW,
  });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.method, "fuzzy_name");
  assert.equal(matches[0]!.score, 1); // 정규화 상호 정확 일치(지역 가산 상한 1.0)
  assert.equal(matches[0]!.active, true); // validUntil null → 항상 active
  assert.equal(matches[0]!.record.polarity, "present_only");
});

console.log(`\nregistry serious-accident adapter: ${passed} cases passed.`);
