import assert from "node:assert/strict";
import { isHumanReviewVerdictForItemKind } from "@cunote/contracts";
import {
  overlapStatusForVerdicts,
  sanitizeReviewPayload,
} from "./dispatchReview";

const payload = {
  sourceItemKey: "criterion:1",
  criterion: { dimension: "region", sourceSpan: "서울 소재 기업" },
  aiVerdict: "correct",
  aiAudit: { verdict: "unsure", note: "다시 확인" },
  nested: {
    reviewerEmail: "other@noten.im",
    otherReviewerDecision: "wrong",
    safeContext: "유지",
  },
};

assert.deepEqual(sanitizeReviewPayload(payload, false), payload, "비-blind payload는 원문 맥락을 유지한다");
assert.deepEqual(
  sanitizeReviewPayload(payload, true),
  {
    sourceItemKey: "criterion:1",
    criterion: { dimension: "region", sourceSpan: "서울 소재 기업" },
    nested: { safeContext: "유지" },
  },
  "blind payload는 AI·감사·타 검수자 앵커를 재귀적으로 제거해야 한다",
);
assert.equal(overlapStatusForVerdicts(["correct", null]), "pending");
assert.equal(overlapStatusForVerdicts(["correct", "correct"]), "decided");
assert.equal(overlapStatusForVerdicts(["correct", "wrong"]), "conflict");
assert.equal(isHumanReviewVerdictForItemKind("axis", "unsure"), false, "축 unsure는 파일 계약과 어긋나므로 저장할 수 없다");
assert.equal(isHumanReviewVerdictForItemKind("criterion", "unsure"), true);

console.log("dispatch-review tests: ok");
