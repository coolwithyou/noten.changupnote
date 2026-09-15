import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assertBizInfoApiResponse,
  buildBizInfoCriteriaToolSchema,
  buildBizInfoProgramExtractionInput,
  buildBizInfoUrl,
  htmlToText,
  matchGrantCriteria,
  normalizeBizInfoUrl,
  normalizeBizInfoLlmCriteria,
  normalizeBizInfoLlmRequiredDocuments,
  normalizeBizInfoProgram,
  validateGrantCriteriaContract,
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

const multiAttachmentInput = buildBizInfoProgramExtractionInput({
  pblancId: "PBLN_MULTI",
  pblancNm: "첨부 다건 공고",
  fileNm: "신청서.hwp@규정.zip",
  flpthNm: "/file/a@/file/b",
});
assert.deepEqual(
  multiAttachmentInput.metadata.attachments.map((attachment) => attachment.filename),
  ["신청서.hwp", "규정.zip"],
);
assert.deepEqual(
  multiAttachmentInput.metadata.attachments.map((attachment) => attachment.url),
  ["https://www.bizinfo.go.kr/file/a", "https://www.bizinfo.go.kr/file/b"],
);

const bodyPrintFixtures = [{
  pblancId: "PBLN_000000000126333",
  pblancNm: "경남특산물박람회 참가업체 모집",
  fileNm: "[붙임1] 2026 경남특산물박람회 참가신청서 및 개인정보동의서.hwpx@[붙임2] 2026 경남특산물박람회 참가규정.hwpx",
  flpthNm: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000772752&fileSn=0@https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000772752&fileSn=1",
  printFileNm: "[공고문] 2026년 경남특산물박람회 참가업체 모집 공고.hwpx",
  printFlpthNm: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000772751&fileSn=0",
}, {
  pblancId: "PBLN_000000000126408",
  pblancNm: "광명시 착한가격업소 모집",
  fileNm: "착한가격업소 지정 심사표.hwpx@착한가격업소 지정 신청서.hwpx",
  flpthNm: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000773104&fileSn=0@https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000773104&fileSn=1",
  printFileNm: "2026년 광명시 착한가격업소 모집 공고.pdf",
  printFlpthNm: "https://www.bizinfo.go.kr/cmm/fms/getImageFile.do?atchFileId=FILE_000000000773103&fileSn=0",
}];
for (const fixture of bodyPrintFixtures) {
  const collected = buildBizInfoProgramExtractionInput(fixture).metadata.attachments;
  assert.equal(collected.length, 3, `${fixture.pblancId} 일반 첨부 2개와 본문 1개를 합집합으로 보존`);
  assert.deepEqual(
    collected.slice(0, 2).map(({ filename, url }) => [filename, url]),
    fixture.fileNm.split("@").map((filename, index) => [filename, fixture.flpthNm.split("@")[index]]),
    `${fixture.pblancId} 일반 첨부 순서와 내부 filename-url 결속 보존`,
  );
  assert.deepEqual(
    collected[2],
    { filename: fixture.printFileNm, url: fixture.printFlpthNm },
    `${fixture.pblancId} 본문 filename-url 결속 보존`,
  );
}

const mismatchedAttachmentInput = buildBizInfoProgramExtractionInput({
  pblancId: "PBLN_MISMATCHED_ATTACHMENTS",
  pblancNm: "첨부 길이 차이",
  fileNm: "첫째.hwp@둘째.hwp@셋째.hwp",
  flpthNm: "/file/first@/file/second",
  printFileNm: "본문.hwp",
});
assert.deepEqual(mismatchedAttachmentInput.metadata.attachments, [
  { filename: "첫째.hwp", url: "https://www.bizinfo.go.kr/file/first" },
  { filename: "둘째.hwp", url: "https://www.bizinfo.go.kr/file/second" },
  { filename: "셋째.hwp", url: null },
  { filename: "본문.hwp", url: null },
]);
const sparseAttachmentUrls = buildBizInfoProgramExtractionInput({
  pblancId: "PBLN_SPARSE_ATTACHMENT_URLS",
  pblancNm: "첨부 중간 URL 누락",
  fileNm: "첫째.hwp@둘째.hwp@셋째.hwp",
  flpthNm: "/first@@/third",
});
assert.deepEqual(sparseAttachmentUrls.metadata.attachments, [
  { filename: "첫째.hwp", url: "https://www.bizinfo.go.kr/first" },
  { filename: "둘째.hwp", url: null },
  { filename: "셋째.hwp", url: "https://www.bizinfo.go.kr/third" },
], "중간 빈 URL slot을 보존해 다음 URL을 앞 filename에 당겨 붙이지 않음");
const orphanPrintUrlInput = buildBizInfoProgramExtractionInput({
  pblancId: "PBLN_ORPHAN_PRINT_URL",
  pblancNm: "본문 URL만 있는 공고",
  fileNm: "일반첨부.hwp",
  printFlpthNm: "/file/print-only",
});
assert.deepEqual(
  orphanPrintUrlInput.metadata.attachments,
  [{ filename: "일반첨부.hwp", url: null }],
  "본문 URL을 일반 첨부 filename에 교차 결속하지 않음",
);
const exactPairDedupInput = buildBizInfoProgramExtractionInput({
  pblancId: "PBLN_ATTACHMENT_DEDUP",
  pblancNm: "첨부 exact pair 중복",
  fileNm: "중복.hwp@동명.hwp",
  flpthNm: "/file/same@/file/regular",
  printFileNm: "중복.hwp@동명.hwp",
  printFlpthNm: "/file/same@/file/print",
});
assert.deepEqual(exactPairDedupInput.metadata.attachments, [
  { filename: "중복.hwp", url: "https://www.bizinfo.go.kr/file/same" },
  { filename: "동명.hwp", url: "https://www.bizinfo.go.kr/file/regular" },
  { filename: "동명.hwp", url: "https://www.bizinfo.go.kr/file/print" },
], "exact filename-url pair만 제거하고 같은 이름의 다른 URL은 보존");

