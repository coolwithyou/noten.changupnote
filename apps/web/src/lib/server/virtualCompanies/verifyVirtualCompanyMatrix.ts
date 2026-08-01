import type {
  MatchCard,
  MatchRecommendationTier,
  NormalizedGrant,
} from "@cunote/contracts";
import { grantKey, resolveGrantExtractionManifest } from "@cunote/core";
import { buildMatchingProfileView } from "@/lib/server/productProfile/resolveProductCompanyProfile";
import {
  buildProductDashboardSnapshot,
  buildProductTeaserSnapshot,
} from "@/lib/server/productProfile/productMatchSnapshot";
import type {
  VirtualCompanyCriterionResult,
  VirtualCompanyScenario,
  VirtualCompanyTarget,
} from "./catalog";

export type VirtualCompanyMatrixStatus =
  | "pass"
  | "product_regression"
  | "scenario_stale"
  | "needs_rebaseline"
  | "infrastructure_error";

export interface VirtualCompanyTargetResult {
  scenarioId: string;
  source: VirtualCompanyTarget["source"];
  sourceId: string;
  grantId: string | null;
  title: string | null;
  expectedTier: VirtualCompanyTarget["expected"];
  actualTier: MatchRecommendationTier | null;
  eligibility: "eligible" | "conditional" | "ineligible" | null;
  visibleInUserResults: boolean;
  nextQuestionDimension: string | null;
  extractorVersion: string | null;
  revision: string | null;
  status: Exclude<VirtualCompanyMatrixStatus, "infrastructure_error">;
  criterionResults: Record<string, string[]>;
  issues: string[];
}

export interface VirtualCompanyMatrixReport {
  status: Exclude<VirtualCompanyMatrixStatus, "infrastructure_error">;
  asOf: string;
  evaluatedGrantCount: number;
  scenarioCount: number;
  targetCount: number;
  results: VirtualCompanyTargetResult[];
}

export function verifyVirtualCompanyMatrix<TPayload>(input: {
  grants: Array<NormalizedGrant<TPayload>>;
  scenarios: readonly VirtualCompanyScenario[];
  asOf: Date;
}): VirtualCompanyMatrixReport {
  const results = input.scenarios.flatMap((scenario) => {
    const resolution = {
      profile: scenario.profile,
      view: buildMatchingProfileView(scenario.profile, input.asOf.toISOString()),
    };
    const teaser = buildProductTeaserSnapshot({
      resolution,
      grants: input.grants,
      asOf: input.asOf,
      limit: Math.max(input.grants.length, 1),
    });
    const dashboard = buildProductDashboardSnapshot({
      resolution,
      grants: input.grants,
      asOf: input.asOf,
      limit: Math.max(input.grants.length, 1),
    });
    return scenario.targets.map((target) => verifyTarget({
      scenario,
      target,
      grants: input.grants,
      dashboardMatches: dashboard.matches,
      visibleGrantIds: new Set(teaser.matches.map((match) => match.grantId)),
    }));
  });
  return {
    status: aggregateStatus(results),
    asOf: input.asOf.toISOString(),
    evaluatedGrantCount: input.grants.length,
    scenarioCount: input.scenarios.length,
    targetCount: results.length,
    results,
  };
}

