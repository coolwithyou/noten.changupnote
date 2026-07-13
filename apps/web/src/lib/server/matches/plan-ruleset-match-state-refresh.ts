import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { matchNormalizedGrant, RULESET_VERSION, SCORING_VERSION } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { selectRulesetRefreshTargetCompanyIds, stableSha256 } from "./rulesetMatchStateRefreshSafety";

loadMonorepoEnv();

const asOf = dateArg(readArg("asOf")) ?? new Date();
const scanLimit = boundedInteger(readArg("scanLimit"), 5_000, 1, 5_000);
const includeReviewGrants = process.argv.includes("--include-review-grants");
const outputPath = readArg("output") ? resolve(readArg("output")!) : null;
const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ asOf, limit: scanLimit });
  if (grants.length === scanLimit) {
    throw new Error(`active grant scan reached --scanLimit=${scanLimit}; completeness is not proven`);
  }
  const grantRowIds = grants.map((entry) => entry.grant.id).filter((value): value is string => Boolean(value));
  if (grantRowIds.length !== grants.length) throw new Error("one or more active grants are missing DB row ids");
  const activeGrantIds = new Set(grantRowIds);
  const [allCompanies, memberships, allStateRows] = await Promise.all([
    db.select({ companyId: schema.companies.id }).from(schema.companies),
    db.select({
      companyId: schema.userCompany.companyId,
      userId: schema.userCompany.userId,
    }).from(schema.userCompany),
    db.select({
      companyId: schema.matchState.companyId,
      grantId: schema.matchState.grantId,
      eligibility: schema.matchState.eligibility,
      ruleTrace: schema.matchState.ruleTrace,
      rulesetVer: schema.matchState.rulesetVer,
      scoringVer: schema.matchState.scoringVer,
    }).from(schema.matchState),
  ]);
  const membershipByCompany = new Map<string, string[]>();
  for (const row of memberships) {
    membershipByCompany.set(row.companyId, [...(membershipByCompany.get(row.companyId) ?? []), row.userId]);
  }
  const statesByCompany = new Map<string, typeof allStateRows>();
  for (const row of allStateRows) {
    statesByCompany.set(row.companyId, [...(statesByCompany.get(row.companyId) ?? []), row]);
  }
  const companyIds = selectRulesetRefreshTargetCompanyIds({
    companyIds: allCompanies.map((row) => row.companyId),
    activeGrantIds,
    states: allStateRows,
    rulesetVer: RULESET_VERSION,
    scoringVer: SCORING_VERSION,
  });
  const ambiguousCompanyCount = companyIds.filter((companyId) =>
    (membershipByCompany.get(companyId)?.length ?? 0) !== 1).length;
  if (ambiguousCompanyCount > 0) {
    throw new Error(`ruleset refresh target has ${ambiguousCompanyCount} companies without exactly one member`);
  }
  const targetCompanyIds = new Set(companyIds);
  const existingRows = allStateRows.filter((row) => targetCompanyIds.has(row.companyId));
  const existingByPair = new Map(existingRows.map((row) => [`${row.companyId}:${row.grantId}`, row]));
  const transitions: Record<string, number> = {};
  const transitionsBySource: Record<string, number> = {};
  const transitionsByPreviousRuleset: Record<string, number> = {};
  const restrictiveHardFailDimensions: Record<string, number> = {};
  const transitionReviewGrants = new Map<string, {
    transition: string;
    source: string;
    sourceId: string;
    title: string;
    pairCount: number;
    previousHardFailDimensions: Set<string>;
    plannedHardFailDimensions: Set<string>;
    plannedSourceSpans: Set<string>;
  }>();
  const currentEligibilityCounts: Record<string, number> = {};
  const plannedEligibilityCounts: Record<string, number> = {};
  let missingActiveStateCount = 0;
  let changedEligibilityCount = 0;
  let rulesetOnlyUpdateCount = 0;
  let profileMissingCount = 0;
  let plannedStateCount = 0;
  const profileInputFingerprints: Array<{ companyId: string; profile: unknown }> = [];

  for (const companyId of companyIds) {
    const userId = membershipByCompany.get(companyId)![0]!;
    const profile = await repositories.companies.resolveCompanyProfile({ companyId, userId });
    if (!profile) {
      profileMissingCount += 1;
      continue;
    }
    profileInputFingerprints.push({ companyId, profile });
    for (const entry of grants) {
      const grantId = entry.grant.id!;
      const existing = existingByPair.get(`${companyId}:${grantId}`);
      const next = matchNormalizedGrant(entry, profile);
      const previousEligibility = existing?.eligibility ?? "missing";
      const transition = `${previousEligibility}->${next.eligibility}`;
      increment(transitions, transition);
      increment(transitionsBySource, `${entry.grant.source}:${transition}`);
      increment(
        transitionsByPreviousRuleset,
        `${existing?.rulesetVer ?? "missing"}:${transition}`,
      );
      increment(currentEligibilityCounts, previousEligibility);
      increment(plannedEligibilityCounts, next.eligibility);
      plannedStateCount += 1;
      if (!existing) missingActiveStateCount += 1;
      else if (existing.eligibility !== next.eligibility) changedEligibilityCount += 1;
      else if (existing.rulesetVer !== RULESET_VERSION || existing.scoringVer !== SCORING_VERSION) {
        rulesetOnlyUpdateCount += 1;
      }
      if (previousEligibility !== "ineligible" && next.eligibility === "ineligible") {
        for (const trace of next.rule_trace) {
          if (trace.result === "fail" && (trace.kind === "required" || trace.kind === "exclusion")) {
            increment(restrictiveHardFailDimensions, `${entry.grant.source}:${trace.dimension}`);
          }
        }
      }
      if (transition === "conditional->ineligible" || transition === "ineligible->eligible") {
        const key = `${transition}:${entry.grant.source}:${entry.grant.source_id}`;
        const summary = transitionReviewGrants.get(key) ?? {
          transition,
          source: entry.grant.source,
          sourceId: entry.grant.source_id,
          title: entry.grant.title,
          pairCount: 0,
          previousHardFailDimensions: new Set<string>(),
          plannedHardFailDimensions: new Set<string>(),
          plannedSourceSpans: new Set<string>(),
        };
        summary.pairCount += 1;
        for (const trace of existing?.ruleTrace ?? []) {
          if (isHardFailTraceRecord(trace)) summary.previousHardFailDimensions.add(String(trace.dimension));
        }
        for (const trace of next.rule_trace) {
          if (trace.result !== "fail" || (trace.kind !== "required" && trace.kind !== "exclusion")) continue;
          summary.plannedHardFailDimensions.add(trace.dimension);
          if (trace.source_span) summary.plannedSourceSpans.add(trace.source_span.slice(0, 300));
        }
        transitionReviewGrants.set(key, summary);
      }
    }
  }
  const obsoleteStoredStateCount = existingRows.filter((row) => !activeGrantIds.has(row.grantId)).length;
  const scopeComplete = profileMissingCount === 0 && grants.length < scanLimit;
  const serializedReviewGrants = [...transitionReviewGrants.values()]
    .sort((left, right) => right.pairCount - left.pairCount || left.sourceId.localeCompare(right.sourceId))
    .map((summary) => ({
      transition: summary.transition,
      source: summary.source,
      sourceId: summary.sourceId,
      title: summary.title,
      pairCount: summary.pairCount,
      previousHardFailDimensions: [...summary.previousHardFailDimensions].sort(),
      plannedHardFailDimensions: [...summary.plannedHardFailDimensions].sort(),
      plannedSourceSpans: [...summary.plannedSourceSpans].sort(),
    }));
  const restrictiveReviewGrants = serializedReviewGrants.filter((item) => item.transition === "conditional->ineligible");
  const permissiveReviewGrants = serializedReviewGrants.filter((item) => item.transition === "ineligible->eligible");
  const report = {
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    readOnly: true,
    databaseWriteMode: false,
    companyIdentifiersIncluded: false,
    publicGrantIdentifiersIncluded: true,
    currentRulesetVer: RULESET_VERSION,
    currentScoringVer: SCORING_VERSION,
    scopeHash: createHash("sha256").update(companyIds.join("\n")).digest("hex"),
    evaluationInputHash: stableSha256({
      asOf: asOf.toISOString(),
      profiles: profileInputFingerprints,
      grants: grants.slice().sort((left, right) => left.grant.id!.localeCompare(right.grant.id!)).map((entry) => ({
        grant: entry.grant,
        criteria: entry.criteria,
        extractionManifest: entry.extraction_manifest,
      })),
      existingStates: existingRows.slice().sort((left, right) =>
        left.companyId.localeCompare(right.companyId) || left.grantId.localeCompare(right.grantId)),
    }),
    targetCompanyCount: companyIds.length,
    targetDefinition: "exactly one member, resolvable profile, and incomplete current active ruleset coverage",
    companyWithoutStoredStateCount: companyIds.filter((companyId) => (statesByCompany.get(companyId)?.length ?? 0) === 0).length,
    staleStoredStateCompanyCount: companyIds.filter((companyId) => (statesByCompany.get(companyId) ?? []).some((row) =>
      row.rulesetVer !== RULESET_VERSION || row.scoringVer !== SCORING_VERSION)).length,
    ambiguousCompanyCount,
    profileMissingCount,
    activeGrantCount: grants.length,
    existingStoredStateCount: existingRows.length,
    plannedStateCount,
    missingActiveStateCount,
    obsoleteStoredStateCount,
    changedEligibilityCount,
    rulesetOnlyUpdateCount,
    currentEligibilityCounts,
    plannedEligibilityCounts,
    transitions,
    transitionsBySource,
    transitionsByPreviousRuleset,
    restrictiveHardFailDimensions,
    transitionReviewGrantCount: transitionReviewGrants.size,
    transitionReviewGrantCounts: {
      restrictive: restrictiveReviewGrants.length,
      permissiveToEligible: permissiveReviewGrants.length,
    },
    transitionReviewGrantSamples: [
      ...restrictiveReviewGrants,
      ...permissiveReviewGrants.slice(0, 10),
    ],
    ...(includeReviewGrants ? { transitionReviewGrants: serializedReviewGrants } : {}),
    gates: {
      singleMemberScope: ambiguousCompanyCount === 0,
      profilesResolved: profileMissingCount === 0,
      activeGrantScanComplete: grants.length < scanLimit,
      scopeComplete,
      restrictiveTransitionReviewRequired: (transitions["conditional->ineligible"] ?? 0) > 0 ||
        (transitions["eligible->ineligible"] ?? 0) > 0,
      permissiveEligibleTransitionReviewRequired: (transitions["ineligible->eligible"] ?? 0) > 0 ||
        (transitions["conditional->eligible"] ?? 0) > 0,
      writeAuthorized: false,
      writeReady: false,
    },
    nextStep: scopeComplete
      ? "Review transition counts and obsolete-state policy, then request explicit write authorization."
      : "Resolve incomplete profile or active-grant scope before considering a write.",
  };
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  }
  console.log(JSON.stringify({
    ...report,
    ...(outputPath ? { outputPath } : {}),
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function isHardFailTraceRecord(value: Record<string, unknown>): boolean {
  return value.result === "fail" && (value.kind === "required" || value.kind === "exclusion") &&
    typeof value.dimension === "string";
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}
