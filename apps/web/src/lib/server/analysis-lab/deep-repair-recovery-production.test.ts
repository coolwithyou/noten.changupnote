import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DeepRepairRecoveryError } from "./deep-repair-recovery";

const production = await import("./deep-repair-recovery-production");

assert.deepEqual(
  Object.keys(production).sort(),
  ["inspectDeepRepairRecovery", "recoverApprovedDeepRepairAttempt"],
  "production 조합은 recovery inspect와 승인 기반 종결만 노출해야 한다",
);

await assert.rejects(
  production.inspectDeepRepairRecovery({ authorityId: "not-a-sha" }),
  (error: unknown) =>
    error instanceof DeepRepairRecoveryError
    && error.code === "authority_invalid",
  "잘못된 authority SHA는 filesystem과 DB보다 먼저 차단해야 한다",
);

await assert.rejects(
  production.recoverApprovedDeepRepairAttempt({
    approvalId: "not-a-sha",
    signal: new AbortController().signal,
  }),
  (error: unknown) =>
    error instanceof DeepRepairRecoveryError
    && error.code === "approval_invalid",
  "잘못된 approval SHA는 filesystem과 DB mutation보다 먼저 차단해야 한다",
);

const source = readFileSync(
  new URL("./deep-repair-recovery-production.ts", import.meta.url),
  "utf8",
);
assert.match(source, /createDeepRepairRecoveryFilesystemRepository\(\)/);
assert.match(source, /createDeepRepairRecovery\(\{/);
assert.match(source, /getDeepAnalysisRuntimeControl\(/);
assert.match(source, /recoverExpiredLocalSubscriptionLease\(\{/);
assert.doesNotMatch(
  source,
  /export\s+(?:async\s+)?function\s+(?:create|open)|export\s+const\s+(?:create|open)/u,
  "production dependency 조합을 교체하는 public factory/opener를 만들지 않는다",
);
assert.doesNotMatch(source, /prepareLabAnalysis|executePreparedLabAnalysis|claude-cli/);
assert.doesNotMatch(source, /gcloud|promotion|delete|cleanup/iu);

console.log("deep-repair-recovery-production tests: ok");