function verifyTarget<TPayload>(input: {
  scenario: VirtualCompanyScenario;
  target: VirtualCompanyTarget;
  grants: Array<NormalizedGrant<TPayload>>;
  dashboardMatches: MatchCard[];
  visibleGrantIds: ReadonlySet<string>;
}): VirtualCompanyTargetResult {
  const grant = input.grants.find((entry) =>
    entry.grant.source === input.target.source
    && entry.grant.source_id === input.target.sourceId);
  if (!grant) {
    return missingTarget(input.scenario, input.target);
  }

  const manifest = resolveGrantExtractionManifest(grant);
  const grantId = grantKey(grant.grant);
  const rebaselineIssues: string[] = [];
  if (manifest.extractorVersion !== input.target.expectedExtractorVersion) {
    rebaselineIssues.push(
      `분석 버전 변경: expected=${input.target.expectedExtractorVersion}, actual=${manifest.extractorVersion}`,
    );
  }
  if (manifest.revision !== input.target.expectedRevision) {
    rebaselineIssues.push(
      `공고 revision 변경: expected=${input.target.expectedRevision}, actual=${manifest.revision}`,
    );
  }
  if (rebaselineIssues.length > 0) {
    return {
      ...baseResult(input.scenario, input.target),
      grantId,
      title: grant.grant.title,
      extractorVersion: manifest.extractorVersion,
      revision: manifest.revision,
      status: "needs_rebaseline",
      issues: rebaselineIssues,
    };
  }

  const dashboardMatch = input.dashboardMatches.find((match) => match.grantId === grantId);
  const actualTier = dashboardMatch?.recommendationTier ?? null;
  const visibleInUserResults = input.visibleGrantIds.has(grantId);
  const issues: string[] = [];
  if (actualTier !== input.target.expected) {
    issues.push(`tier 불일치: expected=${input.target.expected}, actual=${actualTier ?? "null"}`);
  }
  const shouldBeVisible = input.target.expected !== "not_recommended";
  if (visibleInUserResults !== shouldBeVisible) {
    issues.push(`사용자 결과 노출 불일치: expected=${shouldBeVisible}, actual=${visibleInUserResults}`);
  }
  for (const [dimension, expected] of Object.entries(input.target.expectedCriterionResults ?? {})) {
    const actual = hardCriterionResults(dashboardMatch, dimension);
    if (!actual.includes(expected as VirtualCompanyCriterionResult)) {
      issues.push(`criterion 불일치(${dimension}): expected=${expected}, actual=${actual.join(",") || "missing"}`);
    }
  }

  return {
    scenarioId: input.scenario.id,
    source: input.target.source,
    sourceId: input.target.sourceId,
    grantId,
    title: grant.grant.title,
    expectedTier: input.target.expected,
    actualTier,
    eligibility: dashboardMatch?.eligibility ?? null,
    visibleInUserResults,
    nextQuestionDimension: actionableUnknownDimension(dashboardMatch),
    extractorVersion: manifest.extractorVersion,
    revision: manifest.revision,
    status: issues.length === 0 ? "pass" : "product_regression",
    criterionResults: groupCriterionResults(dashboardMatch),
    issues,
  };
}

function baseResult(
  scenario: VirtualCompanyScenario,
  target: VirtualCompanyTarget,
): VirtualCompanyTargetResult {
  return {
    scenarioId: scenario.id,
    source: target.source,
    sourceId: target.sourceId,
    grantId: null,
    title: null,
    expectedTier: target.expected,
    actualTier: null,
    eligibility: null,
    visibleInUserResults: false,
    nextQuestionDimension: null,
    extractorVersion: null,
    revision: null,
    status: "scenario_stale",
    criterionResults: {},
    issues: [],
  };
}

function missingTarget(
  scenario: VirtualCompanyScenario,
  target: VirtualCompanyTarget,
): VirtualCompanyTargetResult {
  return {
    ...baseResult(scenario, target),
    issues: ["활성·승격 공고 유니버스에서 목표 공고를 찾지 못했습니다."],
  };
}

function hardCriterionResults(
  match: MatchCard | undefined,
  dimension: string,
): string[] {
  const traces = match?.ruleTrace ?? [];
  const hard = traces.flatMap((trace) =>
    trace.dimension === dimension
      && (trace.kind === "required" || trace.kind === "exclusion")
      ? [trace.result]
      : []);
  if (hard.length > 0) return hard;
  return traces.flatMap((trace) =>
    trace.dimension === dimension
      ? [trace.result]
      : []);
}

function groupCriterionResults(
  match: MatchCard | undefined,
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  match?.ruleTrace.forEach((trace) => {
    (grouped[trace.dimension] ??= []).push(trace.result);
  });
  return grouped;
}

function actionableUnknownDimension(match: MatchCard | undefined): string | null {
  return match?.ruleTrace.find((trace) =>
    trace.result === "unknown"
    && (trace.kind === "required" || trace.kind === "exclusion")
    && trace.action?.type === "progressive")?.dimension ?? null;
}

function aggregateStatus(
  results: VirtualCompanyTargetResult[],
): VirtualCompanyMatrixReport["status"] {
  if (results.some((result) => result.status === "product_regression")) return "product_regression";
  if (results.some((result) => result.status === "needs_rebaseline")) return "needs_rebaseline";
  if (results.some((result) => result.status === "scenario_stale")) return "scenario_stale";
  return "pass";
}
