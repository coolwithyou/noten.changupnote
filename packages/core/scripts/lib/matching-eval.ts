import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { basename, extname, isAbsolute, join } from "node:path";
import type { CompanyProfile, GrantCriterion, MatchQuality, MatchResult } from "@cunote/contracts";
import type { KStartupApiResponse } from "../../src/index.js";
import { matchGrantCriteria, normalizeKStartupPayload } from "../../src/index.js";

export type Eligibility = MatchResult["eligibility"];
export type DatasetSplit = "development" | "holdout";

export interface LegacyGoldenCase {
  sourceId: string;
  expected: Eligibility;
  note: string;
}

export interface LegacyMatchingGoldenFixture {
  goldenVer: string;
  fixture: string;
  asOf: string;
  company: CompanyProfile;
  cases: LegacyGoldenCase[];
}

export interface MatchingEvalResult extends LegacyGoldenCase {
  caseId: string;
  goldenVer: string;
  source: string;
  companyId: string;
  title: string;
  actual: Eligibility;
  fitScore: number;
  unknownFields: string[];
  criterionDimensions: string[];
  evidenceCriterionCount: number;
  criterionCount: number;
  quality: MatchQuality;
}

export interface V3CompanyAnnotation {
  recordType: "company";
  schemaVersion: "matching-v3";
  companyId: string;
  labelStatus: "legacy" | "draft" | "reviewed";
  businessKind: "individual" | "corporation" | "unknown";
  profile: CompanyProfile;
  sourceFixture: string;
}

export interface V3GrantAnnotation {
  recordType: "grant";
  schemaVersion: "matching-v3";
  grantId: string;
  source: string;
  sourceId: string;
  title: string;
  audience: "company" | "individual" | "mixed" | "unknown";
  labelStatus: "legacy" | "draft" | "reviewed";
  criteria: V3CriterionAnnotation[];
  sourceFixture: string;
}

export interface V3CriterionAnnotation {
  criterionId: string;
  dimension: GrantCriterion["dimension"];
  kind: GrantCriterion["kind"];
  operator: GrantCriterion["operator"];
  value: GrantCriterion["value"];
  sourceSpan: string | null;
  sourceField: string | null;
  annotationConfidence: number;
  note: string | null;
}

export interface V3EligibilityPairAnnotation {
  recordType: "eligibility_pair";
  schemaVersion: "matching-v3";
  pairId: string;
  grantId: string;
  companyId: string;
  expectedEligibility: Eligibility;
  split: DatasetSplit;
  labelStatus: "legacy" | "draft" | "reviewed";
  hardFailCriterionIds: string[];
  unknownCriterionIds: string[];
  resolvableByProfileInput: boolean | null;
  note: string;
}

export interface V3CompatibilityDataset {
  companies: V3CompanyAnnotation[];
  grants: V3GrantAnnotation[];
  eligibilityPairs: V3EligibilityPairAnnotation[];
}

export interface ClassMetric {
  expected: number;
  predicted: number;
  truePositive: number;
  precision: number | null;
  recall: number | null;
}

export interface MatchingMetrics {
  total: number;
  correct: number;
  accuracy: number;
  byClass: Record<Eligibility, ClassMetric>;
  confusionMatrix: Record<Eligibility, Record<Eligibility, number>>;
}

export interface MatchingBaselineReport {
  generatedAt: string;
  fixtureVersions: string[];
  results: MatchingEvalResult[];
  metrics: MatchingMetrics;
  stratification: {
    bySource: Record<string, MatchingMetrics>;
    unknownDimensions: Record<string, number>;
    criterionDimensions: Record<string, number>;
    extractionReadiness: Record<string, number>;
    eligibilityConfidence: Record<string, number>;
    averageVerificationCompleteness: number;
    averageEvidenceCoverage: number;
  };
  compatibility: {
    companyAnnotations: number;
    uniqueGrantAnnotations: number;
    eligibilityPairAnnotations: number;
    reviewedAnnotations: number;
    legacyAnnotations: number;
  };
  limitations: string[];
}

