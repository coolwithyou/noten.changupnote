import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { NormalizedGrant } from "@cunote/contracts";
import {
  normalizeKStartupPayload,
  type KStartupAnnouncement,
  type KStartupApiResponse,
} from "@cunote/core";
import { buildBizInfoSampleEntries } from "./bizinfoSample";
import { planIngestionBatchPublication } from "./ingestionBatchPlan";

const asOf = new Date("2026-06-26T00:00:00.000+09:00");
const fixture = JSON.parse(
  readFileSync("samples/kstartup_announcement_sample.json", "utf8"),
) as KStartupApiResponse;

const [firstKStartup] = normalizeKStartupPayload({
  ...fixture,
  data: fixture.data.slice(0, 1),
}, { asOf, collectedAt: asOf });
assert.ok(firstKStartup, "K-Startup sample should include at least one entry");

const [bizinfoEntry] = buildBizInfoSampleEntries({ asOf, collectedAt: asOf });
assert.ok(bizinfoEntry, "BizInfo sample should include one entry");

const duplicateKStartup = duplicateForBizInfo(firstKStartup, bizinfoEntry.grant.title);
const plan = planIngestionBatchPublication({
  kstartupEntries: [duplicateKStartup],
  bizinfoEntries: [bizinfoEntry],
  dedupOptions: { minScore: 0.82 },
});

assert.equal(plan.sourceCount, 2);
assert.equal(plan.publishedEntryCount, 2);
assert.equal(plan.rawCount, 2);
assert.equal(plan.grantCount, 2);
assert.equal(plan.criteriaCount, duplicateKStartup.criteria.length + bizinfoEntry.criteria.length);
assert.equal(plan.kstartup?.source, "kstartup");
assert.equal(plan.kstartup?.grantCount, 1);
assert.equal(plan.bizinfo?.source, "bizinfo");
assert.equal(plan.bizinfo?.grantCount, 1);
assert.equal(plan.dedup.publishedEntryCount, 2);
assert.equal(plan.dedup.poolEntryCount, 2);
assert.equal(plan.dedup.linkCount, 1);
assert.equal(plan.dedup.links[0]?.canonicalGrantKey, "bizinfo:PBLN_SAMPLE");
assert.equal(plan.dedup.links[0]?.memberGrantKey, "kstartup:BATCH_DEDUP_SAMPLE");

console.log(JSON.stringify({
  ok: true,
  checked: [
    "ingestion_batch_source_plans",
    "ingestion_batch_total_counts",
    "ingestion_batch_dedup_scope",
    "ingestion_batch_cross_source_link",
  ],
  sourceCount: plan.sourceCount,
  publishedEntryCount: plan.publishedEntryCount,
  criteriaCount: plan.criteriaCount,
  dedup: {
    linkCount: plan.dedup.linkCount,
    links: plan.dedup.links,
  },
}, null, 2));

function duplicateForBizInfo(
  entry: NormalizedGrant<KStartupAnnouncement>,
  title: string,
): NormalizedGrant<KStartupAnnouncement> {
  return {
    ...entry,
    raw: {
      ...entry.raw,
      source_id: "BATCH_DEDUP_SAMPLE",
      payload: {
        ...entry.raw.payload,
        pbanc_sn: "BATCH_DEDUP_SAMPLE",
        biz_pbanc_nm: title,
      },
    },
    grant: {
      ...entry.grant,
      source_id: "BATCH_DEDUP_SAMPLE",
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
