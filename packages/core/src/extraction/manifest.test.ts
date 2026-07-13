import assert from "node:assert/strict";
import type { Grant, GrantCriterion, NormalizedGrant } from "@cunote/contracts";
import { buildGrantExtractionManifest } from "./manifest.js";

const criterion: GrantCriterion = {
  dimension: "region",
  operator: "in",
  kind: "required",
  confidence: 0.9,
  source_field: "supt_regin",
  source_span: "경기도 소재 기업",
  value: { regions: ["41"] },
};

const structured = normalized([criterion]);
const structuredManifest = buildGrantExtractionManifest(structured);
assert.equal(structuredManifest.readiness, "structured_unreviewed");
assert.deepEqual(structuredManifest.warnings, []);
assert.equal(structuredManifest.attachmentsExpected, 0);

const noCriteria = buildGrantExtractionManifest(normalized([]));
assert.equal(noCriteria.readiness, "unstructured");
assert.deepEqual(noCriteria.warnings, ["criteria_missing"]);

const missingEvidence = buildGrantExtractionManifest(normalized([{
  dimension: "region",
  operator: "in",
  kind: "required",
  confidence: 0.9,
  value: { regions: ["41"] },
}]));
assert.equal(missingEvidence.readiness, "partial");
assert.ok(missingEvidence.warnings.includes("hard_criterion_evidence_missing"));

const textOnly = buildGrantExtractionManifest(normalized([{
  dimension: "other",
  operator: "text_only",
  kind: "required",
  confidence: 0.5,
  source_span: "추가 자격은 공고문 참조",
  value: { note: "원문 확인" },
}]));
assert.equal(textOnly.readiness, "partial");
assert.ok(textOnly.warnings.includes("text_only_criterion_present"));

const attachmentPending = buildGrantExtractionManifest(normalized([criterion], [{
  filename: "공고문.hwp",
  url: "https://example.com/notice.hwp",
}]));
assert.equal(attachmentPending.readiness, "partial");
assert.ok(attachmentPending.warnings.includes("attachment_fetch_incomplete"));

const attachmentConverted = buildGrantExtractionManifest(normalized([criterion], [{
  filename: "공고문.hwp",
  archive_url: "https://archive.example/notice.hwp",
  sha256: "abc",
  conversion: { status: "converted", markdown_storage_key: "notice.md" },
}]));
assert.equal(attachmentConverted.readiness, "structured_unreviewed");
assert.equal(attachmentConverted.attachmentsFetched, 1);
assert.equal(attachmentConverted.attachmentsConverted, 1);

const attachmentSkipped = buildGrantExtractionManifest(normalized([criterion], [{
  filename: "안내이미지.png",
  archive_url: "https://archive.example/notice.png",
  sha256: "skip",
  conversion: { status: "skipped" },
}]));
assert.equal(attachmentSkipped.readiness, "structured_unreviewed");
assert.equal(attachmentSkipped.attachmentsFetched, 1);
assert.equal(attachmentSkipped.attachmentsConverted, 0);
assert.deepEqual(attachmentSkipped.warnings, []);

const reviewed = buildGrantExtractionManifest(structured, { reviewedAt: "2026-07-12T00:00:00.000Z" });
assert.equal(reviewed.readiness, "reviewed");

const missingInput = buildGrantExtractionManifest(structured, {
  sourceFieldsExpected: ["supt_regin", "aply_trgt_ctnt"],
  sourceFieldsSeen: ["supt_regin"],
  sectionsExpected: ["required", "exclusion"],
  sectionsDetected: ["required"],
});
assert.ok(missingInput.warnings.includes("source_field_missing"));
assert.ok(missingInput.warnings.includes("source_section_missing"));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "structured_unreviewed",
    "unstructured_no_criteria",
    "hard_criterion_evidence",
    "text_only_criterion",
    "attachment_fetch_incomplete",
    "attachment_converted",
    "attachment_skipped_terminal",
    "reviewed_manifest",
    "expected_input_completeness",
  ],
}, null, 2));

function normalized(
  criteria: GrantCriterion[],
  attachments?: NonNullable<NormalizedGrant["raw"]["attachments"]>,
): NormalizedGrant<Record<string, unknown>> {
  const grant: Grant = {
    source: "kstartup",
    source_id: "manifest-test",
    title: "manifest-test",
    status: "open",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0.9,
    parser_version: "test-parser",
  };
  return {
    raw: {
      source: "kstartup",
      source_id: "manifest-test",
      payload: { supt_regin: "경기" },
      ...(attachments ? { attachments } : {}),
      collected_at: "2026-07-12T00:00:00.000Z",
      status: "normalized",
    },
    grant,
    criteria,
  };
}
