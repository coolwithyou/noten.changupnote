/**
 * 벤처확인 명단 어댑터 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/registry/adapters/venture-confirmation.test.ts
 *
 * fixture 는 data.go.kr 15084581 실측 13컬럼 헤더를 그대로 쓰고, 벤처확인유형 4종
 * (벤처투자/연구개발/혁신성장/예비벤처)이 모두 canonical "벤처기업" 으로 수렴하는지 +
 * 업체명 결측 skip 1행을 함께 검증한다. 사업자번호가 없어 상호 퍼지 조인만 가능하다.
 */
import assert from "node:assert/strict";
import {
  VENTURE_CONFIRMATION_SOURCE,
  parseVentureConfirmationCsv,
  ventureConfirmationAdapter,
} from "./venture-confirmation.js";
import { matchRegistry } from "../matcher.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 실측 13컬럼 헤더 + 데이터 5행(유형 4종 + 업체명 결측 skip 1행).
const FIXTURE_CSV = [
  "연번,업체명,대표자명(익명),벤처확인유형,지역,주소,업종분류(기보),업종명(11차),주생산품,벤처유효시작일,벤처유효종료일,벤처확인기관,신규_재확인",
  "1,㈜벤처가,홍**,벤처투자유형,서울,서울특별시 강남구 테헤란로 1,J,소프트웨어 개발,클라우드 SaaS,2024-01-01,2026-12-31,벤처기업확인기관,신규",
  "2,주식회사 나노텍,김**,연구개발유형,경기,경기도 성남시 분당구,C,전자부품 제조,센서 모듈,2023-06-01,2025-05-31,기술보증기금,재확인",
  "3,다라 주식회사,이**,혁신성장유형,부산,부산광역시 사하구,C,기계 제조,정밀 부품,2025-03-01,2027-02-28,중소벤처기업진흥공단,신규",
  "4,예비마바,,예비벤처기업유형,대구,대구광역시 달서구,,,,2024-09-01,2026-08-31,벤처기업확인기관,신규",
  "5,,박**,벤처투자유형,인천,인천광역시 남동구,J,소프트웨어,앱,2024-01-01,2026-01-01,벤처기업확인기관,신규",
].join("\n");

const FETCHED = new Date("2026-07-12T00:00:00Z");
const NOW = new Date("2026-07-12T00:00:00Z");

check("파싱: 업체명 결측 행 skip → 4행", () => {
  const records = parseVentureConfirmationCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.equal(records.length, 4);
});

check("첫 행 필드 매핑(flagOrCert 고정·유효기간 파싱·지역·confidence 0.55)", () => {
  const [r0] = parseVentureConfirmationCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.ok(r0);
  assert.equal(r0.registryType, "certification");
  assert.equal(r0.flagOrCert, "벤처기업"); // 유형 무관 canonical.
  assert.equal(r0.polarity, "present_only");
  assert.equal(r0.bizNo, null); // 사업자번호 없음.
  assert.equal(r0.corpNo, null);
  assert.equal(r0.nameNormalized, "벤처가"); // "㈜벤처가" 정규화
  assert.equal(r0.representative, "홍**"); // 익명화 원문 그대로.
  assert.equal(r0.regionSido, "서울");
  assert.equal(r0.validFrom!.getTime(), Date.UTC(2024, 0, 1)); // 2024-01-01
  assert.equal(r0.validUntil!.getTime(), Date.UTC(2026, 11, 31)); // 2026-12-31
  assert.equal(r0.confidence, 0.55);
  assert.equal(r0.source, VENTURE_CONFIRMATION_SOURCE);
  assert.equal(r0.sourceFetchedAt.getTime(), FETCHED.getTime());
});

check("detail: 벤처확인유형·기관·주소만 담기", () => {
  const [r0] = parseVentureConfirmationCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.ok(r0?.detail);
  assert.equal(r0.detail["벤처확인유형"], "벤처투자유형");
  assert.equal(r0.detail["벤처확인기관"], "벤처기업확인기관");
  assert.equal(r0.detail["주소"], "서울특별시 강남구 테헤란로 1");
  // 주생산품/업종 등은 detail 에 넣지 않는다.
  assert.equal(r0.detail["주생산품"], undefined);
});

check("벤처확인유형 4종 모두 canonical '벤처기업' 으로 수렴", () => {
  const records = parseVentureConfirmationCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  const types = records.map((r) => r.detail?.["벤처확인유형"]);
  assert.deepEqual(types, [
    "벤처투자유형",
    "연구개발유형",
    "혁신성장유형",
    "예비벤처기업유형",
  ]);
  // 원문 유형은 제각각이지만 flagOrCert 는 전부 "벤처기업".
  assert.ok(records.every((r) => r.flagOrCert === "벤처기업"));
});

check("빈 대표자·유효기간 파싱: 예비벤처 행", () => {
  const records = parseVentureConfirmationCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  const r3 = records[3]!;
  assert.equal(r3.nameNormalized, "예비마바");
  assert.equal(r3.representative, null); // 대표자 빈값 → null.
  assert.equal(r3.validFrom!.getTime(), Date.UTC(2024, 8, 1)); // 2024-09-01
  assert.equal(r3.validUntil!.getTime(), Date.UTC(2026, 7, 31)); // 2026-08-31
});

check("어댑터 객체: source·registryType·parse 위임", () => {
  assert.equal(ventureConfirmationAdapter.source, VENTURE_CONFIRMATION_SOURCE);
  assert.equal(ventureConfirmationAdapter.registryType, "certification");
  const records = ventureConfirmationAdapter.parse(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.equal(records.length, 4);
});

check("fetchedAt 미제공 시 sourceFetchedAt 자동 Date", () => {
  const [r0] = parseVentureConfirmationCsv(FIXTURE_CSV);
  assert.ok(r0?.sourceFetchedAt instanceof Date);
});

check("헤더에 업체명 컬럼 없으면 전체 skip(빈 배열)", () => {
  const noNameHeader = ["연번,지역,주소", "1,서울,서울특별시"].join("\n");
  assert.deepEqual(parseVentureConfirmationCsv(noNameHeader), []);
});

check("조회: 상호 퍼지(법인격 표기 변형) → fuzzy_name, score 1, active", () => {
  const records = parseVentureConfirmationCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  // 사업자번호가 없으므로 이름 퍼지 경로. "벤처가 주식회사" 는 정규화 후 "벤처가" 로
  // 수렴해 record("㈜벤처가"→"벤처가")와 정확 일치한다.
  const matches = matchRegistry(records, { name: "벤처가 주식회사", now: NOW });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.method, "fuzzy_name");
  assert.equal(matches[0]!.score, 1);
  assert.equal(matches[0]!.active, true); // validUntil 2026-12-31 > NOW
});

console.log(`\nregistry venture-confirmation adapter: ${passed} cases passed.`);
