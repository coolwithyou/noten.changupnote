import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertBizInfoApiResponse,
  buildBizInfoProgramExtractionInput,
  buildBizInfoUrl,
  htmlToText,
  matchGrantCriteria,
  normalizeBizInfoUrl,
  normalizeBizInfoLlmCriteria,
  normalizeBizInfoProgram,
} from "../src/index.js";

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

const cleaned = htmlToText("<p>전남도 소재 <b>중소기업</b></p><ul><li>로봇 제조</li></ul>");
assert.match(cleaned, /전남도 소재 중소기업/);
assert.match(cleaned, /로봇 제조/);
assert.equal(htmlToText("<style>.Section { width: 210mm; }</style><p>본문</p>"), "본문");
assert.equal(
  normalizeBizInfoUrl("/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_1"),
  "https://www.bizinfo.go.kr/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_1",
);

const sampleAttachment = readFileSync("samples/bizinfo_hwp_converted.md", "utf8");
const extractionInput = buildBizInfoProgramExtractionInput({
  pblancId: "PBLN_SAMPLE",
  pblancNm: "2026년도 SaaS 전환ㆍ개발 컨설팅 2차 수요기업 모집",
  trgetNm: "중소기업",
  jrsdInsttNm: "과학기술정보통신부",
  excInsttNm: "정보통신산업진흥원",
  pldirSportRealmLclasCodeNm: "기술",
  pldirSportRealmMlsfcCodeNm: "컨설팅",
  reqstBeginEndDe: "2026-06-23 ~ 2026-07-20",
  reqstMthPapersCn: "이메일 접수",
  bsnsSumryCn: "<p>기존 구축형 AI SW서비스를 SaaS로 전환 및 개발하고자 하는 기업</p>",
  hashtags: "SaaS,AI,SW",
  fileNm: "모집공고.hwp",
  flpthNm: "/file/download.do?id=sample",
  pblancUrl: "/sii/siia/selectSIIA200Detail.do?pblancId=PBLN_SAMPLE",
}, {
  attachmentMarkdowns: [{ filename: "bizinfo_hwp_converted.md", markdown: sampleAttachment }],
});

assert.equal(extractionInput.source, "bizinfo");
assert.equal(extractionInput.metadata.hashtags.length, 3);
assert.equal(extractionInput.metadata.attachments[0]?.filename, "모집공고.hwp");
assert.ok(extractionInput.blocks.some((block) => block.source === "attachment_markdown"));
assert.match(extractionInput.text, /source_field: bsnsSumryCn/);
assert.match(extractionInput.text, /모집대상/);
assert.match(extractionInput.text, /재무제표/);

const llmCriteria = normalizeBizInfoLlmCriteria({
  criteria: [{
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["41"], labels: ["경기"], nationwide: false },
    confidence: 0.9,
    source_span: "경기도 소재 중소기업",
  }, {
    dimension: "business_status",
    operator: "not_in",
    kind: "exclusion",
    value: { statuses: ["closed"], labels: ["휴폐업"] },
    confidence: 0.85,
    source_span: "휴폐업 중인 기업 제외",
  }],
}, "PBLN_SAMPLE");
assert.equal(llmCriteria.length, 2);
const normalizedBizinfo = normalizeBizInfoProgram({
  pblancId: "PBLN_SAMPLE",
  pblancNm: "기업마당 테스트 공고",
  reqstBeginEndDe: "2026-06-01 ~ 2026-06-30",
}, llmCriteria, {
  asOf: new Date("2026-06-26T00:00:00.000Z"),
  model: "test-model",
});
assert.equal(normalizedBizinfo.grant.status, "open");
assert.deepEqual(normalizedBizinfo.grant.f_regions, ["41"]);
const bizinfoMatch = matchGrantCriteria(llmCriteria, {
  region: { code: "41", label: "경기" },
  business_status: { active: true, close_down_state: 1, close_down_tax_type: 10 },
});
assert.equal(bizinfoMatch.eligibility, "eligible");

console.log(JSON.stringify({
  ok: true,
  checked: ["program", "event", "extraction_input", "llm_criteria"],
  extraction_input_length: extractionInput.text.length,
}, null, 2));
