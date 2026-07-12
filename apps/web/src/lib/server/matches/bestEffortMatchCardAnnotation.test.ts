import assert from "node:assert/strict";
import type { MatchCard } from "@cunote/contracts";
import {
  bestEffortMatchCardAnnotation,
  PROFILE_QUESTION_MATCH_ANNOTATION_ERROR_CODE,
} from "./bestEffortMatchCardAnnotation";

const original = [card("ai_draft")];
const annotated = [card("template_fill")];
const successLogs: string[] = [];
const success = await bestEffortMatchCardAnnotation(
  original,
  async (cards) => {
    assert.equal(cards, original);
    return annotated;
  },
  (code) => successLogs.push(code),
);
assert.equal(success, annotated);
assert.deepEqual(successLogs, []);

const failureLogs: string[] = [];
const failure = await bestEffortMatchCardAnnotation(
  original,
  async () => {
    throw new Error("sensitive database detail");
  },
  (code) => failureLogs.push(code),
);
assert.equal(failure, original, "annotation failure must return the original card array");
assert.deepEqual(failureLogs, [PROFILE_QUESTION_MATCH_ANNOTATION_ERROR_CODE]);
assert.equal(failureLogs.join(" ").includes("sensitive"), false);

console.log("best-effort-match-card-annotation: ok");

function card(writeSupport: MatchCard["writeSupport"]): MatchCard {
  return {
    grantId: "bizinfo:test-grant",
    source: "bizinfo",
    sourceId: "test-grant",
    title: "테스트 공고",
    status: "open",
    eligibility: "eligible",
    bucket: "recommended",
    fitScore: 100,
    writeSupport,
    deadline: null,
    summary: "테스트",
    reasons: [],
    cautions: [],
    ruleTrace: [],
  } as unknown as MatchCard;
}
