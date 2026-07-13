import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateMatchingV3ReviewedFixture,
  MATCHING_V3_MINIMUM_REVIEWED_PAIRS,
} from "../src/evaluation/matching-v3-reviewed.js";
import { parseV3AnnotationJsonl } from "../src/evaluation/v3-annotations.js";

const WORKSPACE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const DEFAULT_FIXTURE_ROOT = join(
  WORKSPACE_ROOT,
  "packages/core/golden/matching-v3/reviewed-expanded",
);
const split = readArg("split") ?? "development";
if (split !== "development" && split !== "holdout") {
  throw new Error("--split must be development or holdout");
}
if (split !== "development" && readArg("confirm") !== "OPEN_MATCHING_V3_HOLDOUT") {
  throw new Error("holdout evaluation requires --confirm=OPEN_MATCHING_V3_HOLDOUT");
}

const paths = {
  companies: resolve(readArg("companies") ?? join(DEFAULT_FIXTURE_ROOT, "company-profiles.jsonl")),
  grants: resolve(readArg("grants") ?? join(DEFAULT_FIXTURE_ROOT, "grants.jsonl")),
  pairs: resolve(readArg("pairs") ?? join(
    DEFAULT_FIXTURE_ROOT,
    split === "holdout" ? "eligibility-pairs.holdout.jsonl" : "eligibility-pairs.development.jsonl",
  )),
};
const missingFixtureFiles = Object.entries(paths)
  .filter(([, path]) => !existsSync(path))
  .map(([kind, path]) => ({ kind, path }));
const companies = readDataset(paths.companies).companies;
const grants = readDataset(paths.grants).grants;
const loadedPairs = readDataset(paths.pairs).eligibilityPairs;
const pairs = loadedPairs.filter((pair) => pair.split === split);
const asOf = parseAsOf(readArg("as-of"));
const evaluation = evaluateMatchingV3ReviewedFixture({
  companies,
  grants,
  pairs,
  asOf,
  minimumReviewedPairs: MATCHING_V3_MINIMUM_REVIEWED_PAIRS,
});
const operationalReady = missingFixtureFiles.length === 0 && evaluation.operationalReady;
const notReadyReasons = [
  ...(missingFixtureFiles.length > 0 ? ["reviewed_fixture_files_missing"] : []),
  ...evaluation.notReadyReasons,
];

console.log(JSON.stringify({
  generatedAt: new Date().toISOString(),
  writeMode: false,
  fixtureFiles: paths,
  missingFixtureFiles,
  evaluatedSplit: split,
  ...evaluation,
  status: operationalReady ? "ready" : "not_ready",
  operationalReady,
  notReadyReasons: [...new Set(notReadyReasons)],
  reminder: "Only independently reviewed matching-v3 annotations count toward this gate.",
}, null, 2));

if (process.argv.includes("--verify") && !operationalReady) process.exitCode = 1;

function readDataset(path: string): ReturnType<typeof parseV3AnnotationJsonl> {
  return existsSync(path)
    ? parseV3AnnotationJsonl(readFileSync(path, "utf8"), path)
    : { records: [], companies: [], grants: [], eligibilityPairs: [] };
}

function parseAsOf(value: string | undefined): Date {
  const parsed = value ? new Date(value) : new Date();
  if (Number.isNaN(parsed.getTime())) throw new Error("--as-of must be a valid date");
  return parsed;
}

function readArg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}
