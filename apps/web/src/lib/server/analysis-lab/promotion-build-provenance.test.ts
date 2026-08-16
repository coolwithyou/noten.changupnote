import assert from "node:assert/strict";
import {
  readPromotionBuildProvenance,
  type PromotionGitReader,
} from "./promotion-build-provenance";

function gitReader(outputs: Map<string, string>, calls: string[][]): PromotionGitReader {
  return (args) => {
    calls.push([...args]);
    return outputs.get(args.join("\u0000")) ?? "";
  };
}

{
  const calls: string[][] = [];
  const outputs = new Map<string, string>([
    [["rev-parse", "HEAD"].join("\u0000"), "a".repeat(40)],
    [["rev-parse", "HEAD^{tree}"].join("\u0000"), "b".repeat(40)],
  ]);
  assert.deepEqual(
    readPromotionBuildProvenance({ readGit: gitReader(outputs, calls) }),
    { gitCommit: "a".repeat(40), buildDigest: "b".repeat(40) },
  );
  assert.deepEqual(calls[0], ["status", "--porcelain=v1", "--untracked-files=no"]);
  assert.ok(calls[1]?.includes("apps/web/src"));
  assert.ok(!calls[1]?.includes("docs"), "release와 무관한 미추적 문서는 cleanliness 범위가 아니다");
}

{
  const outputs = new Map<string, string>([
    [["status", "--porcelain=v1", "--untracked-files=no"].join("\u0000"), " M apps/web/src/a.ts"],
  ]);
  assert.throws(
    () => readPromotionBuildProvenance({ readGit: gitReader(outputs, []) }),
    /tracked 변경/,
  );
}

{
  const criticalStatus = [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    "apps/web/src",
    "packages",
    "scripts",
    "tools",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
  ].join("\u0000");
  const outputs = new Map<string, string>([[criticalStatus, "?? apps/web/src/untracked.ts"]]);
  assert.throws(
    () => readPromotionBuildProvenance({ readGit: gitReader(outputs, []) }),
    /build\/import 경로/,
  );
}

console.log("promotion build provenance tests: ok");
