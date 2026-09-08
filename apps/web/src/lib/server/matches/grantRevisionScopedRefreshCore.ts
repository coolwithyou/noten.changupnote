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
import { resolveSystemProductCompanyProfile } from "../productProfile/resolveProductCompanyProfile";
import { expandConfirmedGrantComponentIds } from "../ingestion/grantRevisionInvalidation";
import { loadCriterionConfirmations } from "./matchStateRefresh";
import { filterCurrentMatchStateCacheRows } from "./matchStateCacheValidity";

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
  const requestedCompanyIds = input.companyIds
    ? [...new Set(input.companyIds.filter(Boolean))].sort()
    : null;
  const preliminaryGrantIds = (await loadEffectiveGrants(input.db, repositories, requestedGrantIds))
    .map((grant) => grant.grant.id)
    .filter((id): id is string => Boolean(id));
  const preliminaryCompanyRows = await loadCompanyRows(
    input.db,
    requestedCompanyIds,
    input.companyLimit,
  );
  if (input.write && preliminaryCompanyRows.length > input.companyLimit) {
    throw new Error("refusing incomplete grant-scope refresh: increase --companyLimit");
  }
  const inputBindings = input.write
    ? await repositories.matches.captureMatchStateInputBindings({
        companyIds: preliminaryCompanyRows.slice(0, input.companyLimit).map((row) => row.id),
        grantIds: preliminaryGrantIds,
      })
    : [];

  // 캡처 전의 객체는 계산에 재사용하지 않는다. dedup/company/source 변경이 캡처와 입력 읽기
  // 사이에 끼어도 실제 계산은 캡처 이후 snapshot을 사용하고 save guard가 다시 확인한다.
  const [grants, companyRows] = input.write
    ? await Promise.all([
        loadEffectiveGrants(input.db, repositories, requestedGrantIds),
        loadCompanyRows(input.db, requestedCompanyIds, input.companyLimit),
      ])
    : [await loadEffectiveGrants(input.db, repositories, requestedGrantIds), preliminaryCompanyRows];
  const truncated = companyRows.length > input.companyLimit;
  if (input.write && truncated) throw new Error("refusing incomplete grant-scope refresh after binding: increase --companyLimit");
  const companies = [];
  for (const row of companyRows.slice(0, input.companyLimit)) {
    const resolution = await resolveSystemProductCompanyProfile({
      companyId: row.id,
      asOf: input.asOf.toISOString(),
    }, {
      companies: repositories.companies,
      enrichmentCache: repositories.enrichmentCache,
    }, { sourceCorrectionsDb: input.db });
    companies.push({ companyId: row.id, profile: resolution.profile });
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
      staleCount: 0,
    };
  }

  const existingStates = await loadExistingStates(
    input.db,
    repositories,
    companies.map((company) => company.companyId),
    grants.map((grant) => grant.grant.id!),
  );
  let changedCount = 0;
  let unchangedCount = 0;
  let savedCount = 0;
  let staleCount = 0;
  const changeReasons: string[] = [];
  const samples: Array<Record<string, unknown>> = [];
  const confirmationsByCompanyId = new Map(await Promise.all(companies.map(async (company) => [
    company.companyId,
    await loadCriterionConfirmations({ repositories, companyId: company.companyId, grants }) ?? new Map(),
  ] as const)));
  const bindingByPair = new Map(inputBindings.map((binding) => [`${binding.companyId}:${binding.grantId}`, binding]));
  for (const grant of grants) {
    // grant scope의 cardinality 계약(exactly one)을 유지한다. 여러 요청 공고는 같은 캡처와
    // 확인답변 snapshot을 공유하되 계획은 공고별로 독립 생성한다.
    const plan = planScopedMatchStateRefresh({
      scope: "grant",
      companies,
      grants: [grant],
      existingStates,
      confirmationsByCompanyId,
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
        const inputBinding = bindingByPair.get(`${state.companyId}:${state.grantId}`);
        if (!inputBinding) throw new Error(`missing match_state input binding: ${state.companyId}:${state.grantId}`);
        const result = await repositories.matches.saveMatchState({
          companyId: state.companyId,
          grantId: state.grantId,
          match: state.match,
          inputBinding,
          calculationAsOf: input.asOf,
          eligibleFrom: parseDate(state.eligibleFrom),
          eligibleUntil: parseDate(state.eligibleUntil),
        });
        if (result.status === "saved") savedCount += 1;
        else staleCount += 1;
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
    staleCount,
    changeReasonCounts: histogram(changeReasons),
    changedSamples: samples,
  };
}

async function loadEffectiveGrants(
  db: CunoteDb,
  repositories: ReturnType<typeof createDrizzleRepositories<unknown>>,
  requestedGrantIds: string[],
): Promise<Array<NormalizedGrant<unknown>>> {
  const links = await db.select({
    canonicalGrantId: schema.dedupLinks.canonicalGrantId,
    memberGrantId: schema.dedupLinks.memberGrantId,
  }).from(schema.dedupLinks).where(eq(schema.dedupLinks.confirmed, true));
  const effectiveById = new Map<string, NormalizedGrant<unknown>>();
  for (const requestedId of requestedGrantIds) {
    const resolvedId = await resolveGrantRowId(db, requestedId);
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
  return [...effectiveById.values()];
}

async function loadCompanyRows(
  db: CunoteDb,
  requestedCompanyIds: string[] | null,
  companyLimit: number,
): Promise<Array<{ id: string }>> {
  const query = db.select({ id: schema.companies.id }).from(schema.companies);
  return requestedCompanyIds
    ? requestedCompanyIds.length === 0
      ? []
      : query.where(inArray(schema.companies.id, requestedCompanyIds))
        .orderBy(asc(schema.companies.id)).limit(companyLimit + 1)
    : query.orderBy(asc(schema.companies.id)).limit(companyLimit + 1);
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadExistingStates(
  db: CunoteDb,
  repositories: ReturnType<typeof createDrizzleRepositories<unknown>>,
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
    inputBinding: schema.matchState.inputBinding,
    calculationAsOf: schema.matchState.calculationAsOf,
  }).from(schema.matchState).where(and(
    inArray(schema.matchState.companyId, companyIds),
    inArray(schema.matchState.grantId, grantIds),
  ));
  const currentBindings = await repositories.matches.captureMatchStateInputBindings({ companyIds, grantIds });
  return filterCurrentMatchStateCacheRows(rows, currentBindings).map((row) => ({
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
