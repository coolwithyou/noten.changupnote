import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import type { CompanyProfile, GrantCriterion, MatchResult, NormalizedGrant } from "@cunote/contracts";
import {
  calculateMatchTransitionWindow,
  matchNormalizedGrant,
  parseV3AnnotationJsonl,
  planReviewedGrantPublication,
  resolveGrantExtractionManifest,
  RULESET_VERSION,
  SCORING_VERSION,
  type V3GrantAnnotation,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb, type CunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";
import {
  assessRulesetRefreshSafety,
  parseRulesetRefreshManifest,
  reviewGrantKey,
  selectRulesetRefreshTargetCompanyIds,
  stableSha256,
  type RulesetRefreshManifest,
} from "./rulesetMatchStateRefreshSafety";

loadMonorepoEnv();

const manifestPath = resolve(readArg("plan") ?? "tmp/ruleset-v5-match-state-refresh-plan.json");
const reviewsPath = readArg("reviews") ? resolve(readArg("reviews")!) : null;
const expected = parseRulesetRefreshManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
const write = process.argv.includes("--write");
if (write && readArg("confirm") !== "REFRESH_MATCH_STATES_RULESET_V5") {
  throw new Error("--write requires --confirm=REFRESH_MATCH_STATES_RULESET_V5");
}
if (expected.currentRulesetVer !== RULESET_VERSION || expected.currentScoringVer !== SCORING_VERSION) {
  throw new Error("refresh manifest targets a stale ruleset or scoring version");
}

const db = getCunoteDb();
try {
  const snapshot = await buildCurrentSnapshot(db, expected);
  const reviewGate = assessReviews(snapshot.grants, expected.transitionReviewGrants, reviewsPath);
  const safety = assessRulesetRefreshSafety({
    expected,
    actual: snapshot.manifest,
    reviewedGrantKeys: reviewGate.reviewedGrantKeys,
    publishedGrantKeys: reviewGate.publishedGrantKeys,
  });
  if (write && !safety.writeReady) {
    throw new Error(`ruleset refresh write gate failed: ${JSON.stringify(safety)}`);
  }

  let writeResult: { deletedScopeStateCount: number; insertedStateCount: number } | null = null;
  if (write) writeResult = await replaceMatchStates(db, snapshot);

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: write ? "write" : "dry-run",
    databaseWriteMode: write,
    companyIdentifiersIncluded: false,
    manifestPath,
    reviewsPath,
    rulesetVer: RULESET_VERSION,
    scoringVer: SCORING_VERSION,
    scopeHash: snapshot.manifest.scopeHash,
    evaluationInputHash: snapshot.manifest.evaluationInputHash,
    targetCompanyCount: snapshot.manifest.targetCompanyCount,
    activeGrantCount: snapshot.manifest.activeGrantCount,
    existingStoredStateCount: snapshot.manifest.existingStoredStateCount,
    plannedStateCount: snapshot.manifest.plannedStateCount,
    obsoleteStoredStateCount: snapshot.manifest.obsoleteStoredStateCount,
    changedEligibilityCount: snapshot.manifest.changedEligibilityCount,
    rulesetOnlyUpdateCount: snapshot.manifest.rulesetOnlyUpdateCount,
    requiredTransitionReviewGrantCount: unique(expected.transitionReviewGrants.map(reviewGrantKey)).length,
    reviewedGrantCount: reviewGate.reviewedGrantKeys.size,
    publishedReviewedGrantCount: reviewGate.publishedGrantKeys.size,
    safety,
    writeResult,
    nextStep: safety.writeReady
      ? write
        ? "Verify post-write ruleset distribution and runtime match results."
        : "Request explicit DB write authorization before rerunning with --write and the confirmation string."
      : "Complete and publish all transition-impacting independent reviews, then regenerate the plan if inputs changed.",
  }, null, 2));
} finally {
  await closeCunoteDb();
}

