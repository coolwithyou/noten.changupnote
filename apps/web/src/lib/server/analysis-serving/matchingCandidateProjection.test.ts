import assert from "node:assert/strict";
import type { NormalizedGrant } from "@cunote/contracts";
import { projectMatchingCandidates } from "./matchingCandidateProjection";

function grantFixture(id: string): NormalizedGrant<Record<string, unknown>> {
  return {
    grant: {
      id,
      source: "bizinfo",
      source_id: `source-${id}`,
      title: "테스트 지원사업",
      agency_primary: "테스트기관",
      category_l1: "사업화",
      category_l2: null,
      support_amount: { max: 50_000_000, unit: "KRW", per: "기업" },
      apply_start: "2026-09-01",
      apply_end: "2026-09-30",
      status: "open",
      apply_method: { online: "온라인 접수" },
      url: "https://example.com/grant",
      required_documents: [{ name: "사업계획서", required: true, source: "portal" }],
      benefits: [{ family: "funding", label: "자금", source: "structured" }],
      obligations: [{ label: "성과보고", source: "structured" }],
      audience: "company",
      f_regions: ["11"],
      f_industries: ["software"],
      f_sizes: ["중소기업"],
      f_founder_traits: [],
      f_required_certs: [],
      f_apply_methods: ["online"],
      f_authoring_mode: "file_form",
      overall_confidence: 0.95,
      model_ver: "test-model",
      prompt_ver: "test-prompt",
    },
    criteria: [{
      id: `${id}-criterion`,
      grant_id: id,
      dimension: "region",
      kind: "required",
      operator: "in",
      value: { codes: ["11"] },
      confidence: 0.9,
      source_span: "서울 소재 기업",
    }],
    extraction_manifest: {
      grantId: id,
      revision: "reviewed",
      sourceFieldsSeen: ["criteria"],
      attachmentsExpected: 1,
      attachmentsFetched: 1,
      attachmentsConverted: 1,
      sectionsDetected: ["eligibility"],
      extractorVersion: "test",
      completedAt: "2026-09-19T00:00:00.000Z",
      warnings: [],
      readiness: "reviewed",
      reviewedAt: "2026-09-19T00:00:00.000Z",
    },
    raw: {
      source: "bizinfo",
      source_id: `source-${id}`,
      collected_at: "2026-09-19T00:00:00.000Z",
      payload: { privateAnalysis: "remove-me" },
      attachments: [{ filename: "application.hwp" }],
      status: "published",
    },
  };
}

const verifiedId = "00000000-0000-4000-8000-000000000301";
const changedId = "00000000-0000-4000-8000-000000000302";
const unreviewedId = "00000000-0000-4000-8000-000000000303";
const projected = projectMatchingCandidates({
  entries: [grantFixture(verifiedId), grantFixture(changedId), grantFixture(unreviewedId)],
  servingEvidence: [
    { grantId: verifiedId, appliedAt: new Date("2026-09-19T01:00:00Z"), sourceRevisionSha256: "a".repeat(64) },
    { grantId: changedId, appliedAt: new Date("2026-09-19T01:00:00Z"), sourceRevisionSha256: "b".repeat(64) },
  ],
  currentSources: new Map([
    [verifiedId, { sourceRevisionSha256: "a".repeat(64) }],
    [changedId, { sourceRevisionSha256: "c".repeat(64) }],
    [unreviewedId, { sourceRevisionSha256: "d".repeat(64) }],
  ]),
});

const verified = projected[0]!;
assert.equal(verified.matching_evidence?.level, "verified");
assert.equal(verified.criteria.length, 1);
assert.equal(verified.grant.support_amount && "max" in verified.grant.support_amount
  ? verified.grant.support_amount.max
  : null, 50_000_000);

const changed = projected[1]!;
assert.deepEqual(changed.matching_evidence, {
  level: "discovery",
  sourceRevisionSha256: "c".repeat(64),
  reason: "source_changed",
});
assert.equal(changed.criteria.length, 0);
assert.equal(changed.extraction_manifest, undefined);
assert.deepEqual(changed.raw.payload, {});
assert.equal(changed.raw.attachments, null);
assert.equal(changed.grant.support_amount, null);
assert.equal(changed.grant.required_documents, null);
assert.equal(changed.grant.benefits, null);
assert.deepEqual(changed.grant.f_regions, []);
assert.equal(changed.grant.apply_method, undefined);
assert.equal(changed.grant.audience, undefined);

const unreviewed = projected[2]!;
assert.deepEqual(unreviewed.matching_evidence, {
  level: "discovery",
  sourceRevisionSha256: "d".repeat(64),
  reason: "unreviewed",
});

console.log("matching-candidate-projection: ok");
