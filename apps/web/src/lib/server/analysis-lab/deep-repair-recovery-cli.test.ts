import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DeepRepairRecoveryCliCleanupError,
  deepRepairRecoveryCliErrorExitCode,
  parseDeepRepairRecoveryCliArgs,
  resolveDeepRepairRecoveryCliCleanupFailure,
} from "./deep-repair-recovery-cli";
import { DeepRepairRecoveryError } from "./deep-repair-recovery";

const SHA = "a".repeat(64);

assert.deepEqual(parseDeepRepairRecoveryCliArgs([`--inspect=${SHA}`]), {
  kind: "inspect",
  authorityId: SHA,
});
assert.deepEqual(parseDeepRepairRecoveryCliArgs(["--", `--inspect=${SHA}`]), {
  kind: "inspect",
  authorityId: SHA,
});
assert.deepEqual(parseDeepRepairRecoveryCliArgs([`--approval=${SHA}`]), {
  kind: "recover",
  approvalId: SHA,
});
assert.deepEqual(parseDeepRepairRecoveryCliArgs(["--", `--approval=${SHA}`]), {
  kind: "recover",
  approvalId: SHA,
});
assert.deepEqual(parseDeepRepairRecoveryCliArgs(["--help"]), { kind: "help" });
assert.deepEqual(parseDeepRepairRecoveryCliArgs(["--", "--help"]), { kind: "help" });

for (const argv of [
  [],
  ["--"],
  ["--help", `--inspect=${SHA}`],
  [`--inspect=${SHA}`, `--approval=${SHA}`],
  [`--inspect=${"A".repeat(64)}`],
  [`--approval=${"A".repeat(64)}`],
  ["--inspect", SHA],
  ["--approval", SHA],
  ["--authority=" + SHA],
  ["--series=deep-v19"],
  ["--target=grant-one"],
  ["--retry"],
  ["--retry=1"],
  ["--force"],
  ["--delete"],
  ["--cleanup"],
  ["--model=claude-opus-5"],
  ["--gcloud"],
  ["--promotion=write"],
] as const) {
  assert.throws(
    () => parseDeepRepairRecoveryCliArgs(argv),
    /--inspect=<64자리 소문자 SHA-256>|--approval=<64자리 소문자 SHA-256>|--help/,
    `허용하지 않는 recovery 표면을 거부해야 한다: ${argv.join(" ") || "(empty)"}`,
  );
}

{
  const primary = new DeepRepairRecoveryError("approval_invalid", "approval rejected");
  const cleanup = new Error("close timed out");
  assert.equal(
    resolveDeepRepairRecoveryCliCleanupFailure({
      primaryError: primary,
      operation: "recover",
      cleanupError: cleanup,
    }),
    null,
  );
  assert.equal(primary.cause, cleanup, "DB close 실패가 원래 recovery 오류를 덮으면 안 된다");
}

{
  const cleanup = resolveDeepRepairRecoveryCliCleanupFailure({
    primaryError: null,
    operation: "recover",
    cleanupError: new Error("close timed out"),
  });
  assert.ok(cleanup instanceof DeepRepairRecoveryCliCleanupError);
  assert.equal(cleanup.operation, "recover");
  assert.equal(deepRepairRecoveryCliErrorExitCode(cleanup), 2);
  assert.match(cleanup.message, /복구 결과가 commit됐을 수 있지만/);
}

{
  const cleanup = resolveDeepRepairRecoveryCliCleanupFailure({
    primaryError: null,
    operation: "inspect",
    cleanupError: new Error("close timed out"),
  });
  assert.ok(cleanup instanceof DeepRepairRecoveryCliCleanupError);
  assert.equal(cleanup.operation, "inspect");
  assert.equal(deepRepairRecoveryCliErrorExitCode(cleanup), 1);
  assert.match(cleanup.message, /읽기 전용 inspect 뒤/);
}

assert.equal(
  deepRepairRecoveryCliErrorExitCode(
    new DeepRepairRecoveryError("receipt_commit_failed", "commit ambiguous"),
  ),
  2,
  "runtime CAS 뒤 receipt commit 상태가 불명확하면 재시도를 유도하지 않는 exit 2여야 한다",
);
assert.equal(
  deepRepairRecoveryCliErrorExitCode(
    new DeepRepairRecoveryError("approval_invalid", "invalid"),
  ),
  1,
);

const source = readFileSync(
  new URL("./deep-repair-recovery-cli.ts", import.meta.url),
  "utf8",
);
assert.match(source, /inspectDeepRepairRecovery\(\{/);
assert.match(source, /recoverApprovedDeepRepairAttempt\(\{/);
assert.match(source, /process\.once\("SIGINT"/);
assert.match(source, /process\.once\("SIGTERM"/);
assert.match(source, /finally\s*\{[\s\S]*closeCunoteDb\(\)/);
assert.match(
  source,
  /import\s*\{\s*loadAnalysisLabEnv\s*\}\s*from\s*["']\.\.\/loadMonorepoEnv["']/,
);
assert.ok(
  source.indexOf("parseDeepRepairRecoveryCliArgs(argv)")
    < source.indexOf("loadAnalysisLabEnv();"),
  "help와 잘못된 인자는 env/DB보다 먼저 처리해야 한다",
);
assert.doesNotMatch(source, /--(?:force|retry|delete|cleanup|model|gcloud|promotion)=?/u);
assert.doesNotMatch(source, /prepareLabAnalysis|executePreparedLabAnalysis|claude-cli/);
assert.doesNotMatch(source, /dependency|override|factory|opener/iu);

console.log("deep-repair-recovery-cli tests: ok");
