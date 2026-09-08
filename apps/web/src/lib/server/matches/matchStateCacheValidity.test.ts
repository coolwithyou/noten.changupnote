import assert from "node:assert/strict";
import { RULESET_VERSION, SCORING_VERSION, type MatchStateInputBinding } from "@cunote/core";
import { filterCurrentMatchStateCacheRows } from "./matchStateCacheValidity";

const companyId = "00000000-0000-4000-8000-000000000001";
const grantId = "00000000-0000-4000-8000-000000000002";
const memberGrantId = "00000000-0000-4000-8000-000000000003";
const current: MatchStateInputBinding = {
  version: "match-state-input-v1",
  companyId,
  companyRevision: "7",
  grantId,
  grantComponentRevisions: [
    { grantId, revision: "9" },
    { grantId: memberGrantId, revision: "4" },
  ],
};
const valid = {
  id: "valid",
  companyId,
  grantId,
  inputBinding: current,
  calculationAsOf: new Date("2026-09-09T00:00:00.000Z"),
  rulesetVer: RULESET_VERSION,
  scoringVer: SCORING_VERSION,
};

assert.deepEqual(filterCurrentMatchStateCacheRows([valid], [current]), [valid]);
assert.deepEqual(filterCurrentMatchStateCacheRows([
  { ...valid, id: "legacy", inputBinding: null },
  { ...valid, id: "missing-as-of", calculationAsOf: null },
  { ...valid, id: "bad-as-of", calculationAsOf: new Date(Number.NaN) },
  { ...valid, id: "old-rules", rulesetVer: "ruleset-kstartup-spine-v8" },
  { ...valid, id: "old-score", scoringVer: "scoring-old" },
  { ...valid, id: "company-drift", inputBinding: { ...current, companyRevision: "6" } },
  {
    ...valid,
    id: "grant-drift",
    inputBinding: {
      ...current,
      grantComponentRevisions: current.grantComponentRevisions.map((entry) => (
        entry.grantId === grantId ? { ...entry, revision: "8" } : entry
      )),
    },
  },
  {
    ...valid,
    id: "topology-drift",
    inputBinding: { ...current, grantComponentRevisions: [{ grantId, revision: "9" }] },
  },
  {
    ...valid,
    id: "extra-binding-field",
    inputBinding: { ...current, unsealed: true },
  },
], [current]), []);

assert.deepEqual(
  filterCurrentMatchStateCacheRows([
    { ...valid, id: "component-order", inputBinding: {
      ...current,
      grantComponentRevisions: [...current.grantComponentRevisions].reverse(),
    } },
  ], [current]).map((row) => row.id),
  ["component-order"],
  "component order is not semantic drift",
);

console.log("PASS: match_state cache accepts only current v1 binding, topology, asOf and engine versions");
