import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  classifyGrantAudience,
  evaluateGrantAudience,
  parseGrantAudienceAnnotationJsonl,
  parseV3AnnotationJsonl,
  resolveGrantExtractionManifest,
  simulateBusinessAudienceFilter,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();
const asOf = dateArg(readArg("asOf")) ?? new Date();
const limit = boundedInteger(readArg("limit"), 2_000, 1, 5_000);
const companiesPath = resolve(readArg("companies") ?? "packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl");
const annotationsPath = resolve(readArg("annotations") ?? "tmp/grant-audience-draft-annotations.jsonl");
const companies = parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath).companies.flatMap((record) =>
  record.businessKind === "individual" || record.businessKind === "corporation"
    ? [{ companyId: record.companyId, businessKind: record.businessKind, profile: record.profile }]
    : []);

const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ asOf, limit });
  const simulation = simulateBusinessAudienceFilter({ grants, companies, asOf });
  const predictions = grants.map((grant) => {
    const classification = classifyGrantAudience({
      source: grant.grant.source,
      title: grant.grant.title,
      payload: grant.raw.payload,
    });
    return {
      grantId: `${grant.grant.source}:${grant.grant.source_id}`,
      predictedAudience: classification.audience,
      safeToExcludeFromBusinessMatching: classification.safeToExcludeFromBusinessMatching,
    };
  });
  const annotations = existsSync(annotationsPath)
    ? parseGrantAudienceAnnotationJsonl(readFileSync(annotationsPath, "utf8"), annotationsPath)
    : [];
  const activeRevisionByGrant = new Map(grants.map((grant) => [
    `${grant.grant.source}:${grant.grant.source_id}`,
    resolveGrantExtractionManifest(grant).revision,
  ]));
  const missingActiveGrantIds = annotations
    .filter((annotation) => !activeRevisionByGrant.has(annotation.grantId))
    .map((annotation) => annotation.grantId);
  const staleRevisionGrantIds = annotations.filter((annotation) => {
    const activeRevision = activeRevisionByGrant.get(annotation.grantId);
    return activeRevision !== undefined && activeRevision !== annotation.sourceRevision;
  }).map((annotation) => annotation.grantId);
  const evaluableAnnotations = annotations.filter((annotation) => activeRevisionByGrant.has(annotation.grantId));
  const audienceEvaluation = evaluateGrantAudience(evaluableAnnotations, predictions);
  const activationReady = audienceEvaluation.operationalReady && missingActiveGrantIds.length === 0 &&
    staleRevisionGrantIds.length === 0 && simulation.gates.allExcludedAreSafeIndividual &&
    simulation.gates.noFalseIneligibleRegression && simulation.gates.noUnsafeIneligibleRegression &&
    simulation.gates.readinessGateMaintained;
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    companyFixtureKind: "synthetic_business_number_initial_projection",
    operationalAccuracyEvidence: false,
    matchingFilterEnabled: false,
    filterActivationAuthorized: false,
    annotationsPath,
    annotationCount: annotations.length,
    missingActiveGrantCount: missingActiveGrantIds.length,
    staleRevisionCount: staleRevisionGrantIds.length,
    audienceEvaluation,
    activationReady,
    simulation,
    gates: {
      reviewedAudienceEvaluationPassed: audienceEvaluation.operationalReady,
      annotationRevisionCurrent: staleRevisionGrantIds.length === 0,
      annotationUniverseCurrent: missingActiveGrantIds.length === 0,
      matchingSafetyMaintained: simulation.gates.noFalseIneligibleRegression &&
        simulation.gates.noUnsafeIneligibleRegression && simulation.gates.readinessGateMaintained,
      activationReady,
    },
    blockers: [
      ...(audienceEvaluation.operationalReady ? [] : ["reviewed_audience_gate_not_passed"]),
      ...(missingActiveGrantIds.length > 0 ? ["review_annotations_missing_from_active_universe"] : []),
      ...(staleRevisionGrantIds.length > 0 ? ["review_annotations_stale_revision"] : []),
      "explicit_filter_activation_approval_required",
    ],
    samples: {
      missingActiveGrantIds: missingActiveGrantIds.slice(0, 20),
      staleRevisionGrantIds: staleRevisionGrantIds.slice(0, 20),
    },
    reminders: [
      "the simulation never changes the repository or DB matching universe",
      "draft annotations do not count as reviewed accuracy evidence",
      "unknown and mixed audience grants remain in the simulated business universe",
      "filter activation still requires explicit approval after the reviewed gate passes",
    ],
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`--limit must be ${min}..${max}`);
  return parsed;
}
function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --asOf: ${value}`);
  return date;
}
