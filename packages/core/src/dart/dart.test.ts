import assert from "node:assert/strict";
import { findDartCorpCodeCandidates, parseDartCorpCodes } from "./corp-code.js";
import { checkDartCompanyOverview, parseDartCompanyOverview } from "./company-overview.js";
import { checkDartEmployeeStatus, parseDartEmployeeStatus } from "./employee-status.js";
import { parseDartFinancialAccounts } from "./financial-accounts.js";

const corpCodeXml = `<result>
  <list><corp_code>00126380</corp_code><corp_name>삼성전자</corp_name><corp_eng_name>SAMSUNG ELECTRONICS CO,.LTD</corp_eng_name><stock_code>005930</stock_code><modify_date>20260630</modify_date></list>
  <list><corp_code>00999999</corp_code><corp_name>주식회사 테스트</corp_name><corp_eng_name></corp_eng_name><stock_code></stock_code><modify_date>20260701</modify_date></list>
</result>`;
const entries = parseDartCorpCodes(corpCodeXml);
assert.equal(entries.length, 2);
assert.equal(findDartCorpCodeCandidates(entries, "(주) 테스트")[0]?.corpCode, "00999999");

const overviewPayload = {
  status: "000",
  message: "정상",
  corp_code: "00126380",
  corp_name: "삼성전자",
  stock_code: "005930",
  corp_cls: "Y",
  jurir_no: "1301110006246",
  bizr_no: "1248100998",
  est_dt: "19690113",
  induty_code: "264",
};
assert.deepEqual(parseDartCompanyOverview(overviewPayload), {
  corpCode: "00126380",
  corpName: "삼성전자",
  stockCode: "005930",
  corpClass: "Y",
  businessRegistrationNumber: "1248100998",
  corporateRegistrationNumber: "1301110006246",
  establishedOn: "19690113",
  industryCode: "264",
});
assert.equal(parseDartCompanyOverview({ status: "013", message: "조회된 데이터가 없습니다." }), null);

let requested = "";
const overview = await checkDartCompanyOverview({
  apiKey: "x".repeat(40),
  corpCode: "00126380",
  fetchImpl: async (input) => {
    requested = String(input);
    return new Response(JSON.stringify(overviewPayload), { status: 200 });
  },
});
assert.equal(overview?.corporateRegistrationNumber, "1301110006246");
assert.equal(new URL(requested).searchParams.get("corp_code"), "00126380");

const employeePayload = {
  status: "000",
  message: "정상",
  list: [
    { rcept_no: "20260317001000", fo_bbm: "사업부A", rgllbr_co: "1,000", cnttk_co: "50", sm: "1,050", stlm_dt: "20251231" },
    { rcept_no: "20260317001000", fo_bbm: "사업부B", rgllbr_co: "900", cnttk_co: "40", sm: "940", stlm_dt: "20251231" },
    { rcept_no: "20260317001000", fo_bbm: "성별합계", rgllbr_co: "1,900", cnttk_co: "90", sm: "1,990", stlm_dt: "20251231" },
  ],
};
assert.deepEqual(
  parseDartEmployeeStatus(employeePayload, { corpCode: "00126380", businessYear: "2025", reportCode: "11011" }),
  {
    corpCode: "00126380",
    businessYear: "2025",
    reportCode: "11011",
    receptionNo: "20260317001000",
    settlementDate: "2025-12-31",
    totalEmployees: 1990,
    regularEmployees: 1900,
    contractEmployees: 90,
    rowCount: 3,
  },
);
assert.equal(
  parseDartEmployeeStatus(
    { status: "013", message: "조회된 데이터가 없습니다." },
    { corpCode: "00126380", businessYear: "2025", reportCode: "11011" },
  ),
  null,
);
let employeeRequested = "";
await checkDartEmployeeStatus({
  apiKey: "x".repeat(40),
  corpCode: "00126380",
  businessYear: "2025",
  reportCode: "11011",
  fetchImpl: async (input) => {
    employeeRequested = String(input);
    return new Response(JSON.stringify(employeePayload), { status: 200 });
  },
});
assert.equal(new URL(employeeRequested).searchParams.get("bsns_year"), "2025");
assert.equal(new URL(employeeRequested).searchParams.get("reprt_code"), "11011");

const financialPayload = {
  status: "000",
  message: "정상",
  list: [
    { rcept_no: "20260317001000", fs_div: "CFS", fs_nm: "연결재무제표", account_nm: "매출액", thstrm_amount: "300,000", thstrm_dt: "2025.12.31", currency: "KRW" },
    { rcept_no: "20260317001000", fs_div: "CFS", fs_nm: "연결재무제표", account_nm: "자산총계", thstrm_amount: "500,000", thstrm_dt: "2025.12.31", currency: "KRW" },
    { rcept_no: "20260317001000", fs_div: "CFS", fs_nm: "연결재무제표", account_nm: "부채총계", thstrm_amount: "200,000", thstrm_dt: "2025.12.31", currency: "KRW" },
    { rcept_no: "20260317001000", fs_div: "CFS", fs_nm: "연결재무제표", account_nm: "자본총계", thstrm_amount: "300,000", thstrm_dt: "2025.12.31", currency: "KRW" },
    { rcept_no: "20260317001000", fs_div: "OFS", fs_nm: "재무제표", account_nm: "매출액", thstrm_amount: "250,000", thstrm_dt: "2025.12.31", currency: "KRW" },
    { rcept_no: "20260317001000", fs_div: "OFS", fs_nm: "재무제표", account_nm: "자산총계", thstrm_amount: "450,000", thstrm_dt: "2025.12.31", currency: "KRW" },
  ],
};
const financial = parseDartFinancialAccounts(financialPayload, {
  corpCode: "00126380",
  businessYear: "2025",
  reportCode: "11011",
});
assert.equal(financial.length, 2);
assert.equal(financial[0]?.statementType, "CFS");
assert.equal(financial[0]?.revenue, 300000);
assert.equal(financial[0]?.totalEquity, 300000);
assert.equal(financial[1]?.statementType, "OFS");
assert.equal(financial[1]?.revenue, 250000);
assert.deepEqual(
  parseDartFinancialAccounts(
    { status: "013", message: "조회된 데이터가 없습니다." },
    { corpCode: "00126380", businessYear: "2024", reportCode: "11011" },
  ),
  [],
);

console.log("dart/dart.test.ts: all assertions passed");
