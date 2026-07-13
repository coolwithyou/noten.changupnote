import assert from "node:assert/strict";
import type { Grant, NormalizedGrant } from "@cunote/contracts";
import { selectExpandedGrantReviewCandidates } from "./expanded-review-selection.js";

const entries = ["kstartup", "bizinfo"].flatMap((source) => Array.from({ length: 20 }, (_, index) => grant(source as Grant["source"], index)));
const selected = selectExpandedGrantReviewCandidates({ entries, perSource: 10 });
assert.equal(selected.entries.length, 20);
assert.equal(selected.bySource.kstartup, 10);
assert.equal(selected.bySource.bizinfo, 10);
assert.equal(new Set(selected.entries.map((entry) => `${entry.grant.source}:${entry.grant.source_id}`)).size, 20);
assert.throws(() => selectExpandedGrantReviewCandidates({ entries: entries.slice(0, 5), perSource: 10 }), /requires 10/);
console.log("expanded-review-selection.test.ts: all assertions passed");

function grant(source: Grant["source"], index: number): NormalizedGrant {
  const value: Grant = {
    source,
    source_id: String(index),
    title: `${source}-${index}`,
    status: "open",
    f_regions: [], f_industries: [], f_sizes: [], f_founder_traits: [], f_required_certs: [], overall_confidence: 1,
  };
  return {
    raw: { source, source_id: String(index), payload: {}, status: "normalized", raw_hash: `r-${index}` },
    grant: value,
    criteria: index % 3 === 2 ? [] : [{
      id: `${source}-${index}-c`, dimension: "region", kind: index % 3 === 0 ? "exclusion" : "required",
      operator: "in", value: { regions: ["11"] }, confidence: 1, source_span: "서울",
    }],
  };
}