const normalizedBodyPrint = normalizeBizInfoProgram(bodyPrintFixtures[0]!, [], {
  asOf: new Date("2026-09-15T00:00:00.000Z"),
});
assert.equal(normalizedBodyPrint.raw.attachments?.length, 3, "normalizer도 합집합 collector 결과를 사용");

const llmToolSchema = buildBizInfoCriteriaToolSchema().input_schema;
assert.deepEqual(llmToolSchema.required, ["criteria", "required_documents"]);

const llmPayload = {
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
  required_documents: [{
    name: "사업계획서",
    required: true,
    source: "self",
    source_span: "사업계획서 제출",
  }, {
    name: "출처 없는 서류",
    required: true,
    source: "self",
  }],
};
const llmCriteria = normalizeBizInfoLlmCriteria(llmPayload, "PBLN_SAMPLE");
assert.equal(llmCriteria.length, 2);
assert.deepEqual(validateGrantCriteriaContract(llmCriteria), []);
const llmRequiredDocuments = normalizeBizInfoLlmRequiredDocuments(llmPayload);
assert.deepEqual(llmRequiredDocuments.map((document) => document.name), ["사업계획서"]);
assert.deepEqual(normalizeBizInfoLlmRequiredDocuments({ criteria: [], required_documents: [] }), []);
const firstLlmCriterion = llmCriteria[0];
assert.ok(firstLlmCriterion);
const invalidCriteria = validateGrantCriteriaContract([{
  ...firstLlmCriterion,
  confidence: 2,
  extra_field: true,
}]);
assert.equal(invalidCriteria.some((issue) => issue.path === "$[0].confidence"), true);
assert.equal(invalidCriteria.some((issue) => issue.path === "$[0].extra_field"), true);
const normalizedBizinfo = normalizeBizInfoProgram({
  pblancId: "PBLN_SAMPLE",
  pblancNm: "기업마당 테스트 공고",
  reqstBeginEndDe: "2026-06-01 ~ 2026-06-30",
  reqstMthPapersCn: "신청자료: ① 수요기업 신청서, ② 사업자등록증, ③ 재무제표(최근 3개년)",
}, llmCriteria, {
  asOf: new Date("2026-06-26T00:00:00.000Z"),
  model: "test-model",
  requiredDocuments: llmRequiredDocuments,
});
assert.equal(normalizedBizinfo.grant.status, "open");
assert.deepEqual(normalizedBizinfo.grant.f_regions, ["41"]);
assert.deepEqual(
  normalizedBizinfo.grant.required_documents?.map((document) => document.name),
  ["신청서", "사업자등록증", "재무제표", "사업계획서"],
);
const bizinfoMatch = matchGrantCriteria(llmCriteria, {
  region: { code: "41", label: "경기" },
  business_status: { active: true, close_down_state: 1, close_down_tax_type: 10 },
});
assert.equal(bizinfoMatch.eligibility, "eligible");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "program",
    "event",
    "extraction_input",
    "attachment_union",
    "llm_tool_schema",
    "llm_criteria",
    "llm_required_documents",
    "criteria_contract",
    "required_documents",
  ],
  extraction_input_length: extractionInput.text.length,
}, null, 2));
