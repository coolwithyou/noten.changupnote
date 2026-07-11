/**
 * NICE OCOV06 주요경영지표 파서/정규화 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/nicebiz/check-corp-indicator.test.ts
 *
 * fixture = 삼성전자(1248100998) 실측 형태 발췌(2026-07-11). 금액 단위=천원.
 * 로드베어링 검증: salesFvl "238043009000"(천원) × 1000 = 238,043,009,000,000원(238조).
 */
import assert from "node:assert/strict";
import {
  parseNiceIndicator,
  selectLatestIndicator,
  summarizeIndicator,
  type NiceIndicatorMetric,
} from "./check-corp-indicator.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 삼성전자 OCOV06 형태(연도 역순 아님 — 정렬 검증용으로 2022 를 앞에 둠). 금액=천원.
const SAMSUNG_OCOV06 = {
  request: { requestedKey: "1248100998", requestedKeyType: "bizno", tpCd: "01", fatpCd: "0" },
  data: {
    listCount: 2,
    indicatorMetricsList: [
      {
        upchecd: "820610",
        stacDate: "20221231",
        aettamt: "448424507000",
        dbtTtlFvl: "93674903000",
        fdsTtlFvl: "354749604000",
        salesFvl: "302231360000",
        slsprftFvl: "43376630000",
        nrf: "55654077000",
        auditOptionList: [{ auditKornm: "적정", auditEngnm: "Unqualified", auditor: "삼정회계법인" }],
      },
      {
        upchecd: "820610",
        stacDate: "20231231",
        aettamt: "455905980000",
        dbtTtlFvl: "92228115000",
        fdsTtlFvl: "363677865000",
        salesFvl: "238043009000",
        slsprftFvl: "6566976000",
        nrf: "15487100000",
        auditOptionList: [{ auditKornm: "적정", auditEngnm: "Unqualified", auditor: "삼정회계법인" }],
      },
    ],
  },
};

check("최신 연도(2023, stacDate 최대) 선택", () => {
  const list = SAMSUNG_OCOV06.data.indicatorMetricsList as NiceIndicatorMetric[];
  const latest = selectLatestIndicator(list);
  assert.ok(latest);
  assert.equal(latest!.stacDate, "20231231");
});

check("정규화 → 천원×1000 원 환산 · 부채비율 · 자본잠식", () => {
  const list = SAMSUNG_OCOV06.data.indicatorMetricsList as NiceIndicatorMetric[];
  const summary = summarizeIndicator(list[1]!);
  // 로드베어링: 238조.
  assert.equal(summary.revenueWon, 238043009000000);
  assert.equal(summary.totalAssetsWon, 455905980000000);
  assert.equal(summary.totalEquityWon, 363677865000000);
  assert.equal(summary.totalLiabilitiesWon, 92228115000000);
  assert.equal(summary.operatingProfitWon, 6566976000000);
  assert.equal(summary.netIncomeWon, 15487100000000);
  // 92228115 / 363677865 × 100 = 25.3598… → 25.4.
  assert.equal(summary.debtRatioPct, 25.4);
  assert.equal(summary.impaired, false);
  assert.equal(summary.bizYear, "2023");
  assert.equal(summary.auditOpinion, "적정");
});

check("parseNiceIndicator(전체 응답) → 최신 연도 요약", () => {
  const summary = parseNiceIndicator(SAMSUNG_OCOV06);
  assert.ok(summary);
  assert.equal(summary!.bizYear, "2023");
  assert.equal(summary!.revenueWon, 238043009000000);
});

check("자본총계 ≤ 0 → 자본잠식 true · 부채비율 null", () => {
  const impaired = summarizeIndicator({
    stacDate: "20201231",
    dbtTtlFvl: "5000000",
    fdsTtlFvl: "-1000000",
    salesFvl: "8000000",
  });
  assert.equal(impaired.impaired, true);
  assert.equal(impaired.debtRatioPct, null);
});

check("빈 indicatorMetricsList → null", () => {
  const empty = parseNiceIndicator({
    request: {},
    data: { message: "데이터가 존재하지 않습니다.", listCount: 0, indicatorMetricsList: [] },
  });
  assert.equal(empty, null);
});

check("data 없는 봉투 → null", () => {
  assert.equal(parseNiceIndicator({ request: {} }), null);
});

console.log(`\nNICE check-corp-indicator: ${passed} cases passed.`);
