/**
 * prior_award P5 활성화 전 운영 read-only 감사.
 *
 * 사용: pnpm audit:prior-award-readiness
 * - DB write/외부 API/LLM 호출 없음.
 * - 활성 K-Startup raw payload를 현재 normalizer의 flag off/on으로 메모리에서만 비교한다.
 */
import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { CompanyProfile, GrantCriterion, PriorAwardCriterionValue } from "@cunote/contracts";
import {
  buildKStartupCriteria,
  matchGrantCriteria,
  validateGrantCriteriaContract,
  type KStartupAnnouncement,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { assessPriorAwardIndependentReview } from "./priorAwardReviewGate";

loadMonorepoEnv();

const ACTIVE_STATUSES = ["open", "upcoming"] as const;
const PRIOR_AWARD_SIGNAL = /중복\s*(?:입주|지원|수혜|선정|참여)|동일\s*(?:한\s*)?(?:사업|과제)|유사\s*(?:사업|지원)|타\s*부처|수료|사관학교|start[\s-]*up\s*nest|스타트업\s*네스트/i;

const db = getCunoteDb();
try {
  const priorRows = await db.select({
    id: schema.grantCriteria.id,
    grantId: schema.grantCriteria.grantId,
    dimension: schema.grantCriteria.dimension,
    operator: schema.grantCriteria.operator,
    value: schema.grantCriteria.value,
    kind: schema.grantCriteria.kind,
    confidence: schema.grantCriteria.confidence,
    sourceSpan: schema.grantCriteria.sourceSpan,
    sourceField: schema.grantCriteria.sourceField,
    needsReview: schema.grantCriteria.needsReview,
    parserVersion: schema.grantCriteria.parserVersion,
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
    status: schema.grants.status,
  }).from(schema.grantCriteria)
    .innerJoin(schema.grants, eq(schema.grantCriteria.grantId, schema.grants.id))
    .where(eq(schema.grantCriteria.dimension, "prior_award"));

  const activeOtherRows = await db.select({
    source: schema.grants.source,
    sourceId: schema.grants.sourceId,
    sourceSpan: schema.grantCriteria.sourceSpan,
    value: schema.grantCriteria.value,
  }).from(schema.grantCriteria)
    .innerJoin(schema.grants, eq(schema.grantCriteria.grantId, schema.grants.id))
    .where(and(
      eq(schema.grantCriteria.dimension, "other"),
      inArray(schema.grants.status, [...ACTIVE_STATUSES]),
    ));

  const activeKStartupRows = await db.select({
    sourceId: schema.grantRaw.sourceId,
    payload: schema.grantRaw.payload,
  }).from(schema.grantRaw)
    .innerJoin(schema.grants, and(
      eq(schema.grantRaw.source, schema.grants.source),
      eq(schema.grantRaw.sourceId, schema.grants.sourceId),
    ))
    .where(and(
      eq(schema.grantRaw.source, "kstartup"),
      inArray(schema.grants.status, [...ACTIVE_STATUSES]),
    ));

  const currentContractIssues = priorRows.map((row) => ({
    row,
    issues: validateGrantCriteriaContract([toCriterion(row)]),
  })).filter((entry) => entry.issues.length > 0);
  const activePriorRows = priorRows.filter((row) => ACTIVE_STATUSES.includes(row.status as typeof ACTIVE_STATUSES[number]));
  const legacyExclusions = activePriorRows.filter((row) =>
    row.kind === "exclusion" && !hasV2Scope(row.value));
  const activeOtherCandidates = activeOtherRows.filter((row) =>
    PRIOR_AWARD_SIGNAL.test(row.sourceSpan ?? note(row.value)));

  let enabledCriterionCount = 0;
  let enabledContractIssueCount = 0;
  let affectedGrantCount = 0;
  let offCriterionCount = 0;
  let parseFailureCount = 0;
  const scopeCounts: Record<string, number> = {};
  const reviewCandidates: Array<{
    grantId: string;
    sourceFixture: string;
    criterionId: string;
    operator: GrantCriterion["operator"];
    sourceId: string;
    title: string;
    sourceSpan: string | null;
    value: unknown;
    riskFlags: string[];
  }> = [];
  const enabledPriorCriteria: GrantCriterion[] = [];
  for (const row of activeKStartupRows) {
    try {
      const announcement = { ...row.payload, pbanc_sn: row.payload.pbanc_sn ?? row.sourceId } as unknown as KStartupAnnouncement;
      const inputSha256 = createHash("sha256")
        .update(JSON.stringify({ sourceId: row.sourceId, exclusion: announcement.aply_excl_trgt_ctnt ?? null }))
        .digest("hex");
      const off = buildKStartupCriteria(announcement, row.sourceId);
      const enabled = buildKStartupCriteria(announcement, row.sourceId, { priorAwardSplit: true });
      const offPrior = off.filter((criterion) => criterion.dimension === "prior_award");
      const enabledPrior = enabled.filter((criterion) => criterion.dimension === "prior_award");
      offCriterionCount += offPrior.length;
      enabledCriterionCount += enabledPrior.length;
      enabledPriorCriteria.push(...enabledPrior);
      enabledContractIssueCount += enabledPrior.reduce(
        (count, criterion) => count + validateGrantCriteriaContract([criterion]).length,
        0,
      );
      if (enabledPrior.length > offPrior.length) affectedGrantCount += 1;
      for (const criterion of enabledPrior) {
        const scope = typeof criterion.value === "object" && criterion.value && "scope" in criterion.value
          ? String((criterion.value as { scope?: unknown }).scope)
          : "missing";
        scopeCounts[scope] = (scopeCounts[scope] ?? 0) + 1;
        reviewCandidates.push({
          grantId: `kstartup:${row.sourceId}`,
          sourceFixture: `prior-award-p5:kstartup:${row.sourceId}:${inputSha256}`,
          criterionId: criterion.id ?? `kstartup:${row.sourceId}:prior-award-unknown`,
          operator: criterion.operator,
          sourceId: row.sourceId,
          title: typeof announcement.biz_pbanc_nm === "string" ? announcement.biz_pbanc_nm : row.sourceId,
          sourceSpan: criterion.source_span ?? null,
          value: criterion.value,
          riskFlags: candidateRiskFlags(criterion.source_span ?? ""),
        });
      }
    } catch {
      parseFailureCount += 1;
    }
  }

  const riskyCandidateCount = reviewCandidates.filter((candidate) => candidate.riskFlags.length > 0).length;
  const falsePassMatrix = assessFalsePassMatrix(enabledPriorCriteria);
  const automatedQualityGatePassed =
    enabledContractIssueCount === 0 &&
    parseFailureCount === 0 &&
    riskyCandidateCount === 0 &&
    falsePassMatrix.failureCount === 0;
  const annotationsPath = readArg("annotations");
  if (annotationsPath && !existsSync(annotationsPath)) throw new Error(`annotations file not found: ${annotationsPath}`);
  const review = assessPriorAwardIndependentReview(
    reviewCandidates,
    annotationsPath ? readFileSync(annotationsPath, "utf8") : null,
    annotationsPath ?? undefined,
  );
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    currentCriteria: {
      total: priorRows.length,
      active: activePriorRows.length,
      byKindOperator: histogram(priorRows, (row) => `${row.kind}/${row.operator}`),
      byParserVersion: histogram(priorRows, (row) => row.parserVersion ?? "null"),
      activeLegacyExclusionCount: legacyExclusions.length,
      contractIssueRowCount: currentContractIssues.length,
      contractIssueMessages: histogram(currentContractIssues.flatMap((entry) => entry.issues), (issue) => issue.message),
    },
    activeResidualCandidates: {
      otherTextOnlyPriorAwardSignalCount: activeOtherCandidates.length,
      bySource: histogram(activeOtherCandidates, (row) => row.source),
    },
    kstartupDryRun: {
      activeRawGrantCount: activeKStartupRows.length,
      defaultOffPriorAwardCriterionCount: offCriterionCount,
      enabledPriorAwardCriterionCount: enabledCriterionCount,
      enabledContractIssueCount,
      affectedGrantCount,
      scopeCounts,
      parseFailureCount,
      riskyCandidateCount,
      automatedQualityGatePassed,
      falsePassMatrix,
      independentHumanReviewRequiredCount: reviewCandidates.length,
      independentHumanReviewAcceptedCount: review.acceptedCriterionCount,
      independentHumanReviewedGrantCount: review.reviewedGrantCount,
      annotationsPath,
      autoActivationReady:
        automatedQualityGatePassed &&
        reviewCandidates.length > 0 &&
        review.acceptedCriterionCount === reviewCandidates.length,
      reviewCandidates,
    },
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function toCriterion(row: {
  id: string;
  grantId: string;
  dimension: GrantCriterion["dimension"];
  operator: GrantCriterion["operator"];
  value: Record<string, unknown>;
  kind: GrantCriterion["kind"];
  confidence: number;
  sourceSpan: string | null;
  sourceField: string | null;
  needsReview: boolean;
  parserVersion: string | null;
}): GrantCriterion {
  return {
    id: row.id,
    grant_id: row.grantId,
    dimension: row.dimension,
    operator: row.operator,
    value: row.value,
    kind: row.kind,
    confidence: row.confidence,
    ...(row.sourceSpan ? { source_span: row.sourceSpan } : {}),
    ...(row.sourceField ? { source_field: row.sourceField } : {}),
    needs_review: row.needsReview,
    ...(row.parserVersion ? { parser_version: row.parserVersion } : {}),
  };
}

function hasV2Scope(value: Record<string, unknown>): boolean {
  return value.scope === "self" || value.scope === "program" || value.scope === "program_type";
}

function note(value: Record<string, unknown>): string {
  return typeof value.note === "string" ? value.note : "";
}

function candidateRiskFlags(span: string): string[] {
  const flags: string[] = [];
  if (span.length > 300) flags.push("overbroad_span");
  if (PRIOR_AWARD_SIGNAL.test(span) && /허위|체납|제재|지원제외업종|성년후견|부적합/.test(span)) {
    flags.push("mixed_unrelated_exclusion");
  }
  return flags;
}

function assessFalsePassMatrix(criteria: GrantCriterion[]): {
  criterionCount: number;
  checkedEvaluationCount: number;
  failureCount: number;
  failures: Array<{ criterionId: string | null; scenario: string; expected: string; actual: string }>;
} {
  const failures: Array<{ criterionId: string | null; scenario: string; expected: string; actual: string }> = [];
  for (const criterion of criteria) {
    const value = criterion.value as PriorAwardCriterionValue;
    const scenarios: Array<{ name: string; expected: "unknown" | "pass" | "fail"; profile: CompanyProfile }> = [
      { name: "unanswered", expected: "unknown", profile: {} },
      { name: "explicit_clean", expected: "pass", profile: priorAwardScenarioProfile(value, false) },
      { name: "explicit_hit", expected: "fail", profile: priorAwardScenarioProfile(value, true) },
    ];
    for (const scenario of scenarios) {
      const actual = matchGrantCriteria([criterion], scenario.profile, {
        asOf: new Date("2026-07-12T00:00:00.000Z"),
      }).rule_trace[0]?.result ?? "missing";
      if (actual !== scenario.expected) failures.push({
        criterionId: criterion.id ?? null,
        scenario: scenario.name,
        expected: scenario.expected,
        actual,
      });
    }
  }
  return {
    criterionCount: criteria.length,
    checkedEvaluationCount: criteria.length * 3,
    failureCount: failures.length,
    failures,
  };
}

function priorAwardScenarioProfile(value: PriorAwardCriterionValue, hit: boolean): CompanyProfile {
  const history: NonNullable<CompanyProfile["prior_award_history"]> = {
    records: [],
    known_programs: [],
    known_program_types: [],
  };
  if (value.scope === "self") {
    if (value.channel === "incubation_tenancy") history.has_incubation_tenancy = hit;
    else history.self_flags = { [value.self_kind ?? "current_similar"]: hit };
  } else {
    const programs = value.programs ?? [];
    if (value.scope === "program_type") history.known_program_types = [...programs];
    else history.known_programs = [...programs];
    if (hit) history.records = programs.map((program) => ({
      program,
      state: value.states?.[0] ?? (value.scope === "program_type" ? "graduated" : "completed"),
      ...(value.within ? { year: 2026 } : {}),
    }));
  }
  return {
    prior_award_history: history,
    prior_awards: history.records.flatMap((record) => record.program ? [record.program] : []),
    confidence: { prior_award: 0.6 },
  };
}

function readArg(name: string): string | null {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length) ?? null;
}

function histogram<T>(rows: T[], key: (row: T) => string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) {
    const value = key(row);
    result[value] = (result[value] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}
