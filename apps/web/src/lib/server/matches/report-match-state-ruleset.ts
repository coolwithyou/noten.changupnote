import { and, count, countDistinct, inArray, isNotNull, max, min, ne, or } from "drizzle-orm";
import { RULESET_VERSION, SCORING_VERSION } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";

loadMonorepoEnv();

const db = getCunoteDb();
try {
  const rows = await db.select({
    rulesetVer: schema.matchState.rulesetVer,
    scoringVer: schema.matchState.scoringVer,
    stateCount: count(),
    companyCount: countDistinct(schema.matchState.companyId),
    grantCount: countDistinct(schema.matchState.grantId),
    oldestUpdatedAt: min(schema.matchState.updatedAt),
    newestUpdatedAt: max(schema.matchState.updatedAt),
  }).from(schema.matchState).groupBy(
    schema.matchState.rulesetVer,
    schema.matchState.scoringVer,
  );
  const totalStateCount = rows.reduce((sum, row) => sum + row.stateCount, 0);
  const currentStateCount = rows
    .filter((row) => row.rulesetVer === RULESET_VERSION && row.scoringVer === SCORING_VERSION)
    .reduce((sum, row) => sum + row.stateCount, 0);
  const staleStateCount = totalStateCount - currentStateCount;
  const staleCompanyRows = await db.selectDistinct({
    companyId: schema.matchState.companyId,
  }).from(schema.matchState).where(or(
    ne(schema.matchState.rulesetVer, RULESET_VERSION),
    ne(schema.matchState.scoringVer, SCORING_VERSION),
  ));
  const staleCompanyIds = staleCompanyRows.map((row) => row.companyId);
  const [membershipRows, userProfileRows] = staleCompanyIds.length > 0
    ? await Promise.all([
      db.select({
        companyId: schema.userCompany.companyId,
        userId: schema.userCompany.userId,
      }).from(schema.userCompany).where(inArray(schema.userCompany.companyId, staleCompanyIds)),
      db.selectDistinct({
        companyId: schema.companyProfiles.companyId,
        userId: schema.companyProfiles.userId,
      }).from(schema.companyProfiles).where(and(
        inArray(schema.companyProfiles.companyId, staleCompanyIds),
        isNotNull(schema.companyProfiles.userId),
      )),
    ])
    : [[], []];
  const membershipCounts = countsByCompany(staleCompanyIds, membershipRows.map((row) => row.companyId));
  const userProfileCompanyIds = new Set(userProfileRows.map((row) => row.companyId));
  const multiMemberCompanyIds = new Set([...membershipCounts.entries()]
    .filter(([, memberCount]) => memberCount > 1)
    .map(([companyId]) => companyId));
  const ambiguousCompanyCount = [...userProfileCompanyIds]
    .filter((companyId) => multiMemberCompanyIds.has(companyId)).length;
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    companyIdentifiersIncluded: false,
    currentRulesetVer: RULESET_VERSION,
    currentScoringVer: SCORING_VERSION,
    totalStateCount,
    currentStateCount,
    staleStateCount,
    refreshRequired: staleStateCount > 0,
    scopeAudit: {
      staleCompanyCount: staleCompanyIds.length,
      noMemberCompanyCount: [...membershipCounts.values()].filter((value) => value === 0).length,
      singleMemberCompanyCount: [...membershipCounts.values()].filter((value) => value === 1).length,
      multiMemberCompanyCount: multiMemberCompanyIds.size,
      companyWithUserScopedProfileCount: userProfileCompanyIds.size,
      ambiguousMultiMemberUserProfileCompanyCount: ambiguousCompanyCount,
      bulkRefreshScopeSafe: ambiguousCompanyCount === 0,
      reason: ambiguousCompanyCount > 0
        ? "company-level match_state cannot safely choose among multiple user-scoped profile overrides"
        : "no multi-member company with user-scoped profile overrides was found in the stale scope",
    },
    groups: rows.map((row) => ({
      ...row,
      current: row.rulesetVer === RULESET_VERSION && row.scoringVer === SCORING_VERSION,
      oldestUpdatedAt: row.oldestUpdatedAt?.toISOString() ?? null,
      newestUpdatedAt: row.newestUpdatedAt?.toISOString() ?? null,
    })),
    nextStep: staleStateCount > 0
      ? ambiguousCompanyCount > 0
        ? "Define company-level versus user-level profile ownership before any bulk match_state refresh."
        : "Run a scoped dry-run refresh, review transitions, then request write approval."
      : totalStateCount === 0
        ? "No stored match_state rows exist; live matching still uses the current ruleset."
        : "Stored match_state rows already use the current ruleset and scoring version.",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function countsByCompany(companyIds: string[], rows: string[]): Map<string, number> {
  const result = new Map(companyIds.map((companyId) => [companyId, 0]));
  for (const companyId of rows) result.set(companyId, (result.get(companyId) ?? 0) + 1);
  return result;
}
