import assert from "node:assert/strict";
import { buildKStartupExtractionInput } from "./extraction-input.js";

const input = buildKStartupExtractionInput({
  pbanc_sn: 123,
  biz_pbanc_nm: "AI 창업기업 지원",
  aply_trgt: "창업기업",
  aply_trgt_ctnt: "AI·소프트웨어 분야 창업기업",
  aply_excl_trgt_ctnt: "휴·폐업 기업 제외",
  prfn_matr: "수출기업 우대",
  supt_regin: "전국",
  supt_biz_clsfc: "사업화",
  detail: {
    parser_version: "test",
    fetched_at: "2026-07-12T00:00:00.000Z",
    apply_method_text: "온라인 신청",
    submit_documents_text: "사업계획서 제출",
    attachments: [],
  },
}, {
  attachmentMarkdowns: [{ filename: "공고문.pdf", markdown: "업력 7년 이내 기업" }],
});

assert.equal(input.source_id, "123");
assert.equal(input.category, "사업화");
assert.ok(input.blocks.some((block) => block.source_field === "aply_trgt_ctnt"));
assert.ok(input.blocks.some((block) => block.source_field === "aply_excl_trgt_ctnt"));
assert.ok(input.blocks.some((block) => block.source_field === "detail.submit_documents_text"));
assert.ok(input.blocks.some((block) => block.filename === "공고문.pdf"));
assert.match(input.text, /source_field: aply_trgt_ctnt/);
assert.match(input.text, /filename: 공고문\.pdf/);
assert.doesNotMatch(input.text, /source_field: supt_regin/);

const filterOnly = {
  pbanc_sn: "search-filter-only",
  biz_pbanc_nm: "공고",
  biz_enyy: "3년미만",
  biz_trgt_age: "만 39세 이하",
  supt_regin: "전국",
};
const original = structuredClone(filterOnly);
const fromFilters = buildKStartupExtractionInput(filterOnly);
const withoutFilters = buildKStartupExtractionInput({ pbanc_sn: filterOnly.pbanc_sn, biz_pbanc_nm: filterOnly.biz_pbanc_nm });
assert.deepEqual(filterOnly, original, "포털 원본 객체는 변경하지 않는다");
assert.equal(fromFilters.text, withoutFilters.text);
assert.equal(fromFilters.blocks.length, 1, "검색 필터만으로 자격 블록을 만들지 않는다");
assert.doesNotMatch(fromFilters.text, /3년미만|만 39세 이하|전국/);

const explicit = buildKStartupExtractionInput({
  ...filterOnly,
  aply_trgt_ctnt: "창업 7년 이내, 서울 소재 기업",
}, { attachmentMarkdowns: [{ filename: "공고문.hwp", markdown: "대표자 만 39세 이하" }] });
assert.match(explicit.text, /창업 7년 이내, 서울 소재 기업/);
assert.match(explicit.text, /대표자 만 39세 이하/);
assert.doesNotMatch(explicit.text, /source_field: supt_regin/);

console.log("kstartup/extraction-input.test.ts: all assertions passed");
