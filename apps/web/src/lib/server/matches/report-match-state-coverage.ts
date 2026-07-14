import { createHash } from "node:crypto";
import { RULESET_VERSION, SCORING_VERSION } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import {
  ProductProfileResolutionError,
  resolveSystemProductCompanyProfile,
} from "../productProfile/resolveProductCompanyProfile";

loadMonorepoEnv();

const asOf = dateArg(readArg("asOf")) ?? new Date();
const scanLimit = boundedInteger(readArg("scanLimit"), 5_000, 1, 5_000);
const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ asOf, limit: scanLimit });
  if (grants.length === scanLimit) {
    throw new Error(`active grant scan reached --scanLimit=${scanLimit}; completeness is not proven`);
  }
  const activeGrantIds = new Set(grants.map((entry) => entry.grant.id).filter((id): id is string => Boolean(id)));
  if (activeGrantIds.size !== grants.length) throw new Error("one or more active grants are missing DB row ids");

  const [companyRows, membershipRows, stateRows] = await Promise.all([
    db.select({ companyId: schema.companies.id }).from(schema.companies),
    db.select({ companyId: schema.userCompany.companyId, userId: schema.userCompany.userId }).from(schema.userCompany),
    db.select({
      companyId: schema.matchState.companyId,
      grantId: schema.matchState.grantId,
      rulesetVer: schema.matchState.rulesetVer,
      scoringVer: schema.matchState.scoringVer,
    }).from(schema.matchState),
  ]);
  const memberships = groupBy(membershipRows, (row) => row.companyId);
  const states = groupBy(stateRows, (row) => row.companyId);
  const coverageHistogram: Record<string, number> = {};
  let noMemberCompanyCount = 0;
  let singleMemberCompanyCount = 0;
  let multiMemberCompanyCount = 0;
  let profileResolvedCompanyCount = 0;
  let profileMissingCompanyCount = 0;
  let noStoredStateCompanyCount = 0;
  let completeActiveCoverageCompanyCount = 0;
  let partialActiveCoverageCompanyCount = 0;
  let currentCompleteCoverageCompanyCount = 0;
  let obsoleteStateCompanyCount = 0;
  let operationalRefreshTargetCompanyCount = 0;
  let operationalRefreshTargetStateCount = 0;
  const operationalRefreshTargetIds: string[] = [];

  for (const company of companyRows) {
    const members = memberships.get(company.companyId) ?? [];
    if (members.length === 0) noMemberCompanyCount += 1;
    else if (members.length === 1) singleMemberCompanyCount += 1;
    else multiMemberCompanyCount += 1;
    const companyStates = states.get(company.companyId) ?? [];
    if (companyStates.length === 0) noStoredStateCompanyCount += 1;
    const activeStates = companyStates.filter((state) => activeGrantIds.has(state.grantId));
    const currentActiveStates = activeStates.filter((state) =>
      state.rulesetVer === RULESET_VERSION && state.scoringVer === SCORING_VERSION);
    const obsoleteStates = companyStates.length - activeStates.length;
    if (obsoleteStates > 0) obsoleteStateCompanyCount += 1;
    if (activeStates.length === activeGrantIds.size) completeActiveCoverageCompanyCount += 1;
    else if (activeStates.length > 0) partialActiveCoverageCompanyCount += 1;
    if (currentActiveStates.length === activeGrantIds.size) currentCompleteCoverageCompanyCount += 1;
    increment(coverageHistogram, coverageBucket(activeStates.length, activeGrantIds.size));

    let profileResolved = false;
    try {
      await resolveSystemProductCompanyProfile({
        companyId: company.companyId,
        asOf: asOf.toISOString(),
      }, {
        companies: repositories.companies,
        enrichmentCache: repositories.enrichmentCache,
      });
      profileResolved = true;
      profileResolvedCompanyCount += 1;
    } catch (error) {
      if (!(error instanceof ProductProfileResolutionError) || error.code !== "company_not_found") throw error;
      profileMissingCompanyCount += 1;
    }
    if (profileResolved && currentActiveStates.length !== activeGrantIds.size) {
      operationalRefreshTargetCompanyCount += 1;
      operationalRefreshTargetStateCount += activeGrantIds.size;
      operationalRefreshTargetIds.push(company.companyId);
    }
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    readOnly: true,
    databaseWriteMode: false,
    companyIdentifiersIncluded: false,
    currentRulesetVer: RULESET_VERSION,
    currentScoringVer: SCORING_VERSION,
    activeGrantCount: activeGrantIds.size,
    totalCompanyCount: companyRows.length,
    membership: {
      noMemberCompanyCount,
      singleMemberCompanyCount,
      multiMemberCompanyCount,
    },
    profile: {
      profileResolvedCompanyCount,
      profileMissingCompanyCount,
    },
    storedState: {
      totalStateCount: stateRows.length,
      noStoredStateCompanyCount,
      completeActiveCoverageCompanyCount,
      partialActiveCoverageCompanyCount,
      currentCompleteCoverageCompanyCount,
      obsoleteStateCompanyCount,
      activeCoverageHistogram: coverageHistogram,
    },
    operationalRefreshScope: {
      scopeHash: createHash("sha256").update(operationalRefreshTargetIds.sort().join("\n")).digest("hex"),
      targetCompanyCount: operationalRefreshTargetCompanyCount,
      plannedStateCount: operationalRefreshTargetStateCount,
      targetDefinition: "resolvable company-scoped profile and incomplete current active ruleset coverage",
      requiresMembership: false,
      includesCompaniesWithoutStoredState: true,
    },
    gates: {
      activeGrantScanComplete: grants.length < scanLimit,
      allCompanyProfilesResolved: profileMissingCompanyCount === 0,
      allOperationalCompaniesCurrent: operationalRefreshTargetCompanyCount === 0,
    },
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function coverageBucket(activeStateCount: number, activeGrantCount: number): string {
  if (activeStateCount === 0) return "none";
  if (activeStateCount === activeGrantCount) return "complete";
  const ratio = activeStateCount / activeGrantCount;
  if (ratio < 0.25) return "partial_lt_25pct";
  if (ratio < 0.5) return "partial_25_49pct";
  if (ratio < 0.9) return "partial_50_89pct";
  return "partial_90_99pct";
}

function groupBy<T>(values: T[], key: (value: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) result.set(key(value), [...(result.get(key(value)) ?? []), value]);
  return result;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid date: ${value}`);
  return parsed;
}
