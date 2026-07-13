import { and, asc, eq, inArray } from "drizzle-orm";
import {
  collapseConfirmedGrantOccurrences,
  planScopedMatchStateRefresh,
  type ExistingMatchStateSnapshot,
} from "@cunote/core";
import type { NormalizedGrant } from "@cunote/contracts";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { expandConfirmedGrantComponentIds } from "../ingestion/grantRevisionInvalidation";

export interface RunGrantRevisionScopedRefreshInput {
  db: CunoteDb;
  grantIds: string[];
  /** 생략하면 전체 회사, 지정하면 publisher가 실제 stale state를 삭제한 회사만 재계산한다. */
  companyIds?: string[];
  companyLimit: number;
  asOf: Date;
  write: boolean;
}

/** 공고 revision 이후 전체 공고 우주가 아니라 해당 canonical grant component만 재계산한다. */
export async function runGrantRevisionScopedRefresh(
  input: RunGrantRevisionScopedRefreshInput,
): Promise<Record<string, unknown>> {
  const requestedGrantIds = [...new Set(input.grantIds.filter(Boolean))].sort();
  if (requestedGrantIds.length === 0) throw new Error("at least one grantId is required");

  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: input.db });
  const links = await input.db.select({
    canonicalGrantId: schema.dedupLinks.canonicalGrantId,
    memberGrantId: schema.dedupLinks.memberGrantId,
  }).from(schema.dedupLinks).where(eq(schema.dedupLinks.confirmed, true));

  const effectiveById = new Map<string, NormalizedGrant<unknown>>();
  for (const requestedId of requestedGrantIds) {
    const resolvedId = await resolveGrantRowId(input.db, requestedId);
    if (!resolvedId) throw new Error(`grant not found: ${requestedId}`);
    const componentIds = expandConfirmedGrantComponentIds([resolvedId], links);
    const entries = (await Promise.all(componentIds.map((id) => repositories.grants.findGrantById(id))))
      .filter((entry): entry is NormalizedGrant<unknown> => entry !== null);
    if (entries.length === 0) throw new Error(`grant not found: ${requestedId}`);
    const [effective] = collapseConfirmedGrantOccurrences(entries, links.map((link) => ({
      canonicalGrantKey: link.canonicalGrantId,
      memberGrantKey: link.memberGrantId,
    })));
    if (!effective?.grant.id) throw new Error(`effective canonical grant not found: ${requestedId}`);
    effectiveById.set(effective.grant.id, effective);
  }
  const grants = [...effectiveById.values()];

  const requestedCompanyIds = input.companyIds
    ? [...new Set(input.companyIds.filter(Boolean))].sort()
    : null;
  const companyQuery = input.db.select({ id: schema.companies.id }).from(schema.companies);
  const companyRows = requestedCompanyIds
    ? requestedCompanyIds.length === 0
      ? []
      : await companyQuery.where(inArray(schema.companies.id, requestedCompanyIds))
        .orderBy(asc(schema.companies.id)).limit(input.companyLimit + 1)
    : await companyQuery.orderBy(asc(schema.companies.id)).limit(input.companyLimit + 1);
  const truncated = companyRows.length > input.companyLimit;
  if (input.write && truncated) throw new Error("refusing incomplete grant-scope refresh: increase --companyLimit");
  const companies = [];
  for (const row of companyRows.slice(0, input.companyLimit)) {
    const profile = await repositories.companies.resolveCompanyProfile({ companyId: row.id });
    if (profile) companies.push({ companyId: row.id, profile });
  }
  if (companies.length === 0) {
    return {
      dryRun: !input.write,
      scope: "grant",
      requestedGrantIds,
      effectiveGrantIds: grants.map((grant) => grant.grant.id),
      candidateComplete: !truncated,
      candidateMode: requestedCompanyIds ? "explicit_stale_state_companies" : "all_companies",
      candidateCompanyCount: 0,
      plannedStateCount: 0,
      changedCount: 0,
      savedCount: 0,
    };
  }

  const existingStates = await loadExistingStates(
    input.db,
    companies.map((company) => company.companyId),
    grants.map((grant) => grant.grant.id!),
  );
  let changedCount = 0;
  let unchangedCount = 0;
  let savedCount = 0;
  const changeReasons: string[] = [];
  const samples: Array<Record<string, unknown>> = [];
  for (const grant of grants) {
    const plan = planScopedMatchStateRefresh({
      scope: "grant",
      companies,
      grants: [grant],
      existingStates,
      asOf: input.asOf,
    });
    changedCount += plan.changedCount;
    unchangedCount += plan.unchangedCount;
    for (const state of plan.states.filter((state) => state.changed)) {
      changeReasons.push(...state.changeReasons);
      if (samples.length < 20) samples.push({
        companyId: state.companyId,
        grantId: state.grantId,
        source: state.source,
        sourceId: state.sourceId,
        eligibility: state.eligibility,
        eligibleUntil: state.eligibleUntil,
        changeReasons: state.changeReasons,
      });
      if (input.write) {
        await repositories.matches.saveMatchState({
          companyId: state.companyId,
          grantId: state.grantId,
          match: state.match,
          eligibleFrom: parseDate(state.eligibleFrom),
          eligibleUntil: parseDate(state.eligibleUntil),
        });
        savedCount += 1;
      }
    }
  }

  return {
    dryRun: !input.write,
    scope: "grant",
    requestedGrantIds,
    effectiveGrantIds: grants.map((grant) => grant.grant.id),
    candidateComplete: !truncated,
    candidateMode: requestedCompanyIds ? "explicit_stale_state_companies" : "all_companies",
    candidateCompanyCount: companies.length,
    candidateGrantCount: grants.length,
    plannedStateCount: companies.length * grants.length,
    changedCount,
    unchangedCount,
    savedCount,
    changeReasonCounts: histogram(changeReasons),
    changedSamples: samples,
  };
}

