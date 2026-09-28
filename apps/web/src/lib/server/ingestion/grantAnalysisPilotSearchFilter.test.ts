import assert from "node:assert/strict";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import { buildKStartupExtractionInput } from "@cunote/core";
import { extractGrantAnalysisPilotWithAnthropic } from "./grantAnalysisPilotExtractor";

const searchOnly = {
  pbanc_sn: "search-only",
  biz_pbanc_nm: "공고",
  biz_enyy: "3년미만",
  biz_trgt_age: "만 39세 이하",
  supt_regin: "서울",
};
const input = buildKStartupExtractionInput(searchOnly);
const result = await extractGrantAnalysisPilotWithAnthropic({
  source: "kstartup",
  payload: searchOnly,
  input,
  apiKey: "test",
  fetchImpl: async () => new Response(JSON.stringify({
    content: [{
      type: "tool_use",
      name: "emit_grant_analysis_pilot",
      input: {
        criteria: [],
        required_documents: [],
        axis_assessments: CRITERION_DIMENSIONS
          .filter((dimension) => dimension !== "premises" && dimension !== "export_performance")
          .map((dimension) => ({
            dimension,
            status: "inspected_no_condition",
            confidence: 0.9,
            evidence_spans: [],
            note: "원문 조건 없음",
          })),
      },
    }],
  }), { status: 200 }),
});
assert.deepEqual(result.criteria, [], "파일럿 경로도 검색 필터에서 조건을 재주입하지 않는다");
assert.equal(result.axes.some((axis) => axis.effectiveStatus === "condition_found"), false);
assert.doesNotMatch(input.text, /3년미만|만 39세 이하|source_field: supt_regin/);

console.log("grantAnalysisPilotSearchFilter.test.ts: all assertions passed");
