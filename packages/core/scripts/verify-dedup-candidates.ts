import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GrantSource, NormalizedGrant } from "@cunote/contracts";
import type { KStartupApiResponse } from "../src/index.js";
import {
  findGrantDedupCandidates,
  type GrantDedupCandidate,
  grantDedupKey,
  normalizeKStartupPayload,
} from "../src/index.js";

interface DedupGoldenCase {
  name: string;
  expected: "duplicate" | "non_duplicate";
  source: GrantSource;
  sourceId: string;
  title: string;
  agencyJurisdiction?: string;
  agencyOperator?: string;
  categoryL1?: string;
  categoryL2?: string;
  applyStart?: string;
  applyEnd?: string;
  minScore?: number;
  note: string;
}

interface DedupGoldenFixture {
  goldenVer: string;
  fixture: string;
  asOf: string;
  baseSourceId: string;
  minScore: number;
  cases: DedupGoldenCase[];
  sameSourceControl: {
    sourceId: string;
    expectedDefaultCandidateCount: number;
  };
}

const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const GOLDEN_FIXTURE_PATH = "packages/core/golden/dedup/kstartup-bizinfo-sample-v1.json";
const goldenFixture = readDedupGoldenFixture(join(WORKSPACE_ROOT, GOLDEN_FIXTURE_PATH));
const asOf = new Date(goldenFixture.asOf);
const fixture = JSON.parse(
  readFileSync(join(WORKSPACE_ROOT, goldenFixture.fixture), "utf8"),
) as KStartupApiResponse;

const kstartupEntries = normalizeKStartupPayload(fixture, { asOf, collectedAt: asOf });
const techBridge = kstartupEntries.find((entry) => entry.grant.source_id === goldenFixture.baseSourceId);
assert.ok(techBridge, "fixture must include Startup Tech Bridge");

const dedupEntries: Array<NormalizedGrant<unknown>> = [
  techBridge,
  ...goldenFixture.cases.map((goldenCase) => buildGoldenEntry(techBridge, goldenCase)),
];
const candidates = findGrantDedupCandidates(dedupEntries, { minScore: goldenFixture.minScore });
const baseKey = grantDedupKey(techBridge.grant);

for (const goldenCase of goldenFixture.cases) {
  const entry = dedupEntries.find((item) => item.grant.source_id === goldenCase.sourceId);
  assert.ok(entry, `golden dedup case entry must exist: ${goldenCase.sourceId}`);
  const entryKey = grantDedupKey(entry.grant);
  const candidate = findCandidate(candidates, baseKey, entryKey);

  if (goldenCase.expected === "duplicate") {
    assert.ok(candidate, `duplicate candidate should be found: ${goldenCase.name}`);
    assert.ok(
      candidate.score >= (goldenCase.minScore ?? goldenFixture.minScore),
      `duplicate candidate should meet min score: ${goldenCase.name}`,
    );
    assert.ok(
      candidate.reasons.some((reason) => reason.startsWith("title:")),
      `duplicate candidate should explain title score: ${goldenCase.name}`,
    );
  } else {
    assert.equal(candidate, null, `non duplicate should not be linked: ${goldenCase.name}`);
  }
}

const sameSourceCandidates = findGrantDedupCandidates([
  techBridge,
  {
    ...techBridge,
    raw: { ...techBridge.raw, source_id: goldenFixture.sameSourceControl.sourceId },
    grant: { ...techBridge.grant, source_id: goldenFixture.sameSourceControl.sourceId },
  },
], { minScore: goldenFixture.minScore });
assert.equal(
  sameSourceCandidates.length,
  goldenFixture.sameSourceControl.expectedDefaultCandidateCount,
  "same-source pairs should be skipped by default",
);

console.log(JSON.stringify({
  ok: true,
  checked: [
    "dedup_golden_fixture",
    "dedup_golden_fixture_file",
    "dedup_golden_fixture_cases",
    "cross_source_duplicate_candidate",
    "unrelated_candidate_rejected",
    "same_source_pairs_skipped",
  ],
  goldenVer: goldenFixture.goldenVer,
  candidates,
}, null, 2));

function buildGoldenEntry(
  base: NormalizedGrant<unknown>,
  goldenCase: DedupGoldenCase,
): NormalizedGrant<Record<string, unknown>> {
  const grant = {
    ...base.grant,
    source: goldenCase.source,
    source_id: goldenCase.sourceId,
    title: goldenCase.title,
    parser_version: "dedup-golden",
  };
  if (goldenCase.agencyJurisdiction !== undefined) grant.agency_jurisdiction = goldenCase.agencyJurisdiction;
  if (goldenCase.agencyOperator !== undefined) grant.agency_operator = goldenCase.agencyOperator;
  if (goldenCase.categoryL1 !== undefined) grant.category_l1 = goldenCase.categoryL1;
  if (goldenCase.categoryL2 !== undefined) grant.category_l2 = goldenCase.categoryL2;
  if (goldenCase.applyStart !== undefined) grant.apply_start = goldenCase.applyStart;
  if (goldenCase.applyEnd !== undefined) grant.apply_end = goldenCase.applyEnd;

  return {
    raw: {
      source: goldenCase.source,
      source_id: goldenCase.sourceId,
      payload: {
        name: goldenCase.name,
        title: goldenCase.title,
        source: "dedup-golden",
      },
      status: "normalized",
    },
    grant,
    criteria: goldenCase.expected === "duplicate" ? base.criteria : [],
  };
}

