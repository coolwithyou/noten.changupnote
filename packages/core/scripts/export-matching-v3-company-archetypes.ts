import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildSyntheticCompanyArchetypes } from "../src/index.js";

const output = resolve(readArg("output") ?? "packages/core/golden/matching-v3/company-profiles.expanded.draft.jsonl");
if (existsSync(output) && !process.argv.includes("--force")) throw new Error(`output exists; use --force: ${output}`);
const companies = buildSyntheticCompanyArchetypes();
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${companies.map((company) => JSON.stringify(company)).join("\n")}\n`, "utf8");
console.log(JSON.stringify({
  writeMode: false,
  databaseWrite: false,
  output,
  companyCount: companies.length,
  businessKindCounts: histogram(companies.map((company) => company.businessKind)),
  regionCount: new Set(companies.map((company) => company.profile.region?.code)).size,
  industryLabelCount: new Set(companies.flatMap((company) => company.profile.industries ?? [])).size,
  reviewedCount: 0,
  operationalReady: false,
}, null, 2));

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
function histogram(values: string[]): Record<string, number> {
  return values.reduce<Record<string, number>>((result, value) => {
    result[value] = (result[value] ?? 0) + 1;
    return result;
  }, {});
}
