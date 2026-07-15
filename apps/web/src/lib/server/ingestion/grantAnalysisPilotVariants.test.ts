import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import {
  buildCurrentAxisAssessments,
  buildExtractedAxisAssessments,
  buildGrantAnalysisInputArtifacts,
} from "./grantAnalysisPilotVariants";

const entry = {
  raw: {
    source: "kstartup",
    source_id: "1",
    payload: { pbanc_sn: "1" },
    status: "normalized",
    raw_hash: "revision",
    attachments: [{
      filename: "공고.pdf",
      storage_key: "raw/notice.pdf",
      sha256: "raw-sha",
      conversion: {
        status: "converted",
        markdown_storage_key: "markdown/notice.md",
      },
    }, {
      filename: "실패.hwp",
      storage_key: "raw/fail.hwp",
      sha256: "fail-sha",
      conversion: { status: "failed", error: "parse failed" },
    }],
  },
  grant: {
    id: "kstartup:1",
    source: "kstartup",
    source_id: "1",
    title: "테스트",
    url: null,
    apply_start: null,
    apply_end: null,
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.5,
  },
  criteria: [],
} satisfies NormalizedGrant<unknown>;

const inputs = {
  source: "kstartup",
  sourceId: "1",
  sourceRevision: "revision",
  attachments: {
    counts: { expected: 3 },
    includedAttachments: [{ filename: "공고.pdf", characterCount: 100 }],
  },
} as never;
const A = buildGrantAnalysisInputArtifacts({ entry, inputs, variant: "A" });
const B = buildGrantAnalysisInputArtifacts({ entry, inputs, variant: "B" });
const C = buildGrantAnalysisInputArtifacts({ entry, inputs, variant: "C" });
assert.equal(A.length, 4);
assert.equal(B.find((artifact) => artifact.inputId.includes("공고.pdf"))?.included, false);
assert.equal(C.find((artifact) => artifact.inputId.includes("공고.pdf"))?.included, true);
assert.equal(C.find((artifact) => artifact.inputId.includes("실패.hwp"))?.failure, "parse failed");
assert.equal(C.at(-1)?.failure, "Expected attachment is absent from the archived input inventory.");

const current = buildCurrentAxisAssessments([{
  dimension: "industry",
  operator: "in",
  kind: "required",
  value: { tags: ["AI"] },
  confidence: 0.9,
  source_span: "AI 기업",
}]);
assert.equal(current.length, 22);
assert.equal(current.find((axis) => axis.dimension === "industry")?.state, "structured");
assert.equal(current.find((axis) => axis.dimension === "revenue")?.state, "not_inspected");
assert.equal(current.find((axis) => axis.dimension === "premises")?.state, "reserved");

const extracted = buildExtractedAxisAssessments([], [{
  dimension: "revenue",
  modelStatus: "inspected_no_condition",
  effectiveStatus: "inspected_no_condition",
  confidence: 0.9,
  evidenceSpans: [],
  note: "검사 완료",
  issues: [],
}]);
assert.equal(extracted.find((axis) => axis.dimension === "revenue")?.state, "explicit_no_condition");
assert.equal(extracted.find((axis) => axis.dimension === "industry")?.state, "not_inspected");

const incomplete = buildExtractedAxisAssessments([], [{
  dimension: "revenue",
  modelStatus: "inspected_no_condition",
  effectiveStatus: "inspected_no_condition",
  confidence: 0.9,
  evidenceSpans: [],
  note: "API 입력에서 조건 없음",
  issues: [],
}], { inputInspectionComplete: false, missingInputCount: 2 });
assert.equal(incomplete.find((axis) => axis.dimension === "revenue")?.state, "not_inspected");
assert.match(incomplete.find((axis) => axis.dimension === "revenue")?.note ?? "", /입력 2개가 미포함/);

console.log("grantAnalysisPilotVariants.test.ts: all assertions passed");
