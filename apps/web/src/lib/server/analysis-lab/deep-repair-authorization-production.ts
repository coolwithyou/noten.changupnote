import { randomUUID } from "node:crypto";
import { getCunoteDb } from "@/lib/server/db/client";
import { getDeepAnalysisRuntimeControl } from "@/lib/server/deep-analysis/runtimeControl";
import { prepareLabAnalysis } from "./analyze";
import { createDeepRepairAuthorityIssuer } from "./deep-repair-authorization";
import { createDeepRepairAuthorizationFilesystemRepository } from "./deep-repair-authorization-fs";
import { captureCurrentDeepRepairOperationalEvidence } from "./deep-repair-operational-guard";
import { readCurrentDeepRepairExecutionProvenance } from "./deep-repair-runtime-provenance";

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
  captureOperationalEvidence: captureCurrentDeepRepairOperationalEvidence,
  async readRuntimeControl() {
    const control = await getDeepAnalysisRuntimeControl(getCunoteDb());
    return {
      mode: control.mode,
      generation: control.generation,
      localOwnerId: control.localOwnerId,
      localLeaseExpiresAt: control.localLeaseExpiresAt,
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
