import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  matchNormalizedGrant,
  normalizeBizInfoProgram,
  parseBizInfoCriteriaDraftJsonl,
  parseV3AnnotationJsonl,
  projectBusinessNumberInitialProfile,
  type BizInfoProgram,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const draftsPath = resolve(readArg("drafts") ?? "tmp/bizinfo-deterministic-drafts.jsonl");
const companiesPath = resolve(
  readArg("companies") ?? "packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl",
);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const drafts = parseBizInfoCriteriaDraftJsonl(readFileSync(draftsPath, "utf8"), draftsPath).drafts;
const companies = parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath).companies.flatMap((record) =>
  record.businessKind === "individual" || record.businessKind === "corporation"
    ? [{
      full: record.profile,
      initial: projectBusinessNumberInitialProfile(record.profile, record.businessKind),
    }]
    : []);

const eligibilityTransitions: Record<string, number> = {};
const tierTransitions: Record<string, number> = {};
const readinessTransitions: Record<string, number> = {};
let falseIneligibleAgainstFullCount = 0;
let unsafeIneligibleAgainstFullViableCount = 0;
let proposedKnownHardTraceCount = 0;
let proposedHardTraceCount = 0;
const perGrant: Record<string, unknown> = {};

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<BizInfoProgram>({ dialect: "drizzle", client: db });
  for (const draft of drafts) {
    const current = await repositories.grants.findGrantById(`bizinfo:${draft.sourceId}`);
    if (!current) throw new Error(`current grant not found: bizinfo:${draft.sourceId}`);
    if (current.grant.title !== draft.title) throw new Error(`draft title is stale: bizinfo:${draft.sourceId}`);
    const proposed = normalizeBizInfoProgram(current.raw.payload, draft.criteria, {
      asOf,
      attachments: current.raw.attachments,
      collectedAt: current.raw.collected_at ? new Date(current.raw.collected_at) : asOf,
      model: draft.extractorVersion,
      requiredDocuments: draft.requiredDocuments,
    });
    const grantEligibilityTransitions: Record<string, number> = {};
    const grantTierTransitions: Record<string, number> = {};
    for (const company of companies) {
      const currentInitial = matchNormalizedGrant(current, company.initial);
      const proposedInitial = matchNormalizedGrant(proposed, company.initial);
      const proposedFull = matchNormalizedGrant(proposed, company.full);
      increment(eligibilityTransitions, `${currentInitial.eligibility}->${proposedInitial.eligibility}`);
      increment(grantEligibilityTransitions, `${currentInitial.eligibility}->${proposedInitial.eligibility}`);
      increment(tierTransitions, `${currentInitial.review_gate?.tier ?? "none"}->${proposedInitial.review_gate?.tier ?? "none"}`);
      increment(grantTierTransitions, `${currentInitial.review_gate?.tier ?? "none"}->${proposedInitial.review_gate?.tier ?? "none"}`);
      increment(
        readinessTransitions,
        `${currentInitial.quality.extractionReadiness}->${proposedInitial.quality.extractionReadiness}`,
      );
      if (proposedInitial.eligibility === "ineligible" && proposedFull.eligibility === "eligible") {
        falseIneligibleAgainstFullCount += 1;
      }
      if (proposedInitial.eligibility === "ineligible" && proposedFull.eligibility !== "ineligible") {
        unsafeIneligibleAgainstFullViableCount += 1;
      }
      for (const trace of proposedInitial.rule_trace) {
        if (trace.kind !== "required" && trace.kind !== "exclusion") continue;
        proposedHardTraceCount += 1;
        if (trace.result !== "unknown") proposedKnownHardTraceCount += 1;
      }
    }
    perGrant[draft.sourceId] = {
      pairCount: companies.length,
      currentCriterionCount: current.criteria.length,
      proposedCriterionCount: draft.criteria.length,
      proposedDimensions: [...new Set(draft.criteria.map((criterion) => criterion.dimension))],
      eligibilityTransitions: grantEligibilityTransitions,
      tierTransitions: grantTierTransitions,
    };
  }

  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    readOnly: true,
    databaseWriteMode: false,
    externalCalls: false,
    operationalAccuracyEvidence: false,
    draftKind: "deterministic_unreviewed",
    draftCount: drafts.length,
    companyCount: companies.length,
    evaluatedPairCount: drafts.length * companies.length,
    proposedCriterionCount: drafts.reduce((sum, draft) => sum + draft.criteria.length, 0),
    eligibilityTransitions,
    tierTransitions,
    readinessTransitions,
    proposedHardConditionKnownRate: ratio(proposedKnownHardTraceCount, proposedHardTraceCount),
    falseIneligibleAgainstFullCount,
    unsafeIneligibleAgainstFullViableCount,
    gates: {
      noFalseIneligibleAgainstFull: falseIneligibleAgainstFullCount === 0,
      noUnsafeIneligibleAgainstFullViable: unsafeIneligibleAgainstFullViableCount === 0,
      independentHumanReviewRequired: true,
      operationalReady: false,
    },
    perGrant,
    reminders: [
      "deterministic drafts are review candidates, not operational accuracy evidence",
      "recommendation remains review-gated until independent reviewed publication",
      "company fixtures are synthetic and contain no production company identifiers",
    ],
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function increment(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 10_000) / 10_000;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}
