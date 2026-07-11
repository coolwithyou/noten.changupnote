/**
 * FSC 개인사업자재무 분류기 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/fsc/check-personal-finance.test.ts
 *
 * fixture = 실응답 발췌(2026-07-11 실측): bzno 무시, 익명 집계 item(사업자 식별자 없음).
 */
import assert from "node:assert/strict";
import { classifyFscPersonalFinance } from "./check-personal-finance.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 실응답 발췌: 사업자번호를 넣어도 지역·성별·연령대 익명 버킷만 반환(bzno 필드 없음).
const AGGREGATE_RESPONSE = {
  response: {
    header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
    body: {
      numOfRows: 1,
      pageNo: 1,
      totalCount: 416643,
      items: {
        item: [
          {
            basYm: "202208", rprSexNm: "남성", rprAggrNm: "50대", estbYr: "2002",
            bizAreaNm: "강원도 강릉시", bizBzcCd: "47", bizBzcCdNm: "소매업; 자동차 제외",
            empeCntNm: "1명 이상 5명 미만", fnafBasYr: "2021", cptlAmt: "181000000",
            saleAmt: "774000000", bzopPftAmt: "53000000", crtmNpfAmt: "56000000",
            astTsumAmt: "841000000", debtTsumAmt: "524000000",
          },
        ],
      },
    },
  },
};

check("익명 집계셋 분류(aggregate) + 사업자 식별자 없음", () => {
  const c = classifyFscPersonalFinance(AGGREGATE_RESPONSE);
  assert.equal(c.kind, "aggregate");
  assert.equal(c.totalCount, 416643);
  assert.equal(c.hasBusinessIdentifier, false);
  assert.ok(c.sampleFields.includes("saleAmt"));
  assert.ok(!c.sampleFields.includes("bzno"));
});

check("빈 items → empty", () => {
  const c = classifyFscPersonalFinance({
    response: { header: { resultCode: "00" }, body: { totalCount: 0, items: "" } },
  });
  assert.equal(c.kind, "empty");
});

check("사업자 식별자 필드 존재 시 hasBusinessIdentifier=true(미래 대비)", () => {
  const c = classifyFscPersonalFinance({
    response: { body: { totalCount: 1, items: { item: [{ bzno: "1234567890", saleAmt: "100" }] } } },
  });
  assert.equal(c.hasBusinessIdentifier, true);
});

check("resultCode 오류 → throw", () => {
  assert.throws(() =>
    classifyFscPersonalFinance({ response: { header: { resultCode: "30", resultMsg: "SERVICE_KEY_ERROR" } } }),
  );
});

console.log(`\nFSC check-personal-finance: ${passed} cases passed.`);