interface RefreshSnapshot {
  manifest: RulesetRefreshManifest;
  companyIds: string[];
  companies: Array<{ companyId: string; profile: CompanyProfile }>;
  grants: Array<NormalizedGrant<unknown>>;
  existingStateHash: string;
}

async function buildCurrentSnapshot(db: CunoteDb, expected: RulesetRefreshManifest): Promise<RefreshSnapshot> {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ asOf: new Date(expected.asOf), limit: 5_001 });
  if (grants.length > 5_000) throw new Error("active grant scan exceeded 5,000; completeness is not proven");
  if (grants.some((entry) => !entry.grant.id)) throw new Error("one or more active grants are missing DB row ids");
  const activeGrantIds = new Set(grants.map((entry) => entry.grant.id!));
  const [allCompanies, memberships, allStateRows] = await Promise.all([
    db.select({ companyId: schema.companies.id }).from(schema.companies),
    db.select({ companyId: schema.userCompany.companyId, userId: schema.userCompany.userId }).from(schema.userCompany),
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
  const companyIds = selectRulesetRefreshTargetCompanyIds({
    companyIds: allCompanies.map((row) => row.companyId),
    activeGrantIds,
    states: allStateRows,
    rulesetVer: RULESET_VERSION,
    scoringVer: SCORING_VERSION,
  });
  const ambiguous = companyIds.filter((companyId) => (membershipByCompany.get(companyId)?.length ?? 0) !== 1);
  if (ambiguous.length > 0) throw new Error(`ruleset refresh target has ${ambiguous.length} companies without exactly one member`);
  const targetCompanyIds = new Set(companyIds);
  const existingRows = allStateRows.filter((row) => targetCompanyIds.has(row.companyId));
  const existingByPair = new Map(existingRows.map((row) => [`${row.companyId}:${row.grantId}`, row]));
  const companies: RefreshSnapshot["companies"] = [];
  for (const companyId of companyIds) {
    const userId = membershipByCompany.get(companyId)![0]!;
    const profile = await repositories.companies.resolveCompanyProfile({ companyId, userId });
    if (!profile) throw new Error("one or more ruleset refresh profiles could not be resolved");
    companies.push({ companyId, profile });
  }

  const transitions: Record<string, number> = {};
  const reviewGrants = new Map<string, RulesetRefreshManifest["transitionReviewGrants"][number]>();
  let missingActiveStateCount = 0;
  let changedEligibilityCount = 0;
  let rulesetOnlyUpdateCount = 0;
  for (const company of companies) {
    for (const entry of grants) {
      const existing = existingByPair.get(`${company.companyId}:${entry.grant.id!}`);
      const next = matchNormalizedGrant(entry, company.profile);
      const transition = `${existing?.eligibility ?? "missing"}->${next.eligibility}`;
      increment(transitions, transition);
      if (!existing) missingActiveStateCount += 1;
      else if (existing.eligibility !== next.eligibility) changedEligibilityCount += 1;
      else if (existing.rulesetVer !== RULESET_VERSION || existing.scoringVer !== SCORING_VERSION) {
        rulesetOnlyUpdateCount += 1;
      }
      if (transition === "conditional->ineligible" || transition === "eligible->ineligible" ||
        transition === "ineligible->eligible" || transition === "conditional->eligible") {
        const key = `${transition}:${reviewGrantKey({ source: entry.grant.source, sourceId: entry.grant.source_id })}`;
        reviewGrants.set(key, {
          transition,
          source: entry.grant.source,
          sourceId: entry.grant.source_id,
          title: entry.grant.title,
        });
      }
    }
  }
  const asOf = new Date(expected.asOf).toISOString();
  const manifest = parseRulesetRefreshManifest({
    asOf,
    currentRulesetVer: RULESET_VERSION,
    currentScoringVer: SCORING_VERSION,
    scopeHash: createHash("sha256").update(companyIds.join("\n")).digest("hex"),
    evaluationInputHash: stableSha256({
      asOf,
      profiles: companies.map(({ companyId, profile }) => ({ companyId, profile })),
      grants: grants.slice().sort((left, right) => left.grant.id!.localeCompare(right.grant.id!)).map((entry) => ({
        grant: entry.grant,
        criteria: entry.criteria,
        extractionManifest: entry.extraction_manifest,
      })),
      existingStates: existingRows.slice().sort((left, right) =>
        left.companyId.localeCompare(right.companyId) || left.grantId.localeCompare(right.grantId)),
    }),
    targetCompanyCount: companyIds.length,
    activeGrantCount: grants.length,
    existingStoredStateCount: existingRows.length,
    plannedStateCount: companies.length * grants.length,
    missingActiveStateCount,
    obsoleteStoredStateCount: existingRows.filter((row) => !activeGrantIds.has(row.grantId)).length,
    changedEligibilityCount,
    rulesetOnlyUpdateCount,
    transitions,
    transitionReviewGrants: [...reviewGrants.values()],
  });
  return {
    manifest,
    companyIds,
    companies,
    grants,
    existingStateHash: stableSha256(existingRows.slice().sort((left, right) =>
      left.companyId.localeCompare(right.companyId) || left.grantId.localeCompare(right.grantId))),
  };
}

function assessReviews(
  grants: Array<NormalizedGrant<unknown>>,
  requiredReviews: RulesetRefreshManifest["transitionReviewGrants"],
  reviewsPath: string | null,
): { reviewedGrantKeys: Set<string>; publishedGrantKeys: Set<string> } {
  const reviewedGrantKeys = new Set<string>();
  const publishedGrantKeys = new Set<string>();
  if (!reviewsPath) return { reviewedGrantKeys, publishedGrantKeys };
  const dataset = parseV3AnnotationJsonl(readFileSync(reviewsPath, "utf8"), reviewsPath);
  const required = new Set(requiredReviews.map(reviewGrantKey));
  const grantByKey = new Map(grants.map((entry) => [reviewGrantKey({
    source: entry.grant.source,
    sourceId: entry.grant.source_id,
  }), entry]));
  for (const annotation of dataset.grants.filter((item) => item.labelStatus === "reviewed")) {
    const key = reviewGrantKey(annotation);
    if (!required.has(key)) continue;
    const current = grantByKey.get(key);
    if (!current) throw new Error(`reviewed transition grant is not active: ${key}`);
    const publication = planReviewedGrantPublication(annotation, current);
    reviewedGrantKeys.add(key);
    if (isPublishedReview(annotation, publication.criteria, current)) publishedGrantKeys.add(key);
  }
  return { reviewedGrantKeys, publishedGrantKeys };
}

function isPublishedReview(
  annotation: V3GrantAnnotation,
  reviewedCriteria: GrantCriterion[],
  current: NormalizedGrant<unknown>,
): boolean {
  const manifest = resolveGrantExtractionManifest(current);
  if (!manifest.reviewedAt || !annotation.reviewedAt) return false;
  if (new Date(manifest.reviewedAt).getTime() < new Date(annotation.reviewedAt).getTime()) return false;
  return stableSha256(criteriaFingerprint(current.criteria)) === stableSha256(criteriaFingerprint(reviewedCriteria));
}

function criteriaFingerprint(criteria: GrantCriterion[]): unknown[] {
  return [...criteria].sort((left, right) => String(left.id ?? "").localeCompare(String(right.id ?? ""))).map((criterion) => ({
    id: criterion.id,
    grant_id: criterion.grant_id,
    dimension: criterion.dimension,
    kind: criterion.kind,
    operator: criterion.operator,
    value: criterion.value,
    confidence: criterion.confidence,
    needs_review: criterion.needs_review ?? false,
    parser_version: criterion.parser_version ?? null,
    source_span: criterion.source_span ?? null,
    source_field: criterion.source_field ?? null,
  }));
}

async function replaceMatchStates(
  db: CunoteDb,
  snapshot: RefreshSnapshot,
): Promise<{ deletedScopeStateCount: number; insertedStateCount: number }> {
  const deletedScopeStateCount = snapshot.manifest.existingStoredStateCount;
  const insertedStateCount = snapshot.manifest.plannedStateCount;
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('cunote:ruleset-match-state-refresh'))`);
    const lockedRows = await tx.select({
      companyId: schema.matchState.companyId,
      grantId: schema.matchState.grantId,
      eligibility: schema.matchState.eligibility,
      ruleTrace: schema.matchState.ruleTrace,
      rulesetVer: schema.matchState.rulesetVer,
      scoringVer: schema.matchState.scoringVer,
    }).from(schema.matchState).where(inArray(schema.matchState.companyId, snapshot.companyIds)).for("update");
    const lockedStateHash = stableSha256(lockedRows.sort((left, right) =>
      left.companyId.localeCompare(right.companyId) || left.grantId.localeCompare(right.grantId)));
    if (lockedRows.length !== snapshot.manifest.existingStoredStateCount || lockedStateHash !== snapshot.existingStateHash) {
      throw new Error("match_state scope drifted after preflight");
    }
    await tx.delete(schema.matchState).where(inArray(schema.matchState.companyId, snapshot.companyIds));
    for (const company of snapshot.companies) {
      const values = snapshot.grants.map((entry) => matchStateInsert(company, entry, new Date(snapshot.manifest.asOf)));
      for (const batch of chunks(values, 250)) {
        await tx.insert(schema.matchState).values(batch).onConflictDoUpdate({
          target: [schema.matchState.companyId, schema.matchState.grantId],
          set: {
            eligibility: sql`excluded.eligibility`,
            matchScore: sql`excluded.match_score`,
            fitScore: sql`excluded.fit_score`,
            competitiveness: null,
            valueScore: null,
            ruleTrace: sql`excluded.rule_trace`,
            matchConfidence: sql`excluded.match_confidence`,
            eligibleFrom: sql`excluded.eligible_from`,
            eligibleUntil: sql`excluded.eligible_until`,
            rulesetVer: sql`excluded.ruleset_ver`,
            scoringVer: sql`excluded.scoring_ver`,
            updatedAt: sql`excluded.updated_at`,
          },
        });
      }
    }
    const [currentCount] = await tx.select({ value: count() }).from(schema.matchState).where(and(
      inArray(schema.matchState.companyId, snapshot.companyIds),
      eq(schema.matchState.rulesetVer, RULESET_VERSION),
      eq(schema.matchState.scoringVer, SCORING_VERSION),
    ));
    if (Number(currentCount?.value ?? 0) !== insertedStateCount) {
      throw new Error("post-write match_state count mismatch; rolling back");
    }
  });
  return { deletedScopeStateCount, insertedStateCount };
}

function matchStateInsert(
  company: RefreshSnapshot["companies"][number],
  entry: NormalizedGrant<unknown>,
  asOf: Date,
): typeof schema.matchState.$inferInsert {
  const match = matchNormalizedGrant(entry, company.profile);
  const window = calculateMatchTransitionWindow(match, { asOf });
  return {
    companyId: company.companyId,
    grantId: entry.grant.id!,
    eligibility: match.eligibility,
    matchScore: Math.round(match.fit_score),
    fitScore: Math.round(match.fit_score),
    competitiveness: null,
    valueScore: null,
    ruleTrace: match.rule_trace as unknown as Array<Record<string, unknown>>,
    matchConfidence: matchConfidence(match),
    eligibleFrom: window.eligibleFrom,
    eligibleUntil: window.eligibleUntil,
    rulesetVer: match.ruleset_ver,
    scoringVer: match.scoring_ver,
    updatedAt: new Date(),
  };
}

function matchConfidence(match: MatchResult): number {
  if (match.rule_trace.length === 0) return 0;
  const unknownCount = match.rule_trace.filter((trace) => trace.result === "unknown").length;
  return Math.round(Math.max(0.3, 1 - unknownCount / match.rule_trace.length) * 100) / 100;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function unique(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
