import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildQuestionFlowSimulationReport, parseV3AnnotationJsonl } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const asOf = dateArg(readArg("asOf")) ?? new Date();
const scanLimit = boundedInteger(readArg("scanLimit"), 5_000, 1, 20_000, "scanLimit");
const maxQuestions = boundedInteger(readArg("maxQuestions"), 10, 1, 19, "maxQuestions");
const includeCompanies = process.argv.includes("--include-companies");
const companiesPath = resolve(
  readArg("companies") ?? "packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl",
);
const companies = parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath).companies.flatMap((record) =>
  record.businessKind === "individual" || record.businessKind === "corporation"
    ? [{ companyId: record.companyId, businessKind: record.businessKind, profile: record.profile }]
    : []);

try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: getCunoteDb() });
  const scanned = await repositories.grants.listActiveGrants({ asOf, limit: scanLimit + 1 });
  if (scanned.length > scanLimit) {
    throw new Error(`active grants exceed --scanLimit=${scanLimit}; refusing a partial simulation`);
  }
  const grants = scanned;
  const report = buildQuestionFlowSimulationReport({
    companies,
    grants,
    asOf,
    maxQuestionsPerCompany: maxQuestions,
  });
  const { companies: companyReports, ...summary } = report;
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    fixtureKind: "synthetic_full_profile_projected_to_current_business_number_fields",
    ...summary,
    ...(includeCompanies ? { companies: companyReports } : {}),
    syntheticReadinessChecks: {
      questionsToFirstResolutionP50AtMost3:
        report.questionsToFirstResolutionP50 !== null && report.questionsToFirstResolutionP50 <= 3,
      cohortConditionalResolutionAtLeast060:
        report.cohortConditionalResolutionRate !== null && report.cohortConditionalResolutionRate >= 0.6,
      noCompanyHitQuestionLimit: report.reachedQuestionLimitCount === 0,
    },
    reminders: [
      "this is a synthetic answer-oracle simulation, not operational user behavior or lookup accuracy",
      "operational release gates still require at least 30 events and 10 sessions from profile-question telemetry",
      "partial/unstructured extraction can leave conditional grants unresolved even after all answerable profile questions",
    ],
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--${name} must be ${min}..${max}`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --asOf: ${value}`);
  return date;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
