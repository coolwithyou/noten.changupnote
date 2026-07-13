import assert from "node:assert/strict";
import { buildBizInfoProgramExtractionInput } from "./extraction-input.js";
import { buildBizInfoDeterministicCriteria, mergeBizInfoDeterministicCriteria } from "./deterministic-criteria.js";
import { extractBizInfoCriteriaWithAnthropic } from "./llm-criteria.js";

const input = buildBizInfoProgramExtractionInput({
  pblancId: "PBLN_TEST",
  pblancNm: "[서울ㆍ경기ㆍ인천ㆍ강원] AI 훈련 참여기업 모집",
  trgetNm: "중소기업",
  bsnsSumryCn: "미국 진출이 준비된 IP 창ㆍ제작 및 IP기반 엔터테인먼트 법인사업자 대상",
});
const criteria = buildBizInfoDeterministicCriteria(input);

assert.deepEqual(criteria.map((criterion) => criterion.dimension), ["size", "region", "target_type"]);
assert.deepEqual(criteria[0]?.value, { sizes: ["중소기업"] });
assert.deepEqual(criteria[1]?.value, {
  regions: ["11", "41", "28", "42"],
  labels: ["서울", "경기", "인천", "강원"],
  nationwide: false,
});
assert.deepEqual(criteria[2]?.value, { targets: ["법인사업자"] });
assert.match(criteria[2]?.source_span ?? "", /법인사업자/);

const merged = mergeBizInfoDeterministicCriteria(criteria, [{
  ...criteria[0]!,
  id: "llm-duplicate",
  confidence: 0.7,
}, {
  id: "llm-industry",
  grant_id: "PBLN_TEST",
  dimension: "industry",
  operator: "in",
  kind: "required",
  value: { industries: ["콘텐츠"] },
  confidence: 0.8,
  source_span: "콘텐츠 기업",
}]);
assert.equal(merged.filter((criterion) => criterion.dimension === "size").length, 1);
assert.equal(merged.some((criterion) => criterion.dimension === "industry"), true);

const emptyLlmResult = await extractBizInfoCriteriaWithAnthropic({
  input,
  apiKey: "test-key",
  fetchImpl: async () => new Response(JSON.stringify({
    content: [{
      type: "tool_use",
      name: "emit_grant_criteria",
      input: { criteria: [], required_documents: [] },
    }],
  }), { status: 200, headers: { "content-type": "application/json" } }),
});
assert.deepEqual(
  emptyLlmResult.criteria.map((criterion) => criterion.dimension),
  ["size", "region", "target_type"],
  "LLM이 0건을 반환해도 structured field backstop은 유지된다",
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "structured_size_backstop",
    "title_region_backstop",
    "business_type_backstop",
    "deterministic_llm_dedup",
    "empty_llm_backstop",
  ],
}, null, 2));
