/**
 * 조달청 부정당 어댑터 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/registry/adapters/procurement-debarment.test.ts
 *
 * fixture 는 data.go.kr 15137996 실측 18컬럼 헤더를 그대로 쓰고, 활성(미래 종료일)·
 * 만료(과거 종료일)·무기한(빈 종료일) 3케이스 + 업체명 결측 skip 1행으로 구성했다.
 */
import assert from "node:assert/strict";
import {
  PROCUREMENT_DEBARMENT_SOURCE,
  parseProcurementDebarmentCsv,
  procurementDebarmentAdapter,
} from "./procurement-debarment.js";
import { matchRegistry } from "../matcher.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 실측 18컬럼 헤더 + 데이터 4행(마지막은 업체명 결측 → skip 대상).
const FIXTURE_CSV = [
  "계약법구분,기관,법인등록번호,사업자등록번호,소관구분,시행규칙76조별표2,시행규칙76조별표2명,업체,제재근거법률,제재기간월수,제재기간일수,제재시작일자,제재입력일시,제재종료일자,조달업무영역,조문명,조항호,처분상태",
  '국가계약법,조달청,110111-1234567,123-45-67890,중앙,1,뇌물 제공,㈜가나다,"국가계약법 제27조, 시행령 제76조",6,180,2026-01-01,2026-01-02 10:00,2030-01-01,물품,부정당업자 제재,제1항,확정',
  "국가계약법,조달청,220222-2222222,222-22-22222,중앙,2,계약 불이행,주식회사 마바사,국가계약법 제27조,12,365,2019-01-01,2019-01-05 09:00,2020-06-30,용역,부정당업자 제재,제2항,확정",
  "국가계약법,조달청,,333-33-33333,지방,3,부정 행위,다라마 유한회사,지방계약법 제31조,,,2018-05-01,2018-05-02 00:00,,공사,부정당업자 제재,제3항,확정",
  "국가계약법,조달청,,444-44-44444,지방,4,기타,,,,,2017-01-01,2017-01-02 00:00,2019-01-01,공사,부정당업자 제재,제4항,취소",
].join("\n");

const FETCHED = new Date("2026-07-12T00:00:00Z");
const NOW = new Date("2026-07-12T00:00:00Z");

check("파싱: 업체명 결측 행 skip → 3행", () => {
  const records = parseProcurementDebarmentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.equal(records.length, 3);
});

check("활성 행(미래 종료일) 필드 매핑", () => {
  const [r0] = parseProcurementDebarmentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.ok(r0);
  assert.equal(r0.registryType, "sanction");
  assert.equal(r0.flagOrCert, "participation_restricted");
  assert.equal(r0.polarity, "known_on_absence");
  assert.equal(r0.bizNo, "1234567890");
  assert.equal(r0.corpNo, "1101111234567");
  assert.equal(r0.nameNormalized, "가나다"); // "㈜가나다" 정규화
  assert.equal(r0.representative, null);
  assert.equal(r0.regionSido, null);
  assert.equal(r0.validFrom!.getTime(), Date.UTC(2026, 0, 1));
  assert.equal(r0.validUntil!.getTime(), Date.UTC(2030, 0, 1));
  assert.equal(r0.source, PROCUREMENT_DEBARMENT_SOURCE);
  assert.equal(r0.confidence, 0.95);
  assert.equal(r0.sourceFetchedAt.getTime(), FETCHED.getTime());
});

check("detail: 있는 값만 담기(따옴표 콤마 필드 포함)", () => {
  const [r0] = parseProcurementDebarmentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.ok(r0?.detail);
  assert.equal(r0.detail["처분상태"], "확정");
  assert.equal(r0.detail["기관"], "조달청");
  assert.equal(r0.detail["제재근거법률"], "국가계약법 제27조, 시행령 제76조");
  assert.equal(r0.detail["시행규칙76조별표2명"], "뇌물 제공");
  assert.equal(r0.detail["조문명"], "부정당업자 제재");
  assert.equal(r0.detail["조항호"], "제1항");
  assert.equal(r0.detail["제재기간일수"], "180");
});

check("만료 행(과거 종료일)·무기한 행(빈 종료일) 매핑", () => {
  const records = parseProcurementDebarmentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  const expired = records[1]!;
  assert.equal(expired.nameNormalized, "마바사"); // "주식회사 마바사"
  assert.equal(expired.bizNo, "2222222222");
  assert.equal(expired.validUntil!.getTime(), Date.UTC(2020, 5, 30));

  const perpetual = records[2]!;
  assert.equal(perpetual.nameNormalized, "다라마"); // "다라마 유한회사"
  assert.equal(perpetual.corpNo, null); // 법인등록번호 빈값
  assert.equal(perpetual.validFrom!.getTime(), Date.UTC(2018, 4, 1));
  assert.equal(perpetual.validUntil, null); // 무기한
});

check("어댑터 객체: source·registryType·parse 위임", () => {
  assert.equal(procurementDebarmentAdapter.source, PROCUREMENT_DEBARMENT_SOURCE);
  assert.equal(procurementDebarmentAdapter.registryType, "sanction");
  const records = procurementDebarmentAdapter.parse(FIXTURE_CSV, { fetchedAt: FETCHED });
  assert.equal(records.length, 3);
});

check("fetchedAt 미제공 시 sourceFetchedAt 자동 Date", () => {
  const [r0] = parseProcurementDebarmentCsv(FIXTURE_CSV);
  assert.ok(r0?.sourceFetchedAt instanceof Date);
});

check("조회: 등록 사업자번호 → exact_biz_no·known_on_absence·active", () => {
  const records = parseProcurementDebarmentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  const matches = matchRegistry(records, { bizNo: "123-45-67890", now: NOW });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.method, "exact_biz_no");
  assert.equal(matches[0]!.score, 1);
  assert.equal(matches[0]!.active, true); // 2030 종료 > NOW
  assert.equal(matches[0]!.record.polarity, "known_on_absence");
});

check("조회: 만료 제재 사업자번호 → 매치되지만 active=false", () => {
  const records = parseProcurementDebarmentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  const matches = matchRegistry(records, { bizNo: "222-22-22222", now: NOW });
  assert.equal(matches.length, 1);
  assert.equal(matches[0]!.active, false); // 2020 종료 < NOW
});

check("조회: 미등록 사업자번호 → 빈 결과(부재 = known clear 근거)", () => {
  const records = parseProcurementDebarmentCsv(FIXTURE_CSV, { fetchedAt: FETCHED });
  const matches = matchRegistry(records, { bizNo: "999-99-99999", now: NOW });
  assert.equal(matches.length, 0);
});

console.log(`\nregistry procurement-debarment adapter: ${passed} cases passed.`);
