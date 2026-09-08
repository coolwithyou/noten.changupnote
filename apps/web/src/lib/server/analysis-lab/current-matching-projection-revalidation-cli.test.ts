import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL(
  "./current-matching-projection-revalidation-cli.ts",
  import.meta.url,
));
const baseArguments = [
  "seal",
  `--receipt-sha256=${"1".repeat(64)}`,
  "--sequence=0",
  "--grant-id=00000000-0000-4000-8000-0000000009b0",
  "--run-id=run-test",
  "--current-evidence=/definitely-missing-current-evidence.json",
];

assertCliRejected(
  [...baseArguments, "--unexpected=true"],
  /허용되지 않은 옵션.*unexpected/,
);
assertCliRejected(
  [...baseArguments, "--sequence=1"],
  /중복 옵션.*sequence/,
);
assertCliRejected(
  baseArguments.map((argument) => (
    argument === "--sequence=0" ? "--sequence=1garbage" : argument
  )),
  /sequence는 0 이상 정수 문자열/,
);
assertCliRejected(
  baseArguments.map((argument) => (
    argument === "--sequence=0" ? "--sequence=9007199254740992" : argument
  )),
  /sequence는 safe integer 범위/,
);

console.log("current matching projection revalidation CLI tests: ok");

function assertCliRejected(arguments_: readonly string[], expected: RegExp): void {
  const result = spawnSync(process.execPath, ["--import", "tsx", cliPath, ...arguments_], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: "apps/web/tsconfig.json",
    },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, expected);
}
