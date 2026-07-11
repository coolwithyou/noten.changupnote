/**
 * kcomwel 고용·산재 파서/정규화 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/kcomwel/check-employment.test.ts
 *
 * NOTE: 라이브 게이트웨이가 현재 HTTP 502 라서 fixture 는 data.go.kr 문서화 스키마(표준
 * data.go.kr XML: header.resultCode + body.items.item[] · sangsiInwonCnt/saeopjangNm/
 * addr/seongripDt)로 구성했다. 실응답 확인 시 fixture 를 실데이터로 교체할 것.
 */
import assert from "node:assert/strict";
import {
  parseKcomwelEmployment,
  parseKcomwelSites,
  summarizeKcomwelSites,
} from "./check-employment.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const TWO_SITES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><resultCode>00</resultCode><resultMsg>NORMAL SERVICE.</resultMsg></header>
  <body>
    <items>
      <item>
        <saeopjangNm>가나다 주식회사 본사</saeopjangNm>
        <sangsiInwonCnt>120</sangsiInwonCnt>
        <addr>서울특별시 강남구</addr>
        <seongripDt>20120301</seongripDt>
        <gyEopjongNm>소프트웨어 개발</gyEopjongNm>
        <saeopFg>1</saeopFg>
      </item>
      <item>
        <saeopjangNm>가나다 주식회사 물류센터</saeopjangNm>
        <sangsiInwonCnt>30</sangsiInwonCnt>
        <addr>경기도 이천시</addr>
        <seongripDt>20100915</seongripDt>
        <gyEopjongNm>창고 및 운송관련</gyEopjongNm>
        <saeopFg>1</saeopFg>
      </item>
    </items>
    <numOfRows>10</numOfRows><pageNo>1</pageNo><totalCount>2</totalCount>
  </body>
</response>`;

const NO_DATA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<response>
  <header><resultCode>03</resultCode><resultMsg>NODATA_ERROR</resultMsg></header>
  <body><items></items><numOfRows>10</numOfRows><pageNo>1</pageNo><totalCount>0</totalCount></body>
</response>`;

const AUTH_ERROR_XML = `<OpenAPI_ServiceResponse><cmmMsgHeader><returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>`;

check("두 사업장 파싱 → 필드 추출", () => {
  const sites = parseKcomwelSites(TWO_SITES_XML);
  assert.equal(sites.length, 2);
  assert.equal(sites[0]!.saeopjangNm, "가나다 주식회사 본사");
  assert.equal(sites[0]!.sangsiInwonCnt, 120);
  assert.equal(sites[0]!.seongripDt, "20120301");
  assert.equal(sites[1]!.sangsiInwonCnt, 30);
});

check("요약 → 상시인원 합산·최소 성립일·성립여부", () => {
  const summary = summarizeKcomwelSites(parseKcomwelSites(TWO_SITES_XML), "employment");
  assert.equal(summary.siteCount, 2);
  assert.equal(summary.totalWorkers, 150);
  assert.equal(summary.earliestSeongripDt, "20100915");
  assert.equal(summary.primarySiteName, "가나다 주식회사 본사");
  assert.equal(summary.insuranceActive, true);
});

check("parseKcomwelEmployment(정상 XML) → 요약", () => {
  const summary = parseKcomwelEmployment(TWO_SITES_XML, "employment");
  assert.ok(summary);
  assert.equal(summary!.totalWorkers, 150);
});

check("데이터 없음(resultCode 03) → null", () => {
  assert.equal(parseKcomwelEmployment(NO_DATA_XML, "employment"), null);
});

check("인증 오류 코드 → throw", () => {
  assert.throws(() => parseKcomwelEmployment(AUTH_ERROR_XML, "employment"));
});

console.log(`\nkcomwel check-employment: ${passed} cases passed.`);
