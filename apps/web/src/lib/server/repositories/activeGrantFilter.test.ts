import assert from "node:assert/strict";
import type { Grant } from "@cunote/contracts";
import {
  filterActiveGrants,
  activeGrantApplyEndCutoff,
  isClearlyStaleUndatedGrant,
  isGrantActiveAt,
  isKStartupRecruitmentClosedPayload,
} from "./activeGrantFilter";

const asOf = new Date("2026-07-12T00:00:00.000Z");
assert.equal(isClearlyStaleUndatedGrant(grant("2018년 창업지원", "kstartup"), asOf), true);
assert.equal(isGrantActiveAt(grant("2018년 창업지원", "kstartup"), asOf), false);
assert.equal(isClearlyStaleUndatedGrant(grant("2026년 창업지원", "kstartup"), asOf), false);
assert.equal(isClearlyStaleUndatedGrant(grant("2018년 성과를 반영한 2026년 지원", "kstartup"), asOf), false);
assert.equal(isClearlyStaleUndatedGrant(grant("2018년 창업지원", "bizinfo"), asOf), false);
assert.equal(isClearlyStaleUndatedGrant({ ...grant("2018년 창업지원", "kstartup"), status: "open" }, asOf), false);
assert.equal(isClearlyStaleUndatedGrant({ ...grant("2018년 창업지원", "kstartup"), apply_end: "2026-12-31" }, asOf), false);
assert.equal(isClearlyStaleUndatedGrant(grant("연중 상시 창업지원", "kstartup"), asOf), false);
assert.equal(isKStartupRecruitmentClosedPayload("kstartup", { rcrt_prgs_yn: "N" }), true);
assert.equal(isKStartupRecruitmentClosedPayload("kstartup", { rcrt_prgs_yn: " n " }), true);
assert.equal(isKStartupRecruitmentClosedPayload("kstartup", { rcrt_prgs_yn: "Y" }), false);
assert.equal(isKStartupRecruitmentClosedPayload("bizinfo", { rcrt_prgs_yn: "N" }), false);

const koreaMidnight = new Date("2026-07-14T15:00:00.000Z");
assert.equal(
  isGrantActiveAt({ ...grant("마감 공고", "bizinfo"), status: "open", apply_end: "2026-07-14" }, koreaMidnight),
  false,
  "한국 자정 이후 전날 마감 공고를 활성으로 남기면 안 됨",
);
assert.equal(activeGrantApplyEndCutoff(koreaMidnight).toISOString(), "2026-07-15T00:00:00.000Z");

const activeEntries = filterActiveGrants([
  normalized("recruiting", "Y"),
  normalized("closed-by-source", "N"),
  normalized("missing-source-flag", null),
], { asOf });
assert.deepEqual(activeEntries.map((entry) => entry.grant.source_id), ["recruiting", "missing-source-flag"]);

console.log("activeGrantFilter.test.ts: all assertions passed");

function grant(title: string, source: Grant["source"]): Grant {
  return {
    source,
    source_id: "freshness-test",
    title,
    status: "unknown",
    f_regions: [],
    f_industries: [],
    f_sizes: [],
    f_founder_traits: [],
    f_required_certs: [],
    overall_confidence: 0,
  };
}

function normalized(sourceId: string, recruitmentProgress: string | null) {
  return {
    raw: {
      source: "kstartup" as const,
      source_id: sourceId,
      payload: { rcrt_prgs_yn: recruitmentProgress },
      status: "normalized" as const,
    },
    grant: { ...grant("연중 상시 창업지원", "kstartup"), source_id: sourceId },
    criteria: [],
  };
}
