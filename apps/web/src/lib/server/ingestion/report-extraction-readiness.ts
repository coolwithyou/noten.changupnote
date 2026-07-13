import { buildExtractionReadinessReport } from "@cunote/core";
import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { createDrizzleRepositories } from "../repositories/drizzle";

loadMonorepoEnv();

const limit = boundedInteger(readArg("limit"), 500, 1, 2_000);
const sampleLimit = boundedInteger(readArg("samples"), 20, 0, 100);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const db = getCunoteDb();

try {
  const repositories = createDrizzleRepositories<unknown>({ dialect: "drizzle", client: db });
  const grants = await repositories.grants.listActiveGrants({ limit, asOf });
  console.log(JSON.stringify({
    generatedAt: new Date().toISOString(),
    asOf: asOf.toISOString(),
    limit,
    ...buildExtractionReadinessReport(grants, { sampleLimit }),
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
    throw new Error(`Invalid ${min}..${max} integer: ${value}`);
  }
  return parsed;
}

function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const result = new Date(value);
  if (Number.isNaN(result.getTime())) throw new Error(`Invalid date: ${value}`);
  return result;
}
