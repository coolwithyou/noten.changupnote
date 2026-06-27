import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  normalizeKStartupPayload,
  type KStartupApiResponse,
} from "@cunote/core";
import { planKStartupPublication } from "./kstartupPublisher";

const fixture = JSON.parse(
  readFileSync("samples/kstartup_announcement_sample.json", "utf8"),
) as KStartupApiResponse;

const entries = normalizeKStartupPayload(fixture, {
  asOf: new Date("2026-06-26T00:00:00.000+09:00"),
  collectedAt: new Date("2026-06-26T00:00:00.000+09:00"),
});
const plan = planKStartupPublication(entries);

assert.equal(plan.source, "kstartup");
assert.equal(plan.rawCount, 20, "sample fixture should produce 20 raw rows");
assert.equal(plan.grantCount, 20, "sample fixture should produce 20 grant rows");
assert.ok(plan.criteriaCount > 0, "sample fixture should produce grant_criteria rows");
assert.equal(plan.rawHashes.length, plan.rawCount, "each raw row should have one hash");
assert.equal(
  new Set(plan.rawHashes).size,
  plan.rawHashes.length,
  "sample raw hashes should be unique",
);
assert.ok(
  plan.rawHashes.every((hash) => /^[a-f0-9]{64}$/.test(hash)),
  "raw hashes should be sha256 hex strings",
);
const firstEntry = entries[0];
assert.ok(firstEntry, "sample fixture should include at least one entry");
assert.equal(
  planKStartupPublication([firstEntry]).rawHashes[0],
  planKStartupPublication([{
    ...firstEntry,
    raw: {
      ...firstEntry.raw,
      payload: reverseObjectKeys(firstEntry.raw.payload),
    },
  }]).rawHashes[0],
  "raw hash should not depend on object key order",
);

console.log(JSON.stringify({
  ok: true,
  checked: ["raw_hash", "raw_hash_stable_key_order", "grant_count", "criteria_count"],
  ...plan,
}, null, 2));

function reverseObjectKeys<T>(value: T): T {
  if (Array.isArray(value)) return value.map(reverseObjectKeys) as T;
  if (!value || typeof value !== "object") return value;

  return Object.keys(value as Record<string, unknown>)
    .reverse()
    .reduce<Record<string, unknown>>((result, key) => {
      result[key] = reverseObjectKeys((value as Record<string, unknown>)[key]);
      return result;
    }, {}) as T;
}
