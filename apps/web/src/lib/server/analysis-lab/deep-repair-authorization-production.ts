import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { getCunoteDb } from "@/lib/server/db/client";
import { readDeepAnalysisRuntimeAdmissionSnapshot } from "@/lib/server/deep-analysis/runtimeControl";
import { prepareLabAnalysis } from "./analyze";
import { createDeepRepairAuthorityIssuer } from "./deep-repair-authorization";
import { createDeepRepairAuthorizationFilesystemRepository } from "./deep-repair-authorization-fs";
import { captureCurrentDeepRepairOperationalEvidence } from "./deep-repair-operational-guard";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";

const execFileAsync = promisify(execFile);
const ADMISSION_ONLY_CONTINUATION_FILES = new Set([
  "apps/web/src/lib/server/analysis-lab/deep-repair-authorization.ts",
  "apps/web/src/lib/server/analysis-lab/deep-repair-authorization-fs.ts",
  "apps/web/src/lib/server/analysis-lab/deep-repair-authorization-production.ts",
  "apps/web/src/lib/server/analysis-lab/deep-repair-live-experiment.ts",
  "apps/web/src/lib/server/analysis-lab/deep-repair-live-fs.ts",
  "apps/web/src/lib/server/analysis-lab/deep-repair-authorization.test.ts",
  "apps/web/src/lib/server/analysis-lab/deep-repair-authorization-fs.test.ts",
  "apps/web/src/lib/server/analysis-lab/deep-repair-live-experiment.test.ts",
  "apps/web/src/lib/server/analysis-lab/deep-repair-live-fs.test.ts",
]);

const issuer = createDeepRepairAuthorityIssuer({
  repository: createDeepRepairAuthorizationFilesystemRepository(),
  now: () => new Date(),
  createOwnerId: () => randomUUID(),
  async prepareTarget({ grantId, signal }) {
    signal.throwIfAborted();
    const prepared = await prepareLabAnalysis(grantId);
    signal.throwIfAborted();
    return {
      grantId: prepared.grant.id,
      inputSha256: prepared.input.inputSha256,
      attachmentManifestSha256: prepared.input.attachmentManifestSha256,
    };
  },
  readExecutionProvenance: readCurrentDeepRepairExecutionProvenance,
  async verifyAdmissionOnlyContinuation({ sealed, current }) {
    if (
      sealed.packageRuntimeSha256 !== current.packageRuntimeSha256
      || sealed.validatorVersion !== current.validatorVersion
      || sealed.gitSha === current.gitSha
    ) {
      throw new Error("sealed analysis runtime과 continuation provenance의 필수 결속이 다릅니다.");
    }
    const root = process.cwd();
    await execFileAsync("git", ["merge-base", "--is-ancestor", sealed.gitSha, current.gitSha], {
      cwd: root,
      encoding: "utf8",
    });
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", `${sealed.gitSha}..${current.gitSha}`],
      { cwd: root, encoding: "utf8" },
    );
    const changed = stdout.split("\n").map((path) => path.trim()).filter(Boolean);
    if (
      changed.length === 0
      || changed.some((path) => !ADMISSION_ONLY_CONTINUATION_FILES.has(path))
    ) {
      throw new Error(`허용되지 않은 변경 파일이 있습니다: ${changed.join(", ")}`);
    }
  },
  captureOperationalEvidence: captureCurrentDeepRepairOperationalEvidence,
  async readRuntimeControl() {
    const control = await readDeepAnalysisRuntimeAdmissionSnapshot(getCunoteDb());
    return {
      mode: control.mode,
      generation: control.generation,
      localOwnerId: control.localOwnerId,
      localLeaseExpiresAt: control.localLeaseExpiresAt,
      databaseObservedAt: control.databaseObservedAt,
      activeDeepLeases: control.activeDeepLeases,
      activeApplicationLeases: control.activeApplicationLeases,
    };
  },
});

/** 현재 정본을 다시 읽어 사용자 승인 한 건에 결속된 단건 authority만 발급한다. */
export function issueApprovedDeepRepairAuthority(input: {
  readonly approvalId: string;
  readonly signal: AbortSignal;
}) {
  return issuer.issueApprovedDeepRepairAuthority(input);
}
