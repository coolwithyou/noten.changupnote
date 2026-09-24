import assert from "node:assert/strict";
import test from "node:test";
import { assertPromotionApprovalArtifactBinding } from "./promote-cli";

const sha = (digit: string) => digit.repeat(64);
const ledger = {
  releaseId: "release-exact-1",
  manifestSha256: sha("a"),
  releasePlanSha256: sha("b"),
  approvedBy: "approver",
  approvedAt: "2026-09-24T00:00:00.000Z",
  approvalArtifactSha256: sha("c"),
  gateSummary: {
    aggregateSha256: sha("d"),
    shadowSha256: sha("e"),
    dryRunSha256: sha("f"),
  },
};
const artifact = {
  schema: "analysis-lab-promotion-approval-v1",
  releaseId: ledger.releaseId,
  manifestSha256: ledger.manifestSha256,
  releasePlanSha256: ledger.releasePlanSha256,
  approvedBy: ledger.approvedBy,
  approvedAt: ledger.approvedAt,
  aggregateSha256: ledger.gateSummary.aggregateSha256,
  shadowSha256: ledger.gateSummary.shadowSha256,
  dryRunSha256: ledger.gateSummary.dryRunSha256,
};

test("실제 발행 전 승인 파일 hash와 exact gate 결속을 재검증한다", () => {
  assert.doesNotThrow(() => assertPromotionApprovalArtifactBinding(
    ledger, artifact, ledger.approvalArtifactSha256,
  ));
  assert.throws(() => assertPromotionApprovalArtifactBinding(
    ledger, artifact, sha("0"),
  ), /hash가 다릅니다/);
  assert.throws(() => assertPromotionApprovalArtifactBinding(
    ledger, { ...artifact, dryRunSha256: sha("0") }, ledger.approvalArtifactSha256,
  ), /gate 결속이 다릅니다/);
  assert.throws(() => assertPromotionApprovalArtifactBinding(
    ledger, { ...artifact, approvedBy: "executor" }, ledger.approvalArtifactSha256,
  ), /gate 결속이 다릅니다/);
});
