import assert from "node:assert/strict";
import { buildBizInfoSampleEntries } from "./bizinfoSample";
import { hashGrantRawPayload } from "./grantRawHash";
import {
  planGrantArchivePublication,
  selectPublishableArchiveEntries,
  type ExistingGrantRawHash,
} from "./archivePlan";

const entries = buildBizInfoSampleEntries({
  asOf: new Date("2026-06-26T00:00:00.000+09:00"),
  collectedAt: new Date("2026-06-26T00:00:00.000+09:00"),
});
assert.equal(entries.length, 1);
const [entry] = entries;
assert.ok(entry);

const unchanged: ExistingGrantRawHash[] = [{
  sourceId: entry.raw.source_id,
  rawHash: hashGrantRawPayload(entry.raw.payload),
}];
const changed: ExistingGrantRawHash[] = [{
  sourceId: entry.raw.source_id,
  rawHash: "stale-hash",
}];

const unchangedPlan = planGrantArchivePublication("bizinfo", entries, unchanged, { skipUnchanged: true });
const changedPlan = planGrantArchivePublication("bizinfo", entries, changed, { skipUnchanged: true });
const fullPlan = planGrantArchivePublication("bizinfo", entries, unchanged, { skipUnchanged: false });

assert.equal(unchangedPlan.publishableCount, 0);
assert.equal(unchangedPlan.unchangedCount, 1);
assert.equal(selectPublishableArchiveEntries(entries, unchangedPlan).length, 0);
assert.equal(changedPlan.changedCount, 1);
assert.equal(changedPlan.publishableCount, 1);
assert.equal(fullPlan.publishableCount, 1);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "bizinfo_archive_unchanged_skip",
    "bizinfo_archive_changed_publishable",
    "bizinfo_archive_publish_unchanged_override",
  ],
  unchangedPlan: {
    unchangedCount: unchangedPlan.unchangedCount,
    publishableCount: unchangedPlan.publishableCount,
  },
  changedPlan: {
    changedCount: changedPlan.changedCount,
    publishableCount: changedPlan.publishableCount,
  },
}, null, 2));
