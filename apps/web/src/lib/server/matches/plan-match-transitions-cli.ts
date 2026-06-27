import { closeCunoteDb } from "@/lib/server/db/client";
import { loadMonorepoEnv } from "@/lib/server/loadMonorepoEnv";
import { loadDueMatchTransitionPlan } from "./transitionPlan";

loadMonorepoEnv();

const asOf = readDateArg("asOf") ?? new Date();
const limit = readNumberArg("limit");
const userId = readStringArg("userId");

try {
  const plan = await loadDueMatchTransitionPlan({
    asOf,
    ...(limit !== undefined ? { limit } : {}),
    ...(userId ? { userId } : {}),
  });
  console.log(JSON.stringify({
    dryRun: true,
    adapter: process.env.CUNOTE_REPOSITORY_ADAPTER ?? "runtime",
    ...plan,
  }, null, 2));
} finally {
  await closeCunoteDb();
}

function readStringArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function readNumberArg(name: string): number | undefined {
  const value = readStringArg(name);
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readDateArg(name: string): Date | undefined {
  const value = readStringArg(name);
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}
