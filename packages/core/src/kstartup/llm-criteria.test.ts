import assert from "node:assert/strict";
import { LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION } from "../bizinfo/llm-criteria.js";
import { extractKStartupCriteriaWithAnthropic, mergeKStartupLlmCriteria } from "./llm-criteria.js";

const announcement = {
  pbanc_sn: "llm-test",
  biz_pbanc_nm: "AI 소프트웨어 창업기업 지원",
  aply_trgt_ctnt: "AI·소프트웨어 분야 창업기업을 지원합니다.",
  aply_excl_trgt_ctnt: "휴·폐업 기업은 제외합니다.",
  detail: {
    parser_version: "test",
    fetched_at: "2026-07-12T00:00:00.000Z",
    apply_method_text: "온라인 신청",
    submit_documents_text: "사업계획서를 제출합니다.",
    attachments: [],
  },
};

const result = await extractKStartupCriteriaWithAnthropic({
  announcement,
  apiKey: "test",
  fetchImpl: async () => new Response(JSON.stringify({
    content: [{
      type: "tool_use",
      name: "emit_grant_criteria",
      input: {
        criteria: [{
          dimension: "industry",
          operator: "in",
          kind: "required",
          value: { labels: ["AI", "소프트웨어"] },
          confidence: 0.9,
          source_span: "AI·소프트웨어 분야 창업기업을 지원합니다.",
        }, {
          dimension: "revenue",
          operator: "gte",
          kind: "required",
          value: { min_krw: 100_000_000 },
          confidence: 0.9,
          source_span: "매출 1억원 이상",
        }],
        required_documents: [{
          name: "사업계획서",
          required: true,
          source: "self",
          source_span: "사업계획서를 제출합니다.",
        }, {
          name: "허구서류",
          required: true,
          source: "self",
          source_span: "허구서류를 제출합니다.",
        }],
      },
    }],
    usage: { input_tokens: 100 },
  }), { status: 200 }),
});

const industry = result.criteria.find((criterion) => criterion.dimension === "industry" && criterion.operator === "in");
assert.equal(result.normalizerContractVersion, LLM_CRITERIA_NORMALIZATION_CONTRACT_VERSION);
assert.ok(industry);
assert.equal(industry.needs_review, true);
assert.equal(industry.source_field, "aply_trgt_ctnt");
assert.deepEqual((industry.value as { tags?: string[] }).tags, ["AI", "소프트웨어"]);
assert.equal(result.criteria.some((criterion) => criterion.dimension === "industry" && criterion.operator === "text_only"), false);
assert.ok(result.criteria.some((criterion) =>
  criterion.dimension === "other" && criterion.source_field === "llm_evidence_unverified"));
assert.deepEqual(result.requiredDocuments.map((document) => document.name), ["사업계획서"]);

const deterministicWinsSameSpan = mergeKStartupLlmCriteria([{
  dimension: "industry",
  operator: "in",
  kind: "required",
  value: { tags: ["소프트웨어"] },
  confidence: 0.8,
  source_span: "소프트웨어 기업",
}], [{
  dimension: "industry",
  operator: "in",
  kind: "required",
  value: { tags: ["SW"] },
  confidence: 0.7,
  source_span: "소프트웨어 기업",
  needs_review: true,
}]);
assert.equal(deterministicWinsSameSpan.length, 1);
assert.deepEqual(deterministicWinsSameSpan[0]?.value, { tags: ["소프트웨어"] });

const searchOnly = {
  pbanc_sn: "search-only",
  biz_pbanc_nm: "공고",
  biz_enyy: "3년미만",
  biz_trgt_age: "만 39세 이하",
  supt_regin: "서울",
};
const responseFor = (criteria: unknown[]) => async () => new Response(JSON.stringify({
  content: [{ type: "tool_use", name: "emit_grant_criteria", input: { criteria, required_documents: [] } }],
}), { status: 200 });
const searchOnlyResult = await extractKStartupCriteriaWithAnthropic({
  announcement: searchOnly,
  apiKey: "test",
  fetchImpl: responseFor([]),
});
assert.equal(searchOnlyResult.criteria.length, 0, "검색 필터만 있는 공고에서 확정 조건을 주입하지 않는다");
assert.doesNotMatch(searchOnlyResult.input.text, /3년미만|만 39세 이하|source_field: supt_regin/);

const explicitAge = await extractKStartupCriteriaWithAnthropic({
  announcement: { ...searchOnly, aply_trgt_ctnt: "공고일 기준 창업 3년 이내, 서울 소재 기업" },
  apiKey: "test",
  fetchImpl: responseFor([{
    dimension: "biz_age",
    operator: "lte",
    kind: "required",
    value: { max_months: 36 },
    confidence: 0.9,
    source_span: "창업 3년 이내",
  }, {
    dimension: "region",
    operator: "in",
    kind: "required",
    value: { regions: ["11"] },
    confidence: 0.9,
    source_span: "서울 소재 기업",
  }]),
});
assert.ok(explicitAge.criteria.some((criterion) =>
  criterion.dimension === "biz_age" && criterion.source_field === "aply_trgt_ctnt"));
assert.ok(explicitAge.criteria.some((criterion) =>
  criterion.dimension === "region" && criterion.source_field === "aply_trgt_ctnt"));
assert.equal(explicitAge.criteria.some((criterion) => criterion.source_field === "biz_enyy"), false);

const authoredWithoutField = mergeKStartupLlmCriteria([{
  dimension: "region", operator: "in", kind: "required", value: { regions: ["11"] }, confidence: 0.8,
}], []);
assert.equal(authoredWithoutField.length, 1, "출처 필드가 없는 기존 조건은 이 좁은 경계에서 제거하지 않는다");

console.log("kstartup/llm-criteria.test.ts: all assertions passed");
