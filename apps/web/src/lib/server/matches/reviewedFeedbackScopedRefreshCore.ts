import { and, asc, eq, inArray } from "drizzle-orm";
import { planScopedMatchStateRefresh, type ExistingMatchStateSnapshot, type ScopedMatchRefreshScope } from "@cunote/core";
import type { NormalizedGrant } from "@cunote/contracts";
import type { CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { resolveSystemProductCompanyProfile } from "../productProfile/resolveProductCompanyProfile";

export interface RunReviewedFeedbackScopedRefreshInput {
  db: CunoteDb;
  reviewerFeedbackId: string;
  limit: number;
  asOf: Date;
  write: boolean;
  correctionApplied: boolean;
}

export async function runReviewedFeedbackScopedRefresh(
  input: RunReviewedFeedbackScopedRefreshInput,
): Promise<Record<string, unknown>> {
  if (input.write && !input.correctionApplied) {
    throw new Error("write requires correctionApplied=true");
  }
  const context = await loadReviewedFeedbackContext(input.db, input.reviewerFeedbackId);
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: input.db });
  if (context.scope === "none" || context.scope === "manual") {
    return {
      dryRun: !input.write,
      reviewerFeedbackId: input.reviewerFeedbackId,
      reviewedFeedbackId: context.reviewedFeedbackId,
      scope: context.scope,
      savedCount: 0,
      reason: context.scope === "manual" ? "manual correction workflow required" : "no match-state refresh required",
    };
  }

  const loaded = await loadScopeCandidates({
    db: input.db,
    repositories,
    scope: context.scope,
    companyId: context.companyId,
    grantId: context.grantId,
    limit: input.limit,
    asOf: input.asOf,
  });
  if (input.write && loaded.truncated) throw new Error("refusing incomplete scoped refresh: increase --limit");
  const existingStates = await loadExistingStates(input.db, loaded.companies.map((item) => item.companyId), loaded.grants);
  const plan = planScopedMatchStateRefresh({
    scope: context.scope,
    companies: loaded.companies,
    grants: loaded.grants,
    existingStates,
    asOf: input.asOf,
  });
  const changedStates = plan.states.filter((state) => state.changed);
  let savedCount = 0;
  if (input.write) {
    for (const state of changedStates) {
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
  return {
    dryRun: !input.write,
    correctionApplied: input.correctionApplied,
    reviewerFeedbackId: input.reviewerFeedbackId,
    reviewedFeedbackId: context.reviewedFeedbackId,
    scope: context.scope,
    refreshReason: context.refreshReason,
    companyId: context.companyId,
    grantId: context.grantId,
    candidateComplete: !loaded.truncated,
    candidateCompanyCount: loaded.companies.length,
    candidateGrantCount: loaded.grants.length,
    plannedStateCount: plan.stateCount,
    changedCount: plan.changedCount,
    unchangedCount: plan.unchangedCount,
    savedCount,
    changeReasonCounts: histogram(changedStates.flatMap((state) => state.changeReasons)),
    changedSamples: changedStates.slice(0, 20).map((state) => ({
      companyId: state.companyId,
      grantId: state.grantId,
      source: state.source,
      sourceId: state.sourceId,
      eligibility: state.eligibility,
      changeReasons: state.changeReasons,
    })),
  };
}

async function loadReviewedFeedbackContext(db: CunoteDb, reviewerFeedbackId: string): Promise<{
  reviewedFeedbackId: string;
  scope: ScopedMatchRefreshScope;
  refreshReason: string;
  companyId: string;
  grantId: string;
}> {
  const [review] = await db.select({ actor: schema.feedback.actor, value: schema.feedback.value })
    .from(schema.feedback).where(eq(schema.feedback.id, reviewerFeedbackId)).limit(1);
  if (!review || review.actor !== "reviewer") throw new Error("reviewer feedback record not found");
  if (review.value.reviewDecision !== "accepted" || review.value.evaluationCandidate !== true) {
    throw new Error("reviewer feedback must be accepted and evaluationCandidate=true");
  }
  const reviewedFeedbackId = requiredString(review.value.reviewedFeedbackId, "reviewedFeedbackId");
  const scope = refreshScope(review.value.refreshScope);
  const refreshReason = requiredString(review.value.refreshReason, "refreshReason");
  const [original] = await db.select({ actor: schema.feedback.actor, value: schema.feedback.value })
    .from(schema.feedback).where(eq(schema.feedback.id, reviewedFeedbackId)).limit(1);
  if (!original || original.actor !== "user") throw new Error("reviewed user feedback not found");
  return {
    reviewedFeedbackId,
    scope,
    refreshReason,
    companyId: requiredString(original.value.companyId, "companyId"),
    grantId: requiredString(original.value.grantId, "grantId"),
  };
}

async function loadScopeCandidates(input: {
  db: CunoteDb;
  repositories: ReturnType<typeof createDrizzleRepositories<unknown>>;
  scope: Exclude<ScopedMatchRefreshScope, "none" | "manual">;
  companyId: string;
  grantId: string;
  limit: number;
  asOf: Date;
}): Promise<{
  companies: Array<{ companyId: string; profile: Awaited<ReturnType<typeof input.repositories.companies.resolveCompanyProfile>> & {} }>;
  grants: Array<NormalizedGrant<unknown>>;
  truncated: boolean;
}> {
  if (input.scope === "company") {
    const profile = await requiredCompanyProfile(input.repositories, input.companyId, input.asOf);
    const candidates = await input.repositories.grants.listActiveGrants({ limit: input.limit + 1, asOf: input.asOf });
    return {
      companies: [{ companyId: input.companyId, profile }],
      grants: candidates.slice(0, input.limit),
      truncated: candidates.length > input.limit,
    };
  }
  const grant = await input.repositories.grants.findGrantById(input.grantId);
  if (!grant) throw new Error(`grant not found: ${input.grantId}`);
  if (input.scope === "pair") {
    const profile = await requiredCompanyProfile(input.repositories, input.companyId, input.asOf);
    return { companies: [{ companyId: input.companyId, profile }], grants: [grant], truncated: false };
  }
  const rows = await input.db.select({ id: schema.companies.id }).from(schema.companies)
    .orderBy(asc(schema.companies.id)).limit(input.limit + 1);
  const companyRows = rows.slice(0, input.limit);
  const companies = [];
  for (const row of companyRows) {
    const profile = await requiredCompanyProfile(input.repositories, row.id, input.asOf);
    companies.push({ companyId: row.id, profile });
  }
  return { companies, grants: [grant], truncated: rows.length > input.limit };
}

async function requiredCompanyProfile(
  repositories: ReturnType<typeof createDrizzleRepositories<unknown>>,
  companyId: string,
  asOf: Date,
) {
  return (await resolveSystemProductCompanyProfile({
    companyId,
    asOf: asOf.toISOString(),
  }, {
    companies: repositories.companies,
    enrichmentCache: repositories.enrichmentCache,
  })).profile;
}

async function loadExistingStates(
  db: CunoteDb,
  companyIds: string[],
  grants: Array<NormalizedGrant<unknown>>,
): Promise<ExistingMatchStateSnapshot[]> {
  const grantIds = grants.map((grant) => grant.grant.id).filter((id): id is string => Boolean(id));
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
    companyId: row.companyId,
    grantId: row.grantId,
    eligibility: row.eligibility,
    fitScore: row.fitScore,
    rulesetVer: row.rulesetVer,
    scoringVer: row.scoringVer,
    ruleTrace: row.ruleTrace as unknown as ExistingMatchStateSnapshot["ruleTrace"],
    eligibleFrom: row.eligibleFrom?.toISOString() ?? null,
    eligibleUntil: row.eligibleUntil?.toISOString() ?? null,
  }));
}

function refreshScope(value: unknown): ScopedMatchRefreshScope {
  if (value === "none" || value === "pair" || value === "company" || value === "grant" || value === "manual") return value;
  throw new Error("invalid refreshScope");
}
function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
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