const CLASSES: Eligibility[] = ["eligible", "conditional", "ineligible"];

export function readLegacyMatchingGoldenFixture(
  workspaceRoot: string,
  fixturePath: string,
): LegacyMatchingGoldenFixture {
  const absolutePath = join(workspaceRoot, fixturePath);
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as Partial<LegacyMatchingGoldenFixture>;
  const goldenVer = requireString(parsed.goldenVer, "golden fixture must include goldenVer");
  const sourceFixturePath = requireString(parsed.fixture, "golden fixture must include fixture path");
  const asOfValue = requireString(parsed.asOf, "golden fixture must include asOf");
  assert.ok(parsed.company && typeof parsed.company === "object", "golden fixture must include company");
  assert.ok(Array.isArray(parsed.cases) && parsed.cases.length > 0, "golden fixture must include cases");

  assert.equal(
    goldenVer,
    basename(absolutePath, extname(absolutePath)),
    "golden fixture goldenVer must match file name",
  );
  assert.ok(!Number.isNaN(new Date(asOfValue).getTime()), "golden fixture asOf must be a valid date");
  assert.ok(!isAbsolute(sourceFixturePath), "golden fixture source path must be workspace-relative");
  assert.ok(
    existsSync(join(workspaceRoot, sourceFixturePath)),
    `golden fixture source path must exist: ${sourceFixturePath}`,
  );

  const sourceIds = new Set<string>();
  const expectedClasses = new Set<Eligibility>();
  const cases = parsed.cases as Partial<LegacyGoldenCase>[];
  for (const entry of cases) {
    const sourceId = requireString(entry.sourceId, "golden case must include sourceId");
    assert.ok(!sourceIds.has(sourceId), `golden case sourceId must be unique: ${sourceId}`);
    sourceIds.add(sourceId);
    const expected = entry.expected as Eligibility;
    assert.ok(CLASSES.includes(expected), `golden case ${sourceId} has invalid expected class`);
    expectedClasses.add(expected);
    assert.ok(requireString(entry.note, `golden case ${sourceId} must include note`).trim().length > 0);
  }
  for (const eligibility of CLASSES) {
    assert.ok(expectedClasses.has(eligibility), `golden fixture must include ${eligibility}`);
  }

  return {
    goldenVer,
    fixture: sourceFixturePath,
    asOf: asOfValue,
    company: parsed.company as CompanyProfile,
    cases: cases as LegacyGoldenCase[],
  };
}

export function evaluateLegacyMatchingFixture(
  workspaceRoot: string,
  fixture: LegacyMatchingGoldenFixture,
): MatchingEvalResult[] {
  const asOf = new Date(fixture.asOf);
  const payload = JSON.parse(
    readFileSync(join(workspaceRoot, fixture.fixture), "utf8"),
  ) as KStartupApiResponse;
  const grants = normalizeKStartupPayload(payload, { asOf, collectedAt: asOf });
  const bySourceId = new Map(grants.map((item) => [item.grant.source_id, item]));
  const companyId = fixture.company.id ?? `${fixture.goldenVer}:company`;

  return fixture.cases.map((goldenCase) => {
    const item = bySourceId.get(goldenCase.sourceId);
    assert.ok(item, `golden case sourceId must exist: ${goldenCase.sourceId}`);
    const match = matchGrantCriteria(item.criteria, fixture.company);
    return {
      ...goldenCase,
      caseId: `${fixture.goldenVer}:${goldenCase.sourceId}:${companyId}`,
      goldenVer: fixture.goldenVer,
      source: item.grant.source,
      companyId,
      title: item.grant.title,
      actual: match.eligibility,
      fitScore: match.fit_score,
      unknownFields: match.unknown_fields,
      criterionDimensions: [...new Set(item.criteria.map((criterion) => criterion.dimension))],
      criterionCount: item.criteria.length,
      evidenceCriterionCount: item.criteria.filter(hasCriterionEvidence).length,
      quality: match.quality,
    };
  });
}

