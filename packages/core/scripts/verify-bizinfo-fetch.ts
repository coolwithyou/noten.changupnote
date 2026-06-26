import assert from "node:assert/strict";
import { assertBizInfoApiResponse, buildBizInfoUrl } from "../src/index.js";

const url = buildBizInfoUrl("https://example.test/uss/rss/bizinfoApi.do", "abc/def==");
assert.equal(
  url,
  "https://example.test/uss/rss/bizinfoApi.do?crtfcKey=abc%2Fdef%3D%3D&dataType=json",
);

const programPayload = assertBizInfoApiResponse({
  jsonArray: [{ pblancId: "PBLN_1", pblancNm: "테스트 지원사업" }],
}, "program");
assert.equal(programPayload.jsonArray[0]?.pblancId, "PBLN_1");

const eventPayload = assertBizInfoApiResponse({
  jsonArray: [{ eventInfoId: "EVEN_1", nttNm: "테스트 행사" }],
}, "event");
assert.equal(eventPayload.jsonArray[0]?.eventInfoId, "EVEN_1");

assert.throws(
  () => assertBizInfoApiResponse({ jsonArray: [{ pblancNm: "missing id" }] }, "program"),
  /missing pblancId/,
);

assert.throws(
  () => assertBizInfoApiResponse({ jsonArray: [{ nttNm: "missing id" }] }, "event"),
  /missing eventInfoId/,
);

console.log(JSON.stringify({ ok: true, checked: ["program", "event"] }, null, 2));
