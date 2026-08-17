import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";
import { writeImmutableBytesAtomic } from "../immutable-artifact-fs";
import { findMonorepoRoot } from "../run-store";
import { createApplicationRoundtripCanaryPolicyRunner } from "./canary-policy";
import { readRoundtripRunArtifacts } from "./store";

const repositoryRoot = findMonorepoRoot();
const roundtripRoot = join(repositoryRoot, "spike-out", "analysis-lab", "application-roundtrip");
const canaryReceiptRoot = join(roundtripRoot, "canary-receipts");
const policyReceiptRoot = join(roundtripRoot, "canary-policy-receipts");
const execFileAsync = promisify(execFile);

const runner = createApplicationRoundtripCanaryPolicyRunner({
  async readPolicyGitSha() {
    const [{ stdout: gitSha }, { stdout: trackedStatus }] = await Promise.all([
      execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
      execFileAsync("git", ["status", "--short", "--untracked-files=no"], { cwd: repositoryRoot }),
    ]);
    if (trackedStatus.trim()) {
      throw new Error("Kordoc policy receipt는 tracked worktree가 clean인 exact commit에서만 만들 수 있습니다.");
    }
    return gitSha.trim();
  },
  readParentReceipt: (sha256) => readFile(join(canaryReceiptRoot, `${sha256}.json`)),
  async readRunArtifact(binding) {
    const artifacts = await readRoundtripRunArtifacts(binding.grantId, binding.runId);
    if (!artifacts) return null;
    const path = relative(repositoryRoot, join(artifacts.dir, "analysis.json")).split(sep).join("/");
    if (path !== binding.artifactPath) return null;
    return readFile(join(artifacts.dir, "analysis.json"));
  },
  async writePolicyReceipt({ sha256, bytes }) {
    await mkdir(policyReceiptRoot, { recursive: true });
    await writeImmutableBytesAtomic(join(policyReceiptRoot, `${sha256}.json`), bytes);
  },
});

export function evaluateLegacyApplicationRoundtripCanaryReceipt(receiptSha256: string) {
  return runner.evaluate(receiptSha256);
}

export function applicationRoundtripCanaryPolicyReceiptPath(receiptSha256: string): string {
  return relative(repositoryRoot, join(policyReceiptRoot, `${receiptSha256}.json`)).split(sep).join("/");
}