export function adaptLegacyFixtureToV3(
  workspaceRoot: string,
  fixture: LegacyMatchingGoldenFixture,
  split: DatasetSplit = "development",
): V3CompatibilityDataset {
  const asOf = new Date(fixture.asOf);
  const payload = JSON.parse(
    readFileSync(join(workspaceRoot, fixture.fixture), "utf8"),
  ) as KStartupApiResponse;
  const grants = normalizeKStartupPayload(payload, { asOf, collectedAt: asOf });
  const bySourceId = new Map(grants.map((item) => [item.grant.source_id, item]));
  const companyId = fixture.company.id ?? `${fixture.goldenVer}:company`;
  const company: V3CompanyAnnotation = {
    recordType: "company",
    schemaVersion: "matching-v3",
    companyId,
    labelStatus: "legacy",
    businessKind: "unknown",
    profile: fixture.company,
    sourceFixture: fixture.goldenVer,
  };
  const grantAnnotations = new Map<string, V3GrantAnnotation>();
  const eligibilityPairs = fixture.cases.map((goldenCase) => {
    const item = bySourceId.get(goldenCase.sourceId);
    assert.ok(item, `golden case sourceId must exist: ${goldenCase.sourceId}`);
    const grantId = `${item.grant.source}:${item.grant.source_id}`;
    grantAnnotations.set(grantId, {
      recordType: "grant",
      schemaVersion: "matching-v3",
      grantId,
      source: item.grant.source,
      sourceId: item.grant.source_id,
      title: item.grant.title,
      audience: "unknown",
      labelStatus: "legacy",
      criteria: item.criteria.map((criterion, index) => ({
        criterionId: criterion.id ?? `${grantId}:criterion:${index + 1}`,
        dimension: criterion.dimension,
        kind: criterion.kind,
        operator: criterion.operator,
        value: criterion.value,
        sourceSpan: criterion.source_span?.trim() || null,
        sourceField: criterion.source_field?.trim() || null,
        annotationConfidence: criterion.confidence,
        note: criterion.raw_text?.trim() || null,
      })),
      sourceFixture: fixture.goldenVer,
    });
    return {
      recordType: "eligibility_pair",
      schemaVersion: "matching-v3",
      pairId: `${fixture.goldenVer}:${goldenCase.sourceId}:${companyId}`,
      grantId,
      companyId,
      expectedEligibility: goldenCase.expected,
      split,
      labelStatus: "legacy",
      hardFailCriterionIds: [],
      unknownCriterionIds: [],
      resolvableByProfileInput: null,
      note: goldenCase.note,
    } satisfies V3EligibilityPairAnnotation;
  });
  return { companies: [company], grants: [...grantAnnotations.values()], eligibilityPairs };
}

