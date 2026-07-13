import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { closeCunoteDb } from "../db/client";

loadMonorepoEnv();

const { loadServiceDashboard } = await import("../serviceData");
const asOf = dateArg(readArg("asOf")) ?? new Date();
const limit = boundedInteger(readArg("limit"), 12, 1, 5_000);
const dashboard = await loadServiceDashboard({
  asOf,
  limit,
  writeMatchStates: false,
});
const evaluatedGrantCount = dashboard.counts.eligible +
  dashboard.counts.conditional +
  dashboard.counts.ineligible;

try {
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    writeMode: false,
    evaluatedGrantCount,
    returnedMatchCount: dashboard.matches.length,
    counts: dashboard.counts,
    nextQuestion: dashboard.nextQuestion
      ? {
        dimension: dashboard.nextQuestion.dimension,
        affectedGrantCount: dashboard.nextQuestion.affectedGrantCount,
        inputType: dashboard.nextQuestion.inputType,
      }
      : null,
    rulesetVer: dashboard.rulesetVer,
    scoringVer: dashboard.scoringVer,
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
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`--limit must be ${min}..${max}`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid --asOf: ${value}`);
  return date;
}