function findCandidate(
  candidates: GrantDedupCandidate[],
  leftKey: string,
  rightKey: string,
): GrantDedupCandidate | null {
  return candidates.find((candidate) =>
    (candidate.canonicalGrantKey === leftKey && candidate.memberGrantKey === rightKey) ||
    (candidate.canonicalGrantKey === rightKey && candidate.memberGrantKey === leftKey)
  ) ?? null;
}

function readDedupGoldenFixture(path: string): DedupGoldenFixture {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<DedupGoldenFixture>;
  const goldenVer = requireString(parsed.goldenVer, "dedup golden fixture must include goldenVer");
  const fixturePath = requireString(parsed.fixture, "dedup golden fixture must include fixture path");
  const asOfValue = requireString(parsed.asOf, "dedup golden fixture must include asOf");
  const baseSourceId = requireString(parsed.baseSourceId, "dedup golden fixture must include baseSourceId");
  const minScore = requireNumber(parsed.minScore, "dedup golden fixture must include minScore");
  assert.ok(Array.isArray(parsed.cases) && parsed.cases.length > 0, "dedup golden fixture must include cases");
  assert.ok(parsed.sameSourceControl, "dedup golden fixture must include sameSourceControl");

  const expectedGoldenVer = basename(path, extname(path));
  assert.equal(goldenVer, expectedGoldenVer, "dedup golden fixture goldenVer must match file name");
  const asOf = new Date(asOfValue);
  assert.ok(!Number.isNaN(asOf.getTime()), "dedup golden fixture asOf must be a valid date");
  assert.ok(!isAbsolute(fixturePath), "dedup golden fixture source path must be workspace-relative");
  assert.ok(
    existsSync(join(WORKSPACE_ROOT, fixturePath)),
    `dedup golden fixture source path must exist: ${fixturePath}`,
  );

  const sourceIds = new Set<string>();
  const expectedClasses = new Set<DedupGoldenCase["expected"]>();
  const validatedCases: DedupGoldenCase[] = [];
  const cases = parsed.cases as Partial<DedupGoldenCase>[];
  for (const entry of cases) {
    const name = requireString(entry.name, "dedup golden case must include name");
    const source = requireGrantSource(entry.source, `dedup golden case ${name} must include valid source`);
    const sourceId = requireString(entry.sourceId, `dedup golden case ${name} must include sourceId`);
    const title = requireString(entry.title, `dedup golden case ${name} must include title`);
    const note = requireString(entry.note, `dedup golden case ${name} must include note`);
    assert.ok(source.trim().length > 0, `dedup golden case ${name} source must not be empty`);
    assert.ok(sourceId.trim().length > 0, `dedup golden case ${name} sourceId must not be empty`);
    assert.ok(title.trim().length > 0, `dedup golden case ${name} title must not be empty`);
    assert.ok(note.trim().length > 0, `dedup golden case ${name} note must not be empty`);
    assert.ok(!sourceIds.has(sourceId), `dedup golden case sourceId must be unique: ${sourceId}`);
    sourceIds.add(sourceId);

    const expected = requireDedupExpected(entry.expected, `dedup golden case ${name} has invalid expected class`);
    expectedClasses.add(expected);
    validatedCases.push({
      name,
      expected,
      source,
      sourceId,
      title,
      note,
      ...(typeof entry.agencyJurisdiction === "string" ? { agencyJurisdiction: entry.agencyJurisdiction } : {}),
      ...(typeof entry.agencyOperator === "string" ? { agencyOperator: entry.agencyOperator } : {}),
      ...(typeof entry.categoryL1 === "string" ? { categoryL1: entry.categoryL1 } : {}),
      ...(typeof entry.categoryL2 === "string" ? { categoryL2: entry.categoryL2 } : {}),
      ...(typeof entry.applyStart === "string" ? { applyStart: entry.applyStart } : {}),
      ...(typeof entry.applyEnd === "string" ? { applyEnd: entry.applyEnd } : {}),
      ...(typeof entry.minScore === "number" ? { minScore: entry.minScore } : {}),
    });
  }
  assert.ok(expectedClasses.has("duplicate"), "dedup golden fixture must include at least one duplicate case");
  assert.ok(expectedClasses.has("non_duplicate"), "dedup golden fixture must include at least one non_duplicate case");

  const sameSourceControl = parsed.sameSourceControl as Partial<DedupGoldenFixture["sameSourceControl"]>;
  const sameSourceId = requireString(
    sameSourceControl.sourceId,
    "dedup golden fixture sameSourceControl must include sourceId",
  );
  const expectedDefaultCandidateCount = requireNumber(
    sameSourceControl.expectedDefaultCandidateCount,
    "dedup golden fixture sameSourceControl must include expectedDefaultCandidateCount",
  );
  assert.ok(
    Number.isInteger(expectedDefaultCandidateCount),
    "dedup golden fixture sameSourceControl expectedDefaultCandidateCount must be an integer",
  );

  return {
    goldenVer,
    fixture: fixturePath,
    asOf: asOfValue,
    baseSourceId,
    minScore,
    cases: validatedCases,
    sameSourceControl: {
      sourceId: sameSourceId,
      expectedDefaultCandidateCount,
    },
  };
}

function requireString(value: unknown, message: string): string {
  assert.equal(typeof value, "string", message);
  return value as string;
}

function requireNumber(value: unknown, message: string): number {
  assert.equal(typeof value, "number", message);
  return value as number;
}

function requireGrantSource(value: unknown, message: string): GrantSource {
  assert.ok(value === "kstartup" || value === "bizinfo" || value === "bizinfo_event", message);
  return value;
}

function requireDedupExpected(value: unknown, message: string): DedupGoldenCase["expected"] {
  assert.ok(value === "duplicate" || value === "non_duplicate", message);
  return value;
}