export function buildMatchingBaselineReport(
  workspaceRoot: string,
  fixturePaths: string[],
): MatchingBaselineReport {
  const fixtures = fixturePaths.map((fixturePath) =>
    readLegacyMatchingGoldenFixture(workspaceRoot, fixturePath));
  const results = fixtures.flatMap((fixture) => evaluateLegacyMatchingFixture(workspaceRoot, fixture));
  const compatibilityDatasets = fixtures.map((fixture) => adaptLegacyFixtureToV3(workspaceRoot, fixture));
  const uniqueCompanies = new Map<string, V3CompanyAnnotation>();
  const uniqueGrants = new Map<string, V3GrantAnnotation>();
  const pairs: V3EligibilityPairAnnotation[] = [];
  for (const dataset of compatibilityDatasets) {
    for (const company of dataset.companies) uniqueCompanies.set(company.companyId, company);
    for (const grant of dataset.grants) uniqueGrants.set(grant.grantId, grant);
    pairs.push(...dataset.eligibilityPairs);
  }

  const sources = [...new Set(results.map((result) => result.source))];
  const allAnnotations = [...uniqueCompanies.values(), ...uniqueGrants.values(), ...pairs];
  return {
    generatedAt: new Date().toISOString(),
    fixtureVersions: fixtures.map((fixture) => fixture.goldenVer),
    results,
    metrics: computeMatchingMetrics(results),
    stratification: {
      bySource: Object.fromEntries(sources.map((source) => [
        source,
        computeMatchingMetrics(results.filter((result) => result.source === source)),
      ])),
      unknownDimensions: histogram(results.flatMap((result) => result.unknownFields)),
      criterionDimensions: histogram(results.flatMap((result) => result.criterionDimensions)),
      extractionReadiness: histogram(results.map((result) => result.quality.extractionReadiness)),
      eligibilityConfidence: histogram(results.map((result) => result.quality.eligibilityConfidence)),
      averageVerificationCompleteness: average(
        results.map((result) => result.quality.verificationCompleteness),
      ),
      averageEvidenceCoverage: average(results.map((result) => result.quality.evidenceCoverage)),
    },
    compatibility: {
      companyAnnotations: uniqueCompanies.size,
      uniqueGrantAnnotations: uniqueGrants.size,
      eligibilityPairAnnotations: pairs.length,
      reviewedAnnotations: allAnnotations.filter((item) => item.labelStatus === "reviewed").length,
      legacyAnnotations: allAnnotations.filter((item) => item.labelStatus === "legacy").length,
    },
    limitations: [
      "현재 baseline은 K-Startup 단일 원천의 legacy golden 9쌍만 포함한다.",
      "동일 작성자가 선택한 소규모 회귀셋이므로 운영 정확도 또는 일반화 성능을 증명하지 않는다.",
      "legacy pair에는 criterion 단위 hard-fail/unknown 정답과 reviewer 이중 라벨이 없다.",
      "기업마당, 개인사업자, 법인사업자 층화 평가는 matching-v3 수동 라벨 확장 후 가능하다.",
    ],
  };
}

export function computeMatchingMetrics(
  results: Array<Pick<MatchingEvalResult, "expected" | "actual">>,
): MatchingMetrics {
  assert.ok(results.length > 0, "matching metrics require at least one result");
  const correct = results.filter((result) => result.actual === result.expected).length;
  const confusionMatrix = Object.fromEntries(CLASSES.map((expected) => [
    expected,
    Object.fromEntries(CLASSES.map((actual) => [
      actual,
      results.filter((result) => result.expected === expected && result.actual === actual).length,
    ])),
  ])) as Record<Eligibility, Record<Eligibility, number>>;
  const byClass = Object.fromEntries(CLASSES.map((eligibility) => {
    const expected = results.filter((result) => result.expected === eligibility).length;
    const predicted = results.filter((result) => result.actual === eligibility).length;
    const truePositive = confusionMatrix[eligibility][eligibility];
    return [eligibility, {
      expected,
      predicted,
      truePositive,
      precision: predicted === 0 ? null : truePositive / predicted,
      recall: expected === 0 ? null : truePositive / expected,
    }];
  })) as Record<Eligibility, ClassMetric>;
  return { total: results.length, correct, accuracy: correct / results.length, byClass, confusionMatrix };
}

function hasCriterionEvidence(criterion: GrantCriterion): boolean {
  return Boolean(criterion.source_span?.trim() || criterion.source_field?.trim());
}

function histogram(values: string[]): Record<string, number> {
  return Object.fromEntries([...values.reduce((counts, value) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    return counts;
  }, new Map<string, number>()).entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0])));
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function requireString(value: unknown, message: string): string {
  assert.equal(typeof value, "string", message);
  return value as string;
}
