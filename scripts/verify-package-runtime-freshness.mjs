import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const workspaceRoot = resolve(import.meta.dirname, "..");
const requireFromWeb = createRequire(join(workspaceRoot, "apps", "web", "package.json"));
const coreRuntimePath = requireFromWeb.resolve("@cunote/core");
const {
  canonicalizeGrantCriterion,
  normalizeKStartupAnnouncement,
} = await import(pathToFileURL(coreRuntimePath).href);

for (const packageName of ["contracts", "core"]) {
  assertPackageRuntimeIsFresh(packageName);
}

const asOf = new Date("2026-07-13T00:00:00.000Z");
const closedKStartup = normalizeKStartupAnnouncement({
  pbanc_sn: "runtime-freshness",
  biz_pbanc_nm: "runtime freshness contract",
  rcrt_prgs_yn: "N",
}, { asOf, collectedAt: asOf });
assert.equal(
  closedKStartup.grant.status,
  "closed",
  "@cunote/core package export is stale: rcrt_prgs_yn=N must normalize to closed",
);

const canonicalRegion = canonicalizeGrantCriterion({
  dimension: "region",
  operator: "in",
  kind: "required",
  value: { codes: [30, 36] },
  confidence: 1,
  source_span: "대전·세종 소재 기업",
});
assert.deepEqual(
  canonicalRegion.value,
  { regions: ["30", "36"] },
  "@cunote/core package export is stale: legacy region codes must use canonical regions",
);

console.log("verify-package-runtime-freshness: package exports match the current source contracts");

function assertPackageRuntimeIsFresh(packageName) {
  const packageRoot = join(workspaceRoot, "packages", packageName);
  const sourceMtime = newestMtime(join(packageRoot, "src"));
  const runtimeEntry = join(packageRoot, "dist", "index.js");
  const runtimeMtime = statSync(runtimeEntry).mtimeMs;
  assert.ok(
    runtimeMtime >= sourceMtime,
    `${packageName} dist is older than src. Run \`pnpm build:packages\` before starting or testing the web runtime.`,
  );
}

function newestMtime(directory) {
  let newest = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(path));
      continue;
    }
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    newest = Math.max(newest, statSync(path).mtimeMs);
  }
  return newest;
}
