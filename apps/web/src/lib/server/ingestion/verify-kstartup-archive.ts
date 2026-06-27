import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeKStartupPayload,
  type KStartupApiResponse,
} from "@cunote/core";
import { hashGrantRawPayload } from "./grantRawHash";
import {
  planGrantArchivePublication,
  selectPublishableArchiveEntries,
  type ExistingGrantRawHash,
} from "./archivePlan";

const fixture = JSON.parse(
  readFileSync("samples/kstartup_announcement_sample.json", "utf8"),
) as KStartupApiResponse;

const entries = normalizeKStartupPayload(fixture, {
  asOf: new Date("2026-06-26T00:00:00.000+09:00"),
  collectedAt: new Date("2026-06-26T00:00:00.000+09:00"),
});
const existing: ExistingGrantRawHash[] = [
  ...entries.slice(0, 5).map((entry) => ({
    sourceId: entry.raw.source_id,
    rawHash: hashGrantRawPayload(entry.raw.payload),
  })),
  ...entries.slice(5, 8).map((entry, index) => ({
    sourceId: entry.raw.source_id,
    rawHash: `stale-${index}`,
  })),
];

const skipPlan = planGrantArchivePublication("kstartup", entries, existing, {
  skipUnchanged: true,
});
const fullPlan = planGrantArchivePublication("kstartup", entries, existing, {
  skipUnchanged: false,
});
const publishableEntries = selectPublishableArchiveEntries(entries, skipPlan);

assert.equal(skipPlan.fetchedCount, 20);
assert.equal(skipPlan.unchangedCount, 5);
assert.equal(skipPlan.changedCount, 3);
assert.equal(skipPlan.newCount, 12);
assert.equal(skipPlan.publishableCount, 15);
assert.equal(publishableEntries.length, 15);
assert.equal(fullPlan.publishableCount, 20);
assert.equal(skipPlan.rawHashes.length, 20);
assert.ok(skipPlan.rawHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)));

console.log(JSON.stringify({
  ok: true,
  checked: [
    "archive_new_changed_unchanged_counts",
    "archive_skip_unchanged_publishable_selection",
    "archive_publish_unchanged_override",
    "archive_raw_hash_shape",
  ],
  skipPlan: {
    fetchedCount: skipPlan.fetchedCount,
    newCount: skipPlan.newCount,
    changedCount: skipPlan.changedCount,
    unchangedCount: skipPlan.unchangedCount,
    publishableCount: skipPlan.publishableCount,
  },
  fullPlan: {
    publishableCount: fullPlan.publishableCount,
  },
}, null, 2));
