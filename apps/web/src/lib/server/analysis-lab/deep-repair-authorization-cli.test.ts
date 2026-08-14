import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DeepRepairAuthorizationCliCleanupError,
  parseDeepRepairAuthorizationCliArgs,
  resolveDeepRepairAuthorizationCliCleanupFailure,
} from "./deep-repair-authorization-cli";

const SHA = "a".repeat(64);

assert.deepEqual(parseDeepRepairAuthorizationCliArgs([`--approval=${SHA}`]), {
  kind: "issue",
  approvalId: SHA,
});
assert.deepEqual(parseDeepRepairAuthorizationCliArgs(["--", `--approval=${SHA}`]), {
  kind: "issue",
  approvalId: SHA,
});
assert.deepEqual(parseDeepRepairAuthorizationCliArgs(["--help"]), { kind: "help" });
assert.deepEqual(parseDeepRepairAuthorizationCliArgs(["--", "--help"]), { kind: "help" });

for (const argv of [
  [],
  ["--"],
  ["--help", `--approval=${SHA}`],
  [`--approval=${SHA}`, `--approval=${SHA}`],
  ["--approval", SHA],
  [`--approval=${"A".repeat(64)}`],
  ["approval.json"],
  ["--authority=" + SHA],
  ["--series=deep-v18"],
  ["--plan=plan.json"],
  ["--grant=grant-one"],
  ["--model=claude-opus-5"],
  ["--generation=33"],
  ["--owner=operator"],
  ["--expires-at=2026-08-14T03:15:00.000Z"],
  ["--force"],
] as const) {
  assert.throws(
    () => parseDeepRepairAuthorizationCliArgs(argv),
    /--approval=<64자리 소문자 SHA-256>|--help/,
    `허용하지 않는 발급 표면을 거부해야 한다: ${argv.join(" ") || "(empty)"}`,
  );
}

{
  const primary = new Error("approval rejected");
  const cleanup = new Error("close timed out");
  assert.equal(
    resolveDeepRepairAuthorizationCliCleanupFailure({
      primaryError: primary,
      result: null,
      cleanupError: cleanup,
    }),
    null,
  );
  assert.equal(primary.cause, cleanup, "DB close 실패가 원래 발급 거부 오류를 덮으면 안 된다");
}

{
  const cleanup = resolveDeepRepairAuthorizationCliCleanupFailure({
    primaryError: null,
    result: { kind: "issued", authorityId: SHA },
    cleanupError: new Error("close timed out"),
  });
  assert.ok(cleanup instanceof DeepRepairAuthorizationCliCleanupError);
  assert.equal(cleanup.authorityId, SHA);
  assert.match(cleanup.message, /authority는 immutable commit됐지만/);
}

const source = readFileSync(
  new URL("./deep-repair-authorization-cli.ts", import.meta.url),
  "utf8",
);
assert.match(source, /issueApprovedDeepRepairAuthority\(\{/);
assert.match(source, /process\.once\("SIGINT"/);
assert.match(source, /process\.once\("SIGTERM"/);
assert.match(source, /finally\s*\{[\s\S]*closeCunoteDb\(\)/);
assert.doesNotMatch(source, /--(?:authority|grant|model|generation|owner|force|expires-at)=?/u);
assert.doesNotMatch(source, /dependency|override|factory|opener/iu);

console.log("deep-repair-authorization-cli tests: ok");
