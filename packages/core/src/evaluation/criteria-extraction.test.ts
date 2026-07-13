import assert from "node:assert/strict";
import type { GrantCriterion } from "@cunote/contracts";
import { evaluateCriterionExtraction } from "./criteria-extraction.js";
import { parseV3AnnotationJsonl, type V3GrantAnnotation } from "./v3-annotations.js";
import { buildMatchingV3GrantReviewTask } from "./review-packet.js";

const reviewedGrant: V3GrantAnnotation = {
  recordType: "grant",
  schemaVersion: "matching-v3",
  grantId: "bizinfo:g1",
  source: "bizinfo",
  sourceId: "g1",
  title: "검수 공고",
  audience: "company",
  labelStatus: "reviewed",
  annotatorId: "annotator@example.com",
  annotatedAt: "2026-07-11T00:00:00.000Z",
  reviewerId: "reviewer@example.com",
  reviewedAt: "2026-07-12T00:00:00.000Z",
  sourceFixture: "archive:g1:r1",
  sourceRevision: "r1",
  criteria: [
    criterion("region", "required", "in", { regions: ["41"] }, "경기도 소재 기업"),
    criterion("tax_compliance", "exclusion", "in", { flags: ["national_tax_delinquent"] }, "국세 체납기업 제외"),
    criterion("certification", "required", "in", { certs: ["벤처기업"] }, "벤처기업 확인서 보유"),
    criterion("industry", "preferred", "in", { industries: ["ICT"] }, "ICT 기업 우대"),
  ],
};

const predictions: GrantCriterion[] = [
  {
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { regions: ["41"] },
    confidence: 0.9,
    source_span: "경기도 소재 기업",
  },
  {
    dimension: "other",
    kind: "exclusion",
    operator: "text_only",
    value: { note: "원문 확인" },
    confidence: 0.5,
    source_span: "국세 체납기업 제외",
  },
  {
    dimension: "industry",
    kind: "preferred",
    operator: "in",
    value: { industries: ["ICT"] },
    confidence: 0.8,
    source_span: "ICT 기업 우대",
  },
  {
    dimension: "size",
    kind: "required",
    operator: "in",
    value: { sizes: ["중소기업"] },
    confidence: 0.8,
    source_span: "중소기업 대상",
  },
];

const report = evaluateCriterionExtraction([reviewedGrant], [{ grantId: "bizinfo:g1", criteria: predictions }]);
assert.equal(report.operationalReady, true);
assert.equal(report.evaluatedGrantCount, 1);
assert.deepEqual(report.overall, {
  expected: 4,
  structuredRecovered: 2,
  textOnlyPreserved: 1,
  recovered: 3,
  missing: 1,
  recall: 0.75,
  structuredRecall: 0.5,
});
assert.equal(report.byKind.required?.recall, 0.5);
assert.equal(report.byKind.exclusion?.recall, 1);
assert.equal(report.unmatchedPredictedCount, 1);
assert.equal(report.missing[0]?.dimension, "certification");

const noReviewed = evaluateCriterionExtraction([{ ...reviewedGrant, labelStatus: "draft" }], []);
assert.equal(noReviewed.operationalReady, false);
assert.equal(noReviewed.overall.recall, null);

const jsonl = [
  JSON.stringify(reviewedGrant),
  JSON.stringify({
    recordType: "company",
    schemaVersion: "matching-v3",
    labelStatus: "draft",
    companyId: "company-1",
    businessKind: "corporation",
    profile: { size: "중소기업" },
    sourceFixture: "synthetic",
  }),
].join("\n");
const dataset = parseV3AnnotationJsonl(jsonl, "synthetic.jsonl");
assert.equal(dataset.grants.length, 1);
assert.equal(dataset.companies.length, 1);
assert.equal(dataset.grants[0]?.criteria[3]?.kind, "preferred");
assert.throws(
  () => parseV3AnnotationJsonl(`${jsonl}\n${JSON.stringify(reviewedGrant)}`, "duplicate.jsonl"),
  /duplicate grantId/,
);
assert.throws(
  () => parseV3AnnotationJsonl(JSON.stringify({ ...reviewedGrant, reviewerId: reviewedGrant.annotatorId }), "same-reviewer.jsonl"),
  /independent reviewer/,
);
assert.throws(
  () => parseV3AnnotationJsonl(JSON.stringify({ ...reviewedGrant, sourceRevision: null }), "revision.jsonl"),
  /sourceRevision/,
);

const reviewTask = buildMatchingV3GrantReviewTask({
  raw: {
    source: "bizinfo",
    source_id: "g1",
    payload: {
      pblancNm: "검수 공고",
      trgetNm: "중소기업",
      bsnsSumryCn: `<p>${"가".repeat(4_100)}</p>`,
      pblancUrl: "https://secret.example/raw-url",
    },
    attachments: [{
      filename: "공고문.hwp",
      archive_url: "https://archive.example/private",
      sha256: "abc",
      conversion: { status: "converted" },
    }],
    status: "published",
  },
  grant: {
    source: "bizinfo",
    source_id: "g1",
    title: "검수 공고",
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.8,
  },
  criteria: predictions,
});
assert.equal(reviewTask.annotationTemplate.labelStatus, "draft");
assert.equal(reviewTask.attachments[0]?.conversionStatus, "converted");
assert.equal("pblancUrl" in reviewTask.sourceFields, false, "raw URL is not copied to review packet");
assert.ok((reviewTask.sourceFields.bsnsSumryCn as string).length <= 4_000);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "reviewed_only_gate",
    "structured_recall",
    "text_only_preservation_recall",
    "missing_criterion",
    "unmatched_prediction",
    "source_dimension_kind_stratification",
    "jsonl_parser",
    "duplicate_record_guard",
    "review_packet_redaction",
    "review_packet_annotation_template",
  ],
}, null, 2));

function criterion(
  dimension: V3GrantAnnotation["criteria"][number]["dimension"],
  kind: V3GrantAnnotation["criteria"][number]["kind"],
  operator: V3GrantAnnotation["criteria"][number]["operator"],
  value: unknown,
  sourceSpan: string,
): V3GrantAnnotation["criteria"][number] {
  return {
    criterionId: `${dimension}:${kind}`,
    dimension,
    kind,
    operator,
    value,
    sourceSpan,
    sourceField: null,
    annotationConfidence: 0.9,
    note: null,
  };
}
