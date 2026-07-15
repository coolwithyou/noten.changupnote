import assert from "node:assert/strict";
import { CRITERION_DIMENSIONS } from "@cunote/contracts";
import { buildKStartupExtractionInput } from "@cunote/core";
import {
  buildPilotToolSchema,
  extractGrantAnalysisPilotWithAnthropic,
  renderBalancedPilotInput,
} from "./grantAnalysisPilotExtractor";

const announcement = {
  pbanc_sn: "pilot-test",
  biz_pbanc_nm: "AI 소프트웨어 기업 지원",
  aply_trgt_ctnt: "AI·소프트웨어 분야 창업기업을 지원합니다.",
  aply_excl_trgt_ctnt: "휴·폐업 기업은 제외합니다.",
};
const input = buildKStartupExtractionInput(announcement, {
  attachmentMarkdowns: [{ filename: "공고문.pdf", markdown: "사업계획서를 제출합니다." }],
});
const activeDimensions = CRITERION_DIMENSIONS.filter(
  (dimension) => dimension !== "premises" && dimension !== "export_performance",
);
const axisAssessments = activeDimensions.map((dimension) => ({
  dimension,
  status: dimension === "industry" ? "condition_found" : "inspected_no_condition",
  confidence: 0.9,
  evidence_spans: dimension === "industry"
    ? ["AI·소프트웨어 분야 창업기업을 지원합니다."]
    : [],
  note: dimension === "industry" ? "산업 조건 확인" : "제공 입력에서 조건 없음",
}));

let sentToolName: string | undefined;
const result = await extractGrantAnalysisPilotWithAnthropic({
  source: "kstartup",
  payload: announcement,
  input,
  apiKey: "test",
  fetchImpl: async (_url, init) => {
    const sentBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sentToolName = (sentBody.tool_choice as { name?: string } | undefined)?.name;
    return new Response(JSON.stringify({
      content: [{
        type: "tool_use",
        name: "emit_grant_analysis_pilot",
        input: {
          criteria: [{
            dimension: "industry",
            operator: "in",
            kind: "required",
            value: { tags: ["AI", "소프트웨어"] },
            confidence: 0.9,
            source_span: "AI·소프트웨어 분야 창업기업을 지원합니다.",
          }],
          required_documents: [{
            name: "사업계획서",
            required: true,
            source: "self",
            source_span: "사업계획서를 제출합니다.",
          }],
          axis_assessments: axisAssessments,
        },
      }],
      usage: { input_tokens: 321, output_tokens: 123 },
    }), { status: 200 });
  },
});

assert.equal(result.axes.length, 20);
assert.equal(result.axes.map((axis) => String(axis.dimension)).includes("premises"), false);
assert.equal(result.axes.find((axis) => axis.dimension === "industry")?.effectiveStatus, "condition_found");
assert.ok(result.criteria.some((criterion) => criterion.dimension === "industry"));
assert.deepEqual(result.requiredDocuments.map((document) => document.name), ["사업계획서"]);
assert.equal(result.prompt.attachmentCharactersIncluded, "사업계획서를 제출합니다.".length);
assert.equal(result.prompt.inputSha256.length, 64);
assert.equal(sentToolName, "emit_grant_analysis_pilot");

const schema = buildPilotToolSchema();
const axisSchema = schema.input_schema.properties.axis_assessments as { minItems?: number; maxItems?: number };
assert.equal(axisSchema.minItems, 20);
assert.equal(axisSchema.maxItems, 20);

const balanced = renderBalancedPilotInput(input, { maxApiChars: 4, maxAttachmentChars: 5 });
assert.equal(balanced.metrics.apiCharactersIncluded, 4);
assert.equal(balanced.metrics.attachmentCharactersIncluded, 5);
assert.ok(balanced.metrics.truncatedBlockCount > 0);

const repaired = await extractGrantAnalysisPilotWithAnthropic({
  source: "kstartup",
  payload: announcement,
  input,
  apiKey: "test",
  fetchImpl: async () => new Response(JSON.stringify({
    content: [{
      type: "tool_use",
      name: "emit_grant_analysis_pilot",
      input: {
        criteria: [{
          dimension: "target_type",
          operator: "in",
          kind: "required",
          value: { targets: [] },
          confidence: 0.8,
          source_span: "AI·소프트웨어 분야 창업기업을 지원합니다.",
        }],
        required_documents: [],
        axis_assessments: activeDimensions.map((dimension) => ({
          dimension,
          status: dimension === "target_type" ? "condition_found" : "inspected_no_condition",
          confidence: 0.8,
          evidence_spans: [],
          note: "test",
        })),
      },
    }],
    usage: { output_tokens: 100 },
  }), { status: 200 }),
});
assert.equal(repaired.normalizationRepairs[0]?.action, "downgrade_to_text_only");
assert.ok(repaired.criteria.some((criterion) =>
  criterion.dimension === "other" && criterion.operator === "text_only"));
assert.equal(
  repaired.axes.find((axis) => axis.dimension === "target_type")?.effectiveStatus,
  "ambiguous",
);

console.log("grantAnalysisPilotExtractor.test.ts: all assertions passed");
