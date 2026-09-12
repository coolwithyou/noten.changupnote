import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findMonorepoRoot } from "./run-store";

const execFileAsync = promisify(execFile);
const FULL_GIT_SHA = /^[a-f0-9]{40}$/u;

/**
 * RHWP field 판정·구조 결속 결과에 직접 관여하는 semantic dependency 집합이다.
 * 저장·DB 조회·launch orchestration은 결과 의미를 바꾸지 않으므로 포함하지 않는다.
 */
export const APPLICATION_FIELD_RUNTIME_PATHS = Object.freeze([
  "apps/web/src/lib/server/application-analysis/analyze-document.ts",
  "apps/web/src/lib/server/application-analysis/contract.ts",
  "apps/web/src/lib/server/application-analysis/core.ts",
  "apps/web/src/lib/server/application-analysis/editable-regions.ts",
  "apps/web/src/lib/server/application-analysis/field-coverage.ts",
  "apps/web/src/lib/server/application-analysis/field-planner.ts",
  "apps/web/src/lib/server/application-analysis/hwp-form-controls.ts",
  "apps/web/src/lib/server/application-analysis/native-paragraph-bindings.ts",
  "apps/web/src/lib/server/application-analysis/ole-stream.ts",
  "apps/web/src/lib/server/deep-analysis/costPolicy.ts",
  "apps/web/src/lib/server/documents/applicationAnalysisContract.ts",
  "apps/web/src/lib/server/rhwp/documentAgentCore.ts",
] as const);

export async function computeApplicationFieldRuntimeSha256(input: {
  readonly repositoryRoot?: string;
  /** 과거 launch가 봉인한 exact checkout. 생략하면 현재 working tree bytes를 읽는다. */
  readonly gitSha?: string;
} = {}): Promise<string> {
  const repositoryRoot = input.repositoryRoot ?? findMonorepoRoot();
  if (input.gitSha !== undefined && !FULL_GIT_SHA.test(input.gitSha)) {
    throw new Error("field runtime source git SHA가 잘못됐습니다.");
  }
  const files = await Promise.all(APPLICATION_FIELD_RUNTIME_PATHS.map(async (path) => {
    const bytes = input.gitSha
      ? await readGitBlob(repositoryRoot, input.gitSha, path)
      : await readFile(join(repositoryRoot, path));
    return Object.freeze({
      path,
      byteLength: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }));
  return createHash("sha256").update(JSON.stringify({
    schema: "application-field-runtime-v1",
    files,
  })).digest("hex");
}

async function readGitBlob(repositoryRoot: string, gitSha: string, path: string): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", ["show", `${gitSha}:${path}`], {
      cwd: repositoryRoot,
      encoding: "buffer",
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch {
    throw new Error(`field runtime source blob을 읽을 수 없습니다: ${gitSha}:${path}`);
  }
}
