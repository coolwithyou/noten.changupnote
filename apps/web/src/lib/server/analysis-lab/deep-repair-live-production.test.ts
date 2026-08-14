import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

console.log("deep-repair-live-production tests: ok");
