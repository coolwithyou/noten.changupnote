import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NormalizedGrant } from "@cunote/contracts";
import type { KStartupApiResponse } from "../src/index.js";
import {
  findGrantDedupCandidates,
  grantDedupKey,
  normalizeKStartupPayload,
} from "../src/index.js";

const asOf = new Date("2026-06-26T00:00:00.000+09:00");
const fixture = JSON.parse(
  readFileSync("samples/kstartup_announcement_sample.json", "utf8"),
) as KStartupApiResponse;

const kstartupEntries = normalizeKStartupPayload(fixture, { asOf, collectedAt: asOf });
const techBridge = kstartupEntries.find((entry) => entry.grant.source_id === "178246");
assert.ok(techBridge, "fixture must include Startup Tech Bridge");

const bizInfoDuplicate: NormalizedGrant<Record<string, unknown>> = {
  raw: {
    source: "bizinfo",
    source_id: "PBLN_DEDUP_TECH_BRIDGE",
    payload: {
      title: "2026년 스타트업 테크 브릿지 참여기업 모집",
      source: "dedup-fixture",
    },
    status: "normalized",
  },
  grant: {
    ...techBridge.grant,
    source: "bizinfo",
    source_id: "PBLN_DEDUP_TECH_BRIDGE",
    title: "2026년 스타트업 테크 브릿지 참여기업 모집",
    parser_version: "dedup-fixture",
  },
  criteria: techBridge.criteria,
};

const bizInfoDifferent: NormalizedGrant<Record<string, unknown>> = {
  raw: {
    source: "bizinfo",
    source_id: "PBLN_DEDUP_UNRELATED",
    payload: {
      title: "전통시장 온라인 판로개척 지원사업",
      source: "dedup-fixture",
    },
    status: "normalized",
  },
  grant: {
    ...techBridge.grant,
    source: "bizinfo",
    source_id: "PBLN_DEDUP_UNRELATED",
    title: "전통시장 온라인 판로개척 지원사업",
    agency_jurisdiction: "소상공인시장진흥공단",
    agency_operator: "소상공인시장진흥공단",
    category_l1: "판로",
    category_l2: "마케팅",
    apply_start: "2026-08-01",
    apply_end: "2026-09-01",
    parser_version: "dedup-fixture",
  },
  criteria: [],
};

const dedupEntries: Array<NormalizedGrant<unknown>> = [
  techBridge,
  bizInfoDuplicate,
  bizInfoDifferent,
];
const candidates = findGrantDedupCandidates(dedupEntries, { minScore: 0.82 });

const duplicateCandidate = candidates.find((candidate) =>
  candidate.canonicalGrantKey === "bizinfo:PBLN_DEDUP_TECH_BRIDGE" &&
  candidate.memberGrantKey === "kstartup:178246"
);
assert.ok(duplicateCandidate, "cross-source duplicate candidate should be found");
assert.ok(duplicateCandidate.score >= 0.9, "duplicate candidate should have high score");
assert.ok(duplicateCandidate.reasons.some((reason) => reason.startsWith("title:")), "candidate should explain title score");

const unrelatedKey = grantDedupKey(bizInfoDifferent.grant);
assert.ok(
  candidates.every((candidate) =>
    candidate.canonicalGrantKey !== unrelatedKey && candidate.memberGrantKey !== unrelatedKey
  ),
  "unrelated BizInfo program should not be a dedup candidate",
);

const sameSourceCandidates = findGrantDedupCandidates([
  techBridge,
  { ...techBridge, raw: { ...techBridge.raw, source_id: "178246_COPY" }, grant: { ...techBridge.grant, source_id: "178246_COPY" } },
], { minScore: 0.82 });
assert.equal(sameSourceCandidates.length, 0, "same-source pairs should be skipped by default");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "cross_source_duplicate_candidate",
    "unrelated_candidate_rejected",
    "same_source_pairs_skipped",
  ],
  candidates,
}, null, 2));
