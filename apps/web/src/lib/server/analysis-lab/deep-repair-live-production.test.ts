import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepRepairLiveExecutionError } from "./deep-repair-live-experiment";

const production = await import("./deep-repair-live-production");

assert.deepEqual(
  Object.keys(production).sort(),
  ["runApprovedCanary"],
  "production 조합은 exact authority 한 건 실행 표면만 노출해야 한다",
);

await assert.rejects(
  production.runApprovedCanary({
    authorityId: "not-a-sha",
    signal: new AbortController().signal,
  }),
  (error: unknown) =>
    error instanceof DeepRepairLiveExecutionError
    && error.code === "authority_invalid"
    && error.noModelStarted,
  "잘못된 authority는 filesystem·DB·모델보다 먼저 차단해야 한다",
);

const source = readFileSync(new URL("./deep-repair-live-production.ts", import.meta.url), "utf8");
assert.match(source, /createDeepRepairLiveFilesystemRepository\(\)/);
assert.match(source, /createDeepRepairLiveDbLeaseClient\(\)/);
assert.match(source, /createDeepRepairLiveRuntimeAuthority\(/);
assert.match(source, /verifyOperationalEvidence:\s*verifyCurrentDeepRepairOperationalEvidence/);
assert.match(source, /readCurrentDeepRepairExecutionProvenance/);
assert.match(source, /prepareLabAnalysis\(/);
assert.match(source, /executePreparedLabAnalysis\(/);
assert.match(source, /transport:\s*"claude-cli"/);
assert.match(source, /LAB_RUN_LOGICAL_PATH/);
assert.match(source, /realpath\(/);
assert.match(source, /segments\[2\]\s*===\s*"experiments"/);
assert.doesNotMatch(
  source,
  /export\s+(?:async\s+)?function\s+(?:create|open)|export\s+const\s+(?:create|open)/,
  "production dependency 조합을 교체하는 public factory/opener를 만들지 않는다",
);
assert.doesNotMatch(
  source,
  /UnsafeForTest|dependencies|overrides/,
  "production 조합에 테스트용 dependency override를 연결하지 않는다",
);

const sourceRoot = fileURLToPath(new URL("../../../", import.meta.url));
const productionSources = collectProductionSources(sourceRoot);
for (const [symbol, allowed] of [
  [
    "createDeepRepairLiveExperiment",
    new Set([
      "lib/server/analysis-lab/deep-repair-live-experiment.ts",
      "lib/server/analysis-lab/deep-repair-live-production.ts",
    ]),
  ],
  [
    "createDeepRepairLiveFilesystemRepository",
    new Set([
      "lib/server/analysis-lab/deep-repair-live-fs.ts",
      "lib/server/analysis-lab/deep-repair-live-production.ts",
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

console.log("deep-repair-live-production tests: ok");
