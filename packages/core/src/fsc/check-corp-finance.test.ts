/**
 * FSC 기업재무(요약재무제표) 파서/정규화 단위 테스트 (node:assert, tsx 실행).
 * 실행: pnpm exec tsx packages/core/src/fsc/check-corp-finance.test.ts
 *
 * fixture = 삼성전자(crno 1301110006246) 실응답 발췌(2026-07-11 실측).
 */
import assert from "node:assert/strict";
import {
  parseFscCorpFinance,
  selectLatestCorpFinance,
  summarizeCorpFinance,
  type FscCorpFinanceItem,
} from "./check-corp-finance.js";

let passed = 0;
function check(name: string, fn: () => void): void {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 삼성전자 실응답(연결 110 / 별도 120 각 연도) 발췌.
const SAMSUNG_RESPONSE = {
  response: {
    header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
    body: {
      items: {
        item: [
          {
            basDt: "20151231", crno: "1301110006246", bizYear: "2015", fnclDcd: "110", fnclDcdNm: "연결요약재무제표",
            enpSaleAmt: "200653482000000", enpBzopPft: "26413442000000", enpCrtmNpf: "19060144000000",
            enpTastAmt: "242179521000000", enpTdbtAmt: "63119716000000", enpTcptAmt: "179059805000000",
            enpCptlAmt: "0", fnclDebtRto: "35.2506337198", curCd: "KRW",
          },
          {
            basDt: "20171231", crno: "1301110006246", bizYear: "2017", fnclDcd: "110", fnclDcdNm: "연결요약재무제표",
            enpSaleAmt: "239575376000000", enpBzopPft: "53645038000000", enpCrtmNpf: "42186747000000",
            enpTastAmt: "301752090000000", enpTdbtAmt: "87260662000000", enpTcptAmt: "214491428000000",
            enpCptlAmt: "897514000000", fnclDebtRto: "40.6825870915", curCd: "KRW",
          },
          {
            basDt: "20171231", crno: "1301110006246", bizYear: "2017", fnclDcd: "120", fnclDcdNm: "별도요약재무제표",
            enpSaleAmt: "161915007000000", enpBzopPft: "34857091000000", enpCrtmNpf: "28800837000000",
            enpTastAmt: "198241360000000", enpTdbtAmt: "46671585000000", enpTcptAmt: "151569775000000",
            enpCptlAmt: "897514000000", fnclDebtRto: "30.7921450698", curCd: "KRW",
          },
        ],
      },
    },
  },
};

check("최신 연도(2017) + 별도(120) 우선 선택", () => {
  const items = SAMSUNG_RESPONSE.response.body.items.item as FscCorpFinanceItem[];
  const latest = selectLatestCorpFinance(items);
  assert.ok(latest);
  assert.equal(latest!.bizYear, "2017");
  assert.equal(latest!.fnclDcd, "120");
});

check("정규화 → 매출·부채비율·자본잠식 파생", () => {
  const summary = summarizeCorpFinance(
    (SAMSUNG_RESPONSE.response.body.items.item as FscCorpFinanceItem[])[2]!,
  );
  assert.equal(summary.saleAmt, 161915007000000);
  assert.equal(summary.totalLiabilities, 46671585000000);
  assert.equal(summary.totalEquity, 151569775000000);
  assert.equal(summary.capital, 897514000000);
  assert.equal(summary.debtRatioPct, 30.79);
  assert.equal(summary.impaired, false);
  assert.equal(summary.currency, "KRW");
});

check("parseFscCorpFinance(전체 응답) → 최신 별도재무제표 요약", () => {
  const summary = parseFscCorpFinance(SAMSUNG_RESPONSE);
  assert.ok(summary);
  assert.equal(summary!.bizYear, "2017");
  assert.equal(summary!.fnclDcdNm, "별도요약재무제표");
  assert.equal(summary!.saleAmt, 161915007000000);
});

check("자본총계 ≤ 0 → 자본잠식 true", () => {
  const impaired = summarizeCorpFinance({
    bizYear: "2020", fnclDcd: "120", enpTdbtAmt: "500", enpTcptAmt: "-100", enpSaleAmt: "1000",
  });
  assert.equal(impaired.impaired, true);
});

check("부채비율 응답값 없으면 부채/자본×100 계산", () => {
  const s = summarizeCorpFinance({ enpTdbtAmt: "300", enpTcptAmt: "600" });
  assert.equal(s.debtRatioPct, 50);
});

check("빈 items → null", () => {
  const empty = parseFscCorpFinance({ response: { header: { resultCode: "00" }, body: { items: "" } } });
  assert.equal(empty, null);
});

check("resultCode 오류 → throw", () => {
  assert.throws(() =>
    parseFscCorpFinance({ response: { header: { resultCode: "22", resultMsg: "LIMITED_NUMBER" } } }),
  );
});

console.log(`\nFSC check-corp-finance: ${passed} cases passed.`);
