import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NormalizedGrant } from "@cunote/contracts";
import {
  normalizeKStartupPayload,
  type KStartupAnnouncement,
  type KStartupApiResponse,
} from "@cunote/core";
import { buildBizInfoSampleEntries } from "./ingestion/bizinfoSample";
import { planServicePipeline } from "./servicePipelinePlan";

const asOf = new Date("2026-06-26T00:00:00.000+09:00");
const companyId = "00000000-0000-4000-8000-000000000301";
const fixture = JSON.parse(
  readFileSync("samples/kstartup_announcement_sample.json", "utf8"),
) as KStartupApiResponse;
const [kstartupEntry] = normalizeKStartupPayload({
  ...fixture,
  data: fixture.data.slice(0, 1),
}, { asOf, collectedAt: asOf });
assert.ok(kstartupEntry, "K-Startup sample should include at least one entry");

const [bizinfoEntry] = buildBizInfoSampleEntries({ asOf, collectedAt: asOf });
assert.ok(bizinfoEntry, "BizInfo sample should include one entry");

const duplicateKStartup = duplicateForBizInfo(kstartupEntry, bizinfoEntry.grant.title);
const plan = planServicePipeline({
  companyId,
  company: {
    id: companyId,
    name: "서비스 파이프라인 검증 기업",
    region: { code: "41", label: "경기" },
    biz_age_months: 26,
    industries: ["ICT", "SaaS"],
    size: "중소",
    confidence: {},
  },
  kstartupEntries: [duplicateKStartup],
  bizinfoEntries: [bizinfoEntry],
  dedupOptions: { minScore: 0.82 },
  asOf,
});

assert.equal(plan.asOf, asOf.toISOString());
assert.equal(plan.ingestion.sourceCount, 2);
assert.equal(plan.ingestion.publishedEntryCount, 2);
assert.equal(plan.ingestion.dedup.linkCount, 1);
assert.equal(plan.matchState.companyId, companyId);
assert.equal(plan.matchState.grantCount, plan.ingestion.publishedEntryCount);
assert.equal(
  plan.matchState.counts.eligible + plan.matchState.counts.conditional + plan.matchState.counts.ineligible,
  plan.ingestion.publishedEntryCount,
);
assert.equal(plan.matchState.states.every((state) => state.match.rule_trace.length > 0), true);
assert.deepEqual(plan.checks, {
  hasPublishedEntries: true,
  hasCriteria: true,
  matchStateCoversPublishedEntries: true,
  hasDecisionTrace: true,
});
assert.deepEqual(plan.warnings, []);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "service_pipeline_ingestion_plan",
    "service_pipeline_dedup_plan",
    "service_pipeline_match_state_plan",
    "service_pipeline_readiness_checks",
  ],
  ingestion: {
    sourceCount: plan.ingestion.sourceCount,
    publishedEntryCount: plan.ingestion.publishedEntryCount,
    criteriaCount: plan.ingestion.criteriaCount,
    dedupLinks: plan.ingestion.dedup.linkCount,
  },
  matchState: {
    grantCount: plan.matchState.grantCount,
    counts: plan.matchState.counts,
  },
  warnings: plan.warnings,
}, null, 2));

function duplicateForBizInfo(
  entry: NormalizedGrant<KStartupAnnouncement>,
  title: string,
): NormalizedGrant<KStartupAnnouncement> {
  return {
    ...entry,
    raw: {
      ...entry.raw,
      source_id: "PIPELINE_DEDUP_SAMPLE",
      payload: {
        ...entry.raw.payload,
        pbanc_sn: "PIPELINE_DEDUP_SAMPLE",
        biz_pbanc_nm: title,
      },
    },
    grant: {
      ...entry.grant,
      source_id: "PIPELINE_DEDUP_SAMPLE",
      title,
      agency_jurisdiction: "중소벤처기업부",
      agency_operator: "창업진흥원",
      category_l1: "기술",
      category_l2: "사업화",
      apply_start: "2026-06-01",
      apply_end: "2026-07-20",
    },
  };
}
