import { execFileSync } from "node:child_process";
import { findMonorepoRoot } from "./run-store";

export interface PromotionBuildProvenance {
  gitCommit: string;
  buildDigest: string;
}

export type PromotionGitReader = (args: readonly string[]) => string;

const RELEASE_CODE_PATHS = [
  "apps/web/src",
  "packages",
  "scripts",
  "tools",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
] as const;

/**
 * Release provenance는 실행 코드와 tracked source만 봉인한다.
 *
 * 전체 `git status`를 cleanliness 계약으로 사용하면 release와 무관한 사용자 소유
 * 미추적 문서까지 실행 권한에 결합된다. tracked 변경은 저장소 전체에서 거부하고,
 * 미추적 파일은 실제 build/import 경로에 들어올 수 있는 위치만 거부한다. 분석 결과와
 * release artifact는 별도 content hash로 검증하므로 이 검사에 섞지 않는다.
 */
export function readPromotionBuildProvenance(options: {
  readGit?: PromotionGitReader;
} = {}): PromotionBuildProvenance {
  const readGit = options.readGit ?? defaultGitReader;
  const trackedChanges = readGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=no",
  ]);
  if (trackedChanges) {
    throw new Error("release 실행 코드의 tracked 변경을 먼저 검증하고 커밋해주세요.");
  }

  const untrackedReleaseCode = readGit([
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...RELEASE_CODE_PATHS,
  ]);
  if (untrackedReleaseCode) {
    throw new Error("release build/import 경로에 미추적 파일이 있습니다. 출처를 먼저 확정해주세요.");
  }

  return {
    gitCommit: readGit(["rev-parse", "HEAD"]),
    buildDigest: readGit(["rev-parse", "HEAD^{tree}"]),
  };
}

function defaultGitReader(args: readonly string[]): string {
  return execFileSync("git", [...args], {
    cwd: findMonorepoRoot(),
    encoding: "utf8",
  }).trim();
}
