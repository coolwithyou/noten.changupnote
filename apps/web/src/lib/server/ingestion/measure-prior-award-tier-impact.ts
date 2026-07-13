/** 활성 K-Startup prior_award 9개 공고 × 운영 회사 profile scope read-only tier 영향 측정. */
import { and, eq, inArray } from "drizzle-orm";
import { buildKStartupCriteria, matchGrantCriteria, type KStartupAnnouncement } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();
const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<KStartupAnnouncement>({ dialect: "drizzle", client: db });
  const rawRows = await db.select({
    sourceId: schema.grantRaw.sourceId,
    payload: schema.grantRaw.payload,
  }).from(schema.grantRaw)
    .innerJoin(schema.grants, and(
      eq(schema.grantRaw.source, schema.grants.source),
      eq(schema.grantRaw.sourceId, schema.grants.sourceId),
    ))
    .where(and(
      eq(schema.grantRaw.source, "kstartup"),
      inArray(schema.grants.status, ["open", "upcoming"]),
    ));
  const affected = rawRows.flatMap((row) => {
    const announcement = { ...row.payload, pbanc_sn: row.payload.pbanc_sn ?? row.sourceId } as unknown as KStartupAnnouncement;
    const before = buildKStartupCriteria(announcement, row.sourceId);
    const after = buildKStartupCriteria(announcement, row.sourceId, { priorAwardSplit: true });
    return after.some((criterion) => criterion.dimension === "prior_award")
      ? [{ sourceId: row.sourceId, before, after }]
      : [];
  });

  const scopes = await db.selectDistinct({
    companyId: schema.companyProfiles.companyId,
    userId: schema.companyProfiles.userId,
  }).from(schema.companyProfiles);
  const profiles = [];
  for (const scope of scopes) {
    const profile = await repositories.companies.resolveCompanyProfile({
      companyId: scope.companyId,
      ...(scope.userId ? { userId: scope.userId } : {}),
    });
    if (profile) profiles.push(profile);
  }

  const eligibilityTransitions: Record<string, number> = {};
  const tierTransitions: Record<string, number> = {};
  const perGrant = new Map<string, {
    pairCount: number;
    priorKnown: number;
    priorUnknown: number;
    eligibilityTransitions: Record<string, number>;
  }>();
  let priorKnownPairCount = 0;
  let priorUnknownPairCount = 0;
  for (const grant of affected) {
    const summary = {
      pairCount: 0,
      priorKnown: 0,
      priorUnknown: 0,
      eligibilityTransitions: {} as Record<string, number>,
    };
    for (const profile of profiles) {
      const before = matchGrantCriteria(grant.before, profile, { asOf: new Date("2026-07-12T00:00:00.000Z") });
      const after = matchGrantCriteria(grant.after, profile, { asOf: new Date("2026-07-12T00:00:00.000Z") });
      increment(eligibilityTransitions, `${before.eligibility}->${after.eligibility}`);
      increment(tierTransitions, `${before.review_gate?.tier ?? "none"}->${after.review_gate?.tier ?? "none"}`);
      increment(summary.eligibilityTransitions, `${before.eligibility}->${after.eligibility}`);
      const priorTraces = after.rule_trace.filter((trace) => trace.dimension === "prior_award");
      const known = priorTraces.length > 0 && priorTraces.every((trace) => trace.result !== "unknown");
      if (known) {
        priorKnownPairCount += 1;
        summary.priorKnown += 1;
      } else {
        priorUnknownPairCount += 1;
        summary.priorUnknown += 1;
      }
      summary.pairCount += 1;
    }
    perGrant.set(grant.sourceId, summary);
  }

  const profileCohort = {
    total: profiles.length,
    structuredPriorAward: profiles.filter((profile) => Boolean(profile.prior_award_history)).length,
    legacyPriorAwardOnly: profiles.filter((profile) =>
      !profile.prior_award_history && Array.isArray(profile.prior_awards)).length,
    priorAwardConfidenceKnown: profiles.filter((profile) =>
      typeof profile.confidence?.prior_award === "number").length,
  };
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    readOnly: true,
    companyIdentifiersIncluded: false,
    affectedGrantCount: affected.length,
    profileScopeCount: profiles.length,
    evaluatedPairCount: affected.length * profiles.length,
    profileCohort,
    priorKnownPairCount,
    priorUnknownPairCount,
    eligibilityTransitions,
    tierTransitions,
    perGrant: Object.fromEntries(perGrant),
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}
