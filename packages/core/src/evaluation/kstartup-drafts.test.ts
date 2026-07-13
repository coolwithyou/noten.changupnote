import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import {
  buildBizInfoDraftReviewTask,
  buildKStartupDraftReviewTask,
  parseBizInfoCriteriaDraftJsonl,
  parseKStartupCriteriaDraftJsonl,
} from "./kstartup-drafts.js";
import { planReviewedGrantPublication } from "./reviewed-publication.js";
import type { V3GrantAnnotation } from "./v3-annotations.js";

const draftRecord = {
  recordType: "kstartup_criteria_draft",
  source: "kstartup",
  sourceId: "123",
  title: "소프트웨어 지원",
  extractorVersion: "kstartup-llm-criteria-v1",
  model: "test-model",
  inputSha256: "a".repeat(64),
  criteria: [{
    id: "kstartup:123:llm-1",
    grant_id: "123",
    dimension: "industry",
    operator: "in",
    kind: "required",
    value: { tags: ["소프트웨어"] },
    confidence: 0.8,
    source_span: "소프트웨어 기업",
    source_field: "aply_trgt_ctnt",
    needs_review: true,
    parser_version: "kstartup-llm-criteria-v1",
  }],
  requiredDocuments: [{
    name: "사업계획서",
    required: true,
    source: "self",
    source_span: "사업계획서를 제출합니다.",
  }],
  reviewStatus: "draft",
  operationalReady: false,
};
const parsed = parseKStartupCriteriaDraftJsonl(JSON.stringify(draftRecord));
assert.equal(parsed.drafts.length, 1);
assert.equal(parsed.errors.length, 0);

const current = normalized();
const task = buildKStartupDraftReviewTask(current, parsed.drafts[0]!);
assert.equal(task.predictedCriteria.length, 1);
assert.equal(task.predictionProvenance?.inputSha256, "a".repeat(64));
assert.equal(task.predictedRequiredDocuments?.[0]?.name, "사업계획서");
assert.equal(task.annotationTemplate.labelStatus, "draft");
assert.equal(task.annotationTemplate.sourceRevision, "raw-revision-1");

assert.throws(() => parseKStartupCriteriaDraftJsonl(JSON.stringify({ ...draftRecord, operationalReady: true })), /operationalReady/);
assert.throws(() => parseKStartupCriteriaDraftJsonl(JSON.stringify({
  ...draftRecord,
  criteria: [{ ...draftRecord.criteria[0], needs_review: false }],
})), /needs_review=true/);
assert.throws(() => parseKStartupCriteriaDraftJsonl(JSON.stringify({
  ...draftRecord,
  requiredDocuments: [{ name: "사업계획서", required: true, source: "self" }],
})), /source_span/);
assert.throws(() => parseKStartupCriteriaDraftJsonl(JSON.stringify({
  ...draftRecord,
  criteria: [{ ...draftRecord.criteria[0], grant_id: "different-grant" }],
})), /grant_id must match sourceId/);

const bizInfoDraftRecord = {
  ...draftRecord,
  recordType: "bizinfo_criteria_draft",
  source: "bizinfo",
  sourceId: "PBLN_TEST",
  title: "[서울] 중소기업 지원",
  extractorVersion: "bizinfo-llm-criteria-v3",
  criteria: [{
    ...draftRecord.criteria[0],
    id: "bizinfo:PBLN_TEST:llm-1",
    grant_id: "PBLN_TEST",
    parser_version: "bizinfo-llm-criteria-v3",
  }],
};
const parsedBizInfo = parseBizInfoCriteriaDraftJsonl(JSON.stringify(bizInfoDraftRecord));
assert.equal(parsedBizInfo.drafts.length, 1);
assert.equal(parsedBizInfo.errors.length, 0);
const bizInfoTask = buildBizInfoDraftReviewTask(normalizedBizInfo(), parsedBizInfo.drafts[0]!);
assert.equal(bizInfoTask.source, "bizinfo");
assert.equal(bizInfoTask.sourceFixture, `draft:bizinfo:PBLN_TEST:${"a".repeat(64)}`);
assert.equal(bizInfoTask.annotationTemplate.labelStatus, "draft");
assert.throws(() => parseKStartupCriteriaDraftJsonl(JSON.stringify(bizInfoDraftRecord)), /source must be kstartup/);

const reviewed: V3GrantAnnotation = {
  ...task.annotationTemplate,
  labelStatus: "reviewed",
  reviewerId: "reviewer@example.com",
  reviewedAt: "2026-07-12T00:00:00.000Z",
  annotatorId: "annotator-1",
  annotatedAt: "2026-07-11T00:00:00.000Z",
  audience: "company",
};
const publication = planReviewedGrantPublication(reviewed, current);
assert.equal(publication.operationalReady, true);
assert.equal(publication.criteria[0]?.needs_review, false);
assert.equal(publication.criteria[0]?.parser_version, "reviewer:matching-v3");

assert.throws(() => planReviewedGrantPublication({ ...reviewed, labelStatus: "draft" }, current), /labelStatus/);
assert.throws(() => planReviewedGrantPublication({ ...reviewed, reviewerId: null }, current), /reviewerId/);
assert.throws(() => planReviewedGrantPublication({ ...reviewed, reviewerId: reviewed.annotatorId! }, current), /must differ/);
assert.throws(() => planReviewedGrantPublication({ ...reviewed, reviewerId: "codex-reviewer" }, current), /human reviewer/);
assert.throws(() => planReviewedGrantPublication({ ...reviewed, reviewedAt: "2026-07-10T00:00:00.000Z" }, current), /must not precede/);
assert.throws(() => planReviewedGrantPublication({ ...reviewed, sourceRevision: "stale-revision" }, current), /stale sourceRevision/);
assert.throws(() => planReviewedGrantPublication({ ...reviewed, sourceRevision: null }, current), /sourceRevision is required/);
assert.throws(() => planReviewedGrantPublication({
  ...reviewed,
  criteria: [{ ...reviewed.criteria[0]!, sourceSpan: null }],
}, current), /requires sourceSpan/);

function normalized(): NormalizedGrant {
  return {
    raw: {
      source: "kstartup",
      source_id: "123",
      raw_hash: "raw-revision-1",
      payload: { aply_trgt_ctnt: "소프트웨어 기업" },
      status: "normalized",
    },
    grant: {
      source: "kstartup",
      source_id: "123",
      title: "소프트웨어 지원",
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0.8,
    },
    criteria: [],
  };
}

function normalizedBizInfo(): NormalizedGrant {
  return {
    raw: {
      source: "bizinfo",
      source_id: "PBLN_TEST",
      raw_hash: "bizinfo-revision-1",
      payload: { trgetNm: "중소기업" },
      status: "normalized",
    },
    grant: {
      source: "bizinfo",
      source_id: "PBLN_TEST",
      title: "[서울] 중소기업 지원",
      status: "open",
      f_regions: [],
      f_industries: [],
      f_sizes: [],
      f_founder_traits: [],
      f_required_certs: [],
      overall_confidence: 0.8,
    },
    criteria: [],
  };
}

console.log("kstartup-drafts.test.ts: all assertions passed");
