import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { mockUserId } from "../auth/mockIdentity";
import { createDrizzleRepositories } from "../repositories/drizzle";
import { refreshMatchStates } from "./matchStateRefresh";

const DEFAULT_DEMO_COMPANY_ID = "00000000-0000-4000-8000-000000000101";

loadMonorepoEnv();

if (hasFlag("help")) {
  console.log([
    "Usage: pnpm match:states:refresh -- --companyId=<uuid> [--userId=<uuid>] [--limit=500] [--asOf=2026-06-27T00:00:00.000Z] [--write]",
    "",
    "Default mode is dry-run. Add --write to persist match_state rows.",
  ].join("\n"));
  process.exit(0);
}

const companyId = readArg("companyId") ?? process.env.CUNOTE_DEMO_COMPANY_ID ?? DEFAULT_DEMO_COMPANY_ID;
const userId = readArg("userId") ?? process.env.CUNOTE_MOCK_USER_ID ?? mockUserId();
const limit = boundedInteger(readArg("limit") ?? process.env.CUNOTE_MATCH_STATE_REFRESH_LIMIT, 500, 1, 2_000);
const asOf = dateArg(readArg("asOf") ?? process.env.CUNOTE_MATCH_STATE_REFRESH_AS_OF) ?? new Date();
const write = hasFlag("write") || process.env.CUNOTE_MATCH_STATE_REFRESH_WRITE === "true";
const db = getCunoteDb();

try {
  const repositories = createDrizzleRepositories<unknown>({
    dialect: "drizzle",
    client: db,
  });
  const company = await repositories.companies.resolveCompanyProfile({ companyId, userId });
  if (!company) throw new Error(`회사 프로필을 찾지 못했습니다: ${companyId}`);

  const grants = await repositories.grants.listActiveGrants({ limit, asOf });
  const { plan, savedCount } = await refreshMatchStates({
    repositories,
    company,
    grants,
    asOf,
    companyId,
    userId,
    write,
  });

  console.log(JSON.stringify({
    dryRun: !write,
    savedCount,
    companyId,
    userId,
    limit,
    asOf: plan.asOf,
    grantCount: plan.grantCount,
    counts: plan.counts,
    transitionWindowCounts: plan.transitionWindowCounts,
    states: plan.states.map((state) => ({
      grantId: state.grantId,
      source: state.source,
      sourceId: state.sourceId,
      eligibility: state.eligibility,
      fitScore: state.fitScore,
      eligibleFrom: state.eligibleFrom,
      eligibleUntil: state.eligibleUntil,
      rulesetVer: state.rulesetVer,
      scoringVer: state.scoringVer,
    })),
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid bounded integer: ${value}. Use ${min}..${max}.`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}
