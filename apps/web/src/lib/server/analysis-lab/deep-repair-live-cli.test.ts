import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deepRepairLiveCliErrorExitCode,
  deepRepairLiveCliExitCode,
  parseDeepRepairLiveCliArgs,
  resolveDeepRepairLiveCliCleanupFailure,
} from "./deep-repair-live-cli";
import { DeepRepairLiveExecutionError } from "./deep-repair-live-experiment";

const SHA = "a".repeat(64);

assert.deepEqual(parseDeepRepairLiveCliArgs([`--authority=${SHA}`]), {
  kind: "execute",
  authorityId: SHA,
});
assert.deepEqual(parseDeepRepairLiveCliArgs(["--", `--authority=${SHA}`]), {
  kind: "execute",
  authorityId: SHA,
});
assert.deepEqual(parseDeepRepairLiveCliArgs(["--help"]), { kind: "help" });
assert.deepEqual(parseDeepRepairLiveCliArgs(["--", "--help"]), { kind: "help" });

for (const argv of [
  [],
  ["--"],
  ["--", "--", "--help"],
  ["--help", `--authority=${SHA}`],
  [`--authority=${SHA}`, `--authority=${SHA}`],
  ["--authority", SHA],
  [`--authority=${"A".repeat(64)}`],
  ["grant-one"],
  ["--series=deep-v18"],
  ["--plan=plan.json"],
  ["--grant=grant-one"],
  ["--model=claude-opus-5"],
  ["--count=1"],
  ["--concurrency=1"],
  ["--retry=1"],
  ["--promotion=write"],
]) {
  assert.throws(
    () => parseDeepRepairLiveCliArgs(argv),
    /--authority=<64자리 소문자 SHA-256>|--help/,
    `허용하지 않는 실행 표면을 거부해야 한다: ${argv.join(" ") || "(empty)"}`,
  );
}

assert.equal(deepRepairLiveCliExitCode({ kind: "recorded" }), 0);
assert.equal(deepRepairLiveCliExitCode({ kind: "inspected" }), 0);
assert.equal(deepRepairLiveCliExitCode({ kind: "ambiguous" }), 2);
assert.equal(
  deepRepairLiveCliErrorExitCode(
    new DeepRepairLiveExecutionError("start_commit_ambiguous", "read-back failed", true),
  ),
  2,
);
assert.equal(
  deepRepairLiveCliErrorExitCode(
    new DeepRepairLiveExecutionError("authority_invalid", "invalid", true),
  ),
  1,
);

{
  const primary = new DeepRepairLiveExecutionError(
    "run_artifact_invalid",
    "model state ambiguous",
    false,
  );
  const cleanup = new Error("close timed out");
  assert.equal(
    resolveDeepRepairLiveCliCleanupFailure({
      primaryError: primary,
      executionRequested: true,
      cleanupError: cleanup,
    }),
    null,
  );
  assert.equal(primary.cause, cleanup, "DB close 실패가 원래 ambiguous 오류를 덮어쓰면 안 된다");
}

{
  const cleanup = resolveDeepRepairLiveCliCleanupFailure({
    primaryError: null,
    executionRequested: true,
    cleanupError: new Error("close timed out"),
  });
  assert.ok(cleanup instanceof DeepRepairLiveExecutionError);
  assert.equal(cleanup.code, "cli_cleanup_failed");
  assert.equal(cleanup.noModelStarted, false);
  assert.equal(deepRepairLiveCliErrorExitCode(cleanup), 2);
}

const source = readFileSync(new URL("./deep-repair-live-cli.ts", import.meta.url), "utf8");
assert.match(source, /process\.once\("SIGINT"/);
assert.match(source, /process\.once\("SIGTERM"/);
assert.match(source, /finally\s*\{[\s\S]*closeCunoteDb\(\)/);
assert.doesNotMatch(source, /dependency|override|factory|opener/i);

console.log("deep-repair-live-cli tests: ok");
