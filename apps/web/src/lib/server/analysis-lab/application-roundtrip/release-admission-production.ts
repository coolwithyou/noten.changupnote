import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { findMonorepoRoot } from "../run-store";
import {
  createApplicationRoundtripReleaseAdmission,
  type ApplicationRoundtripReceiptArtifact,
} from "./release-admission";

const execFileAsync = promisify(execFile);

let admission: ReturnType<typeof createApplicationRoundtripReleaseAdmission> | null = null;

export function admitApplicationRoundtripRelease(input: {
  readonly grantId: string;
  readonly deepReceiptSha256: string;
}) {
  return getApplicationRoundtripReleaseAdmission().admit(input);
}

/**
 * 로컬 실험실 파일 경로는 실제 release admission 실행 시점에만 해석한다.
 * 이 모듈은 일반 서비스의 promotion serving 검증에서도 import되므로, Vercel 런타임처럼
 * pnpm-workspace.yaml이 없는 환경에서 import만으로 전체 서버 라우트를 중단하면 안 된다.
 */
function getApplicationRoundtripReleaseAdmission() {
  if (admission) return admission;

  const repositoryRoot = findMonorepoRoot();
  const roundtripRoot = join(repositoryRoot, "spike-out", "analysis-lab", "application-roundtrip");
  const canaryReceiptRoot = join(roundtripRoot, "canary-receipts");
  const policyReceiptRoot = join(roundtripRoot, "canary-policy-receipts");
  const proposalRoot = join(roundtripRoot, "proposals");

  admission = createApplicationRoundtripReleaseAdmission({
    listCanaryReceipts: () => listReceiptArtifacts(canaryReceiptRoot),
    listPolicyReceipts: () => listReceiptArtifacts(policyReceiptRoot),
    readProposal: (proposalSha256) => readFile(join(proposalRoot, `${proposalSha256}.json`)),
    async isGitAncestor(gitSha) {
      try {
        await execFileAsync("git", ["merge-base", "--is-ancestor", gitSha, "HEAD"], {
          cwd: repositoryRoot,
        });
        return true;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === 1) return false;
        throw error;
      }
    },
  });
  return admission;
}

async function listReceiptArtifacts(dir: string): Promise<ApplicationRoundtripReceiptArtifact[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return Promise.all(files
    .filter((file) => /^[a-f0-9]{64}\.json$/u.test(file))
    .sort()
    .map(async (file) => ({
      sha256: file.slice(0, -5),
      bytes: await readFile(join(dir, file)),
    })));
}
