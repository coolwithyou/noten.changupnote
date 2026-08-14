import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { DEEP_ANALYSIS_VALIDATOR_VERSION } from "@/lib/server/deep-analysis/validator";
import { findMonorepoRoot } from "./run-store";

const execFileAsync = promisify(execFile);
const FULL_GIT_SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const RUNTIME_PACKAGES = ["contracts", "core"] as const;
const EXECUTION_SOURCE_PATHS = [
  "apps/web/src/features/dev/analysis-lab",
  "apps/web/src/lib/server/analysis-lab",
  "apps/web/src/lib/server/deep-analysis",
  "apps/web/package.json",
  "apps/web/tsconfig.json",
  "packages/contracts",
  "packages/core",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
] as const;

export async function computeDeepRepairPackageRuntimeSha256(
  repositoryRoot = findMonorepoRoot(),
): Promise<string> {
  const paths: string[] = [];
  for (const packageName of RUNTIME_PACKAGES) {
    const packageRoot = join(repositoryRoot, "packages", packageName);
    paths.push(join(packageRoot, "package.json"));
    const distRoot = join(packageRoot, "dist");
    const distFiles = await listFiles(distRoot);
    const runtimeJs = distFiles.filter((path) => path.endsWith(".js") && !path.endsWith(".test.js"));
    if (runtimeJs.length === 0) {
      throw new Error(`package runtime JS가 없습니다: packages/${packageName}/dist`);
    }
    paths.push(...runtimeJs);
  }

  const files = await Promise.all(paths.map(async (path) => {
    const bytes = await readFile(path);
    return {
      path: relative(repositoryRoot, path).split(sep).join("/"),
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }));
  files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const manifest = { schema: "analysis-lab-package-runtime-v1", files };
  return createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
}

export async function readCurrentDeepRepairExecutionProvenance(options: {
  readonly repositoryRoot?: string;
  readonly readGitState?: (repositoryRoot: string) => Promise<{ gitSha: string; trackedClean: boolean }>;
} = {}): Promise<{
  gitSha: string;
  packageRuntimeSha256: string;
  validatorVersion: string;
}> {
  const repositoryRoot = options.repositoryRoot ?? findMonorepoRoot();
  const git = await (options.readGitState ?? readGitState)(repositoryRoot);
  if (!FULL_GIT_SHA.test(git.gitSha)) throw new Error("현재 checkout의 full git SHA를 확인할 수 없습니다.");
  if (!git.trackedClean) {
    throw new Error("현재 실행 코드 범위에 커밋되지 않은 변경이 있어 formal experiment를 실행할 수 없습니다.");
  }
  return {
    gitSha: git.gitSha,
    packageRuntimeSha256: await computeDeepRepairPackageRuntimeSha256(repositoryRoot),
    validatorVersion: DEEP_ANALYSIS_VALIDATOR_VERSION,
  };
}

async function readGitState(repositoryRoot: string): Promise<{ gitSha: string; trackedClean: boolean }> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const status = await execFileAsync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...EXECUTION_SOURCE_PATHS],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return { gitSha: stdout.trim(), trackedClean: status.stdout.trim() === "" };
}

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return listFiles(path);
    return entry.isFile() ? [path] : [];
  }));
  return nested.flat();
}
