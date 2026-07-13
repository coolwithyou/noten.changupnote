import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildMatchingV3PairInputFingerprint,
  parseV3AnnotationJsonl,
  RULESET_VERSION,
  SCORING_VERSION,
  type MatchingV3PairHoldoutManifest,
  type MatchingV3PairReviewTask,
} from "../src/index.js";

const grantManifest = JSON.parse(readFileSync(resolve("packages/core/golden/matching-v3/expanded-seed-manifest.json"), "utf8")) as {
  schemaVersion: string;
  createdAt: string;
  asOf: string;
  activeUniverseCount: number;
  activeUniverseLimit: number;
  activeUniverseComplete: boolean;
  perSource: number;
  companyCount: number;
  grantSelection: Array<{ grantId: string; source: string; sourceRevision: string; status: string }>;
};
const companies = parseV3AnnotationJsonl(readFileSync(resolve("packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl"), "utf8")).companies;
const grants = parseV3AnnotationJsonl(readFileSync(resolve("tmp/matching-v3-expanded-draft-grants.jsonl"), "utf8")).grants;
const pairTasks = readJsonl<MatchingV3PairReviewTask>("tmp/matching-v3-expanded-pair-review-tasks.jsonl");
const pairAnnotations = parseV3AnnotationJsonl(readFileSync(resolve("tmp/matching-v3-expanded-draft-pairs.jsonl"), "utf8")).eligibilityPairs;
const holdoutManifest = JSON.parse(readFileSync(resolve("packages/core/golden/matching-v3/expanded-holdout-manifest.json"), "utf8")) as MatchingV3PairHoldoutManifest;

assert.equal(grantManifest.schemaVersion, "matching-v3-expanded-seed-v1");
assert.equal(Number.isNaN(new Date(grantManifest.createdAt).getTime()), false, "manifest createdAt must be an ISO date");
assert.equal(Number.isNaN(new Date(grantManifest.asOf).getTime()), false, "manifest asOf must be an ISO date");
assert.equal(grantManifest.activeUniverseComplete, true);
assert.equal(grantManifest.activeUniverseCount < grantManifest.activeUniverseLimit, true, "active universe must be below the exporter sentinel limit");
assert.equal(grantManifest.activeUniverseCount >= 100, true, "active universe must cover the 100-grant review sample");
assert.equal(grantManifest.perSource, 50);
assert.equal(grantManifest.companyCount, 30);
assert.equal(grantManifest.grantSelection.length, 100);
assert.equal(new Set(grantManifest.grantSelection.map((grant) => grant.grantId)).size, 100);
assert.equal(grantManifest.grantSelection.filter((grant) => grant.source === "kstartup").length, 50);
assert.equal(grantManifest.grantSelection.filter((grant) => grant.source === "bizinfo").length, 50);
assert.equal(grantManifest.grantSelection.every((grant) => Boolean(grant.sourceRevision) && grant.status === "draft_pending"), true);
assert.equal(companies.length, 30);
assert.equal(companies.filter((company) => company.businessKind === "individual").length, 15);
assert.equal(companies.filter((company) => company.businessKind === "corporation").length, 15);
assert.equal(pairTasks.length, 500);
assert.equal(new Set(pairTasks.map((task) => task.pairId)).size, 500);
assert.equal(new Set(pairTasks.map((task) => task.grantId)).size, 100);
assert.equal(new Set(pairTasks.map((task) => task.companyId)).size, 30);
assert.equal(pairAnnotations.length, 500);
assert.equal(pairAnnotations.filter((pair) => pair.split === "development").length, 350);
assert.equal(pairAnnotations.filter((pair) => pair.split === "holdout").length, 150);
assert.deepEqual(new Set(holdoutManifest.pairIds), new Set(pairAnnotations.filter((pair) => pair.split === "holdout").map((pair) => pair.pairId)));
assert.equal(pairAnnotations.every((pair) => pair.labelStatus === "draft"), true);
const grantsById = new Map(grants.map((grant) => [grant.grantId, grant]));
const companiesById = new Map(companies.map((company) => [company.companyId, company]));
const annotationsById = new Map(pairAnnotations.map((pair) => [pair.pairId, pair]));
for (const task of pairTasks) {
  const grant = grantsById.get(task.grantId);
  const company = companiesById.get(task.companyId);
  const annotation = annotationsById.get(task.pairId);
  assert.ok(grant, `${task.pairId}: grant input missing`);
  assert.ok(company, `${task.pairId}: company input missing`);
  assert.ok(annotation, `${task.pairId}: annotation template missing`);
  assert.equal(task.rulesetVer, RULESET_VERSION, `${task.pairId}: ruleset drift`);
  assert.equal(task.scoringVer, SCORING_VERSION, `${task.pairId}: scoring drift`);
  assert.equal(task.inputFingerprint, buildMatchingV3PairInputFingerprint({ grant, company }), `${task.pairId}: input fingerprint drift`);
  assert.equal(annotation.rulesetVer, task.rulesetVer, `${task.pairId}: annotation ruleset drift`);
  assert.equal(annotation.scoringVer, task.scoringVer, `${task.pairId}: annotation scoring drift`);
  assert.equal(annotation.inputFingerprint, task.inputFingerprint, `${task.pairId}: annotation fingerprint drift`);
}
const serialized = JSON.stringify(pairTasks);
for (const forbidden of ["company_value", "bizNo", "businessNumber", "representativeName", "rawPayload", "storage_key", "archive_url"]) {
  assert.equal(serialized.includes(`\"${forbidden}\"`), false, `forbidden expanded task field ${forbidden}`);
}
console.log(JSON.stringify({
  ok: true,
  checked: [
    "active_universe_complete",
    "grant_100_source_balance",
    "company_30_kind_balance",
    "pair_500_full_entity_coverage",
    "development_350_holdout_150",
    "current_engine_and_input_fingerprint_pinned",
    "expanded_task_redaction",
    "draft_only_operational_gate",
  ],
  grants: grantManifest.grantSelection.length,
  companies: companies.length,
  pairs: pairTasks.length,
  splits: histogram(pairAnnotations.map((pair) => pair.split)),
  predictedEligibility: histogram(pairTasks.map((task) => task.predictedEligibility)),
  reviewed: 0,
  operationalReady: false,
}, null, 2));

function readJsonl<T>(path: string): T[] {
  return readFileSync(resolve(path), "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line) as T);
}
function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
