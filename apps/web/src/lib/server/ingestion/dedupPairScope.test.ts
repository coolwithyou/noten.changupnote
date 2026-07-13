import assert from "node:assert/strict";
import type { GrantDedupCandidate } from "@cunote/core";
import { scopeDedupCandidates } from "./publishDedupCore";

const candidates = [candidate("a", "b"), candidate("c", "d")];
assert.deepEqual(scopeDedupCandidates(candidates, []), candidates);
assert.deepEqual(scopeDedupCandidates(candidates, [{ canonicalGrantKey: "b", memberGrantKey: "a" }]), [candidates[0]]);
assert.throws(() => scopeDedupCandidates(candidates, [{ canonicalGrantKey: "x", memberGrantKey: "y" }]), /no longer matches/);
assert.throws(() => scopeDedupCandidates(candidates, [
  { canonicalGrantKey: "a", memberGrantKey: "b" },
  { canonicalGrantKey: "b", memberGrantKey: "a" },
]), /duplicates/);

console.log("dedup-pair-scope: ok");

function candidate(canonicalGrantKey: string, memberGrantKey: string): GrantDedupCandidate {
  return {
    canonicalGrantKey,
    memberGrantKey,
    score: 0.9,
    decision: "auto_duplicate",
    relation: "same_announcement",
    reasons: [],
  };
}
