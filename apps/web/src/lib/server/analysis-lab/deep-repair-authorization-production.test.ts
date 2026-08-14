import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const production = await import("./deep-repair-authorization-production");

assert.deepEqual(
  Object.keys(production).sort(),
  ["issueApprovedDeepRepairAuthority"],
  "production 조합은 approval SHA 한 건 발급 표면만 노출해야 한다",
);

const source = readFileSync(
  new URL("./deep-repair-authorization-production.ts", import.meta.url),
  "utf8",
);

assert.match(source, /createDeepRepairAuthorizationFilesystemRepository\(\)/);
assert.match(source, /captureOperationalEvidence:\s*captureCurrentDeepRepairOperationalEvidence/);
assert.match(source, /readExecutionProvenance:\s*readCurrentDeepRepairExecutionProvenance/);
assert.match(source, /prepareLabAnalysis\(grantId\)/);
assert.match(source, /readDeepAnalysisRuntimeAdmissionSnapshot\(getCunoteDb\(\)\)/);
assert.match(source, /randomUUID\(\)/);

for (const forbidden of [
  "executePreparedLabAnalysis",
  "runLabAnalysis",
  "createDeepRepairLiveRuntimeAuthority",
  "createDeepRepairLiveDbLeaseClient",
  "acquireLocalSubscriptionLease",
  "renewLocalSubscriptionLease",
  "releaseLocalSubscriptionLease",
  "runKordoc",
  "promote",
  "review",
  "audit",
] as const) {
  assert.doesNotMatch(
    source,
    new RegExp(`\\b${forbidden}\\b`, "iu"),
    `authority issuer production 조합이 금지 capability를 포함하면 안 된다: ${forbidden}`,
  );
}

assert.doesNotMatch(
  source,
  /UnsafeForTest|dependencies|overrides/,
  "production 조합에 public test seam을 연결하지 않는다",
);
assert.doesNotMatch(
  source,
  /export\s+(?:async\s+)?function\s+(?:create|open)|export\s+const\s+(?:create|open)/,
  "production dependency 조합을 교체하는 public factory/opener를 만들지 않는다",
);

for (const filename of [
  "deep-repair-authorization.ts",
  "deep-repair-authorization-fs.ts",
  "deep-repair-authorization-production.ts",
] as const) {
  const moduleSource = readFileSync(new URL(`./${filename}`, import.meta.url), "utf8");
  const imports = Array.from(
    moduleSource.matchAll(/from\s+["']([^"']+)["']/gu),
    (match) => match[1] ?? "",
  ).join("\n");
  assert.doesNotMatch(
    imports,
    /application-roundtrip|kordoc|ai-review|blind-audit|promotion|promote|deep-repair-live-(?:runtime|db-runtime)|claude-cli-transport/iu,
    `authority 발급 모듈이 금지 production capability를 import하면 안 된다: ${filename}`,
  );
}

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const productionSources = collectProductionSources(sourceRoot);
for (const [symbol, allowed] of [
  [
    "createDeepRepairAuthorityIssuer",
    new Set([
      "lib/server/analysis-lab/deep-repair-authorization.ts",
      "lib/server/analysis-lab/deep-repair-authorization-production.ts",
    ]),
  ],
  [
    "createDeepRepairAuthorizationFilesystemRepository",
    new Set([
      "lib/server/analysis-lab/deep-repair-authorization-fs.ts",
      "lib/server/analysis-lab/deep-repair-authorization-production.ts",
    ]),
  ],
] as const) {
  for (const path of productionSources) {
    const relativePath = relative(sourceRoot, path);
    if (allowed.has(relativePath)) continue;
    assert.doesNotMatch(
      readFileSync(path, "utf8"),
      new RegExp(`\\b${symbol}\\b`, "u"),
      `${symbol} production 조합 우회가 허용되지 않은 파일에 있습니다: ${relativePath}`,
    );
  }
}

function collectProductionSources(root: string): string[] {
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        /\.tsx?$/u.test(entry.name)
        && !/\.(?:test|spec)\.tsx?$/u.test(entry.name)
      ) {
        result.push(path);
      }
    }
  };
  visit(root);
  return result;
}

console.log("deep-repair-authorization-production tests: ok");
