import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildBusinessNumberFirstResultReport,
  parseV3AnnotationJsonl,
} from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();
const asOf = dateArg(readArg("asOf")) ?? new Date();
const limit = boundedInteger(readArg("limit"), 2_000, 1, 5_000);
const includeCompanies = process.argv.includes("--include-companies");
const companiesPath = resolve(readArg("companies") ?? "packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl");
const companies = parseV3AnnotationJsonl(readFileSync(companiesPath, "utf8"), companiesPath).companies.flatMap((record) =>
  record.businessKind === "individual" || record.businessKind === "corporation"
    ? [{ companyId: record.companyId, businessKind: record.businessKind, profile: record.profile }]
    : []);
const db = getCunoteDb();
try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ asOf, limit });
  const report = buildBusinessNumberFirstResultReport({ companies, grants, asOf });
  const { companies: companyReports, ...summary } = report;
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    fixtureKind: "synthetic_full_profile_projected_to_current_business_number_fields",
    operationalAccuracyEvidence: false,
    ...summary,
    ...(includeCompanies ? { companies: companyReports } : {}),
    gates: {
      falseIneligibleAgainstFullMustBeZero: report.falseIneligibleAgainstFullCount === 0,
      unsafeIneligibleAgainstFullViableMustBeZero: report.unsafeIneligibleAgainstFullViableCount === 0,
      immediateResultAvailable: report.initialEligibilityCounts.eligible + report.initialEligibilityCounts.conditional > 0,
      reviewedCompanyEvidenceRequiredForRelease: true,
    },
    reminders: [
      "synthetic full profiles are a coverage ceiling, not real business-number lookup accuracy",
      "industry from the current business-number path is partial and no-hit remains unknown",
      "planned free APIs are excluded until their connector and live response are verified",
    ],
  }, null, 2));
} finally {
  await closeCunoteDb();
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
function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