async function resolveGrantRowId(db: CunoteDb, grantIdOrSourceId: string): Promise<string | null> {
  const rows = UUID_PATTERN.test(grantIdOrSourceId)
    ? await db.select({ id: schema.grants.id }).from(schema.grants)
      .where(eq(schema.grants.id, grantIdOrSourceId)).limit(1)
    : await db.select({ id: schema.grants.id }).from(schema.grants)
      .where(eq(schema.grants.sourceId, grantIdOrSourceId)).limit(2);
  if (rows.length > 1) throw new Error(`ambiguous sourceId; use grant UUID: ${grantIdOrSourceId}`);
  return rows[0]?.id ?? null;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function loadExistingStates(
  db: CunoteDb,
  companyIds: string[],
  grantIds: string[],
): Promise<ExistingMatchStateSnapshot[]> {
  if (companyIds.length === 0 || grantIds.length === 0) return [];
  const rows = await db.select({
    companyId: schema.matchState.companyId,
    grantId: schema.matchState.grantId,
    eligibility: schema.matchState.eligibility,
    fitScore: schema.matchState.fitScore,
    rulesetVer: schema.matchState.rulesetVer,
    scoringVer: schema.matchState.scoringVer,
    ruleTrace: schema.matchState.ruleTrace,
    eligibleFrom: schema.matchState.eligibleFrom,
    eligibleUntil: schema.matchState.eligibleUntil,
  }).from(schema.matchState).where(and(
    inArray(schema.matchState.companyId, companyIds),
    inArray(schema.matchState.grantId, grantIds),
  ));
  return rows.map((row) => ({
    ...row,
    ruleTrace: row.ruleTrace as unknown as ExistingMatchStateSnapshot["ruleTrace"],
    eligibleFrom: row.eligibleFrom?.toISOString() ?? null,
    eligibleUntil: row.eligibleUntil?.toISOString() ?? null,
  }));
}

function parseDate(value: string | null): Date | null {
  return value ? new Date(value) : null;
}
function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
