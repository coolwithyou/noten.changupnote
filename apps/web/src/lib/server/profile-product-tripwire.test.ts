import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const fixture = JSON.parse(readFileSync(
  resolve(root, "apps/web/src/lib/server/profile-product-tripwire.fixture.json"),
  "utf8",
)) as {
  productEntrypoints: string[];
  directCallSites: Array<{ file: string; callee: string; count: number }>;
};

assert.deepEqual(fixture.productEntrypoints, [...fixture.productEntrypoints].sort(), "entrypoint fixture는 sorted여야 한다");
assert.equal(new Set(fixture.productEntrypoints).size, fixture.productEntrypoints.length);
assert.ok(fixture.productEntrypoints.every((file) => existsSync(resolve(root, file))));
assert.deepEqual(
  fixture.directCallSites,
  [...fixture.directCallSites].sort((left, right) =>
    left.file.localeCompare(right.file) || left.callee.localeCompare(right.callee)),
  "direct-call fixture는 file/callee 순으로 sorted여야 한다",
);

const entrypointCallees = [
  "loadServiceDashboard",
  "loadServiceApplySheet",
  "enrichServiceCompany",
  "resolveTeaserCompanyProfile",
  "loadCompanyProfileResolutionForTeaser",
  "buildInitialCompanyMatch",
  "updateCompanyProfileField",
];
// This is intentionally one fixed text capture for the P3 routing gate. It is
// not an AST or a reusable source-scanning framework.
const actualEntrypoints = execFileSync("git", [
  "grep",
  "--untracked",
  "-l",
  "-E",
  `(${entrypointCallees.join("|")})[[:space:]]*\\(`,
  "--",
  "apps/web/src/app",
], { cwd: root, encoding: "utf8" })
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((file) => !file.includes("/api/dev/"))
  .sort();
assert.deepEqual(actualEntrypoints, fixture.productEntrypoints, "product entrypoint surface changed; update P3 receipt intentionally");

const directCallees = [
  "matchGrantCriteria",
  "matchNormalizedGrant",
  "buildInitialCompanyMatch",
  "buildDashboard",
  "buildApplySheet",
  "mergeCompanyProfilesForEnrichment",
  "mergeCompanyProfilesForEnrichmentAt",
  "legacyMergeCompanyProfilesForEnrichment",
  "updateCompanyProfileField",
];
const excludedDirectPath = /(?:\.test\.ts$|devServiceData|\/ingestion\/|\/matches\/(?:measure|report)|\/repositories\/verify-|\/verify-|\/db\/smoke)/;
const directCounts = new Map<string, { file: string; callee: string; count: number }>();
const directCapture = execFileSync("git", [
  "grep",
  "--untracked",
  "-n",
  "-E",
  `(${directCallees.join("|")})[[:space:]]*\\(`,
  "--",
  "apps/web/src",
], { cwd: root, encoding: "utf8" });
for (const line of directCapture.split(/\r?\n/).filter(Boolean)) {
  const firstColon = line.indexOf(":");
  const secondColon = line.indexOf(":", firstColon + 1);
  const file = line.slice(0, firstColon);
  if (excludedDirectPath.test(file)) continue;
  const source = line.slice(secondColon + 1);
  for (const callee of directCallees) {
    if (new RegExp(`\\bfunction\\s+${callee}\\s*\\(`).test(source)) continue;
    const count = [...source.matchAll(new RegExp(`\\b${callee}\\s*\\(`, "g"))].length;
    if (count === 0) continue;
    const key = `${file}\u0000${callee}`;
    const current = directCounts.get(key);
    directCounts.set(key, { file, callee, count: (current?.count ?? 0) + count });
  }
}
const actualDirect = [...directCounts.values()]
  .sort((left, right) => left.file.localeCompare(right.file) || left.callee.localeCompare(right.callee));
assert.deepEqual(actualDirect, fixture.directCallSites, "direct matcher/legacy merge surface changed; route it in P3");

console.log("profile-product-tripwire.test.ts: all assertions passed");
