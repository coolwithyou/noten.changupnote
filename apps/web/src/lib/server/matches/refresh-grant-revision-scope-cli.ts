import { closeCunoteDb, getCunoteDb } from "../db/client";
import { loadMonorepoEnv } from "../loadMonorepoEnv";
import { runGrantRevisionScopedRefresh } from "./grantRevisionScopedRefreshCore";

loadMonorepoEnv();

const grantIds = (readArg("grantIds") ?? readArg("grantId") ?? "")
  .split(",").map((value) => value.trim()).filter(Boolean);
const companyIdsValue = readArg("companyIds") ?? readArg("companyId");
const companyIds = companyIdsValue
  ? companyIdsValue.split(",").map((value) => value.trim()).filter(Boolean)
  : undefined;
const companyLimit = boundedInteger(readArg("companyLimit"), 10_000, 1, 100_000);
const asOf = dateArg(readArg("asOf")) ?? new Date();
const write = process.argv.includes("--write");
const confirm = readArg("confirm");

if (write && confirm !== "REFRESH_GRANT_REVISION_MATCH_STATES") {
  throw new Error("write requires --confirm=REFRESH_GRANT_REVISION_MATCH_STATES");
}

try {
  console.log(JSON.stringify(await runGrantRevisionScopedRefresh({
    db: getCunoteDb(),
    grantIds,
    ...(companyIds ? { companyIds } : {}),
    companyLimit,
    asOf,
    write,
  }), null, 2));
} finally {
  await closeCunoteDb();
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function boundedInteger(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`invalid ${min}..${max} integer: ${value}`);
  return parsed;
}
function dateArg(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new Error(`invalid date: ${value}`);
  return parsed;
}
