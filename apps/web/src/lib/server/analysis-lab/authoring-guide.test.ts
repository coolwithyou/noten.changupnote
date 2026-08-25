import assert from "node:assert/strict";
import {
  authoringGuideMatchesSource,
  buildGrantAuthoringGuide,
  formatGrantAuthoringGuide,
  isGrantAuthoringGuideV1,
} from "./authoring-guide";

const sha = "a".repeat(64);
const guide = buildGrantAuthoringGuide({
  run: {
    runId: "run-1",
    inputSha256: sha,
    sourceRevisionSha256: "b".repeat(64),
    attachmentManifestSha256: "c".repeat(64),
    programIntent: {
      oneLiner: "  사업화   지원 ",
      targetProfile: "초기 창업기업",
      evaluationFocus: ["시장성", "시장성", "실행 역량"],
      benefitSummary: "사업화 자금",
      cautionNotes: ["허위 실적 금지"],
    },
  },
  criteria: [{
    id: "criterion-1",
    dimension: "region",
    kind: "required",
    operator: "in",
    value: { values: ["서울"] },
    confidence: 0.95,
    source_span: "서울 소재 기업",
    needs_review: false,
  }],
});

assert.ok(guide);
assert.equal(guide.intent.oneLiner, "사업화 지원");
assert.deepEqual(guide.intent.evaluationFocus, ["시장성", "실행 역량"]);
assert.equal(guide.evidenceChecklist.length, 1);
assert.equal(isGrantAuthoringGuideV1(guide), true);
assert.match(formatGrantAuthoringGuide(guide), /평가 포인트: 시장성/u);
assert.match(formatGrantAuthoringGuide(guide), /근거: 서울 소재 기업/u);
assert.equal(authoringGuideMatchesSource({
  guide,
  runId: "run-1",
  inputSha256: sha,
  sourceRevisionSha256: "b".repeat(64),
  attachmentManifestSha256: "c".repeat(64),
}), true);
assert.equal(authoringGuideMatchesSource({
  guide,
  runId: "run-1",
  inputSha256: sha,
  sourceRevisionSha256: "d".repeat(64),
  attachmentManifestSha256: "c".repeat(64),
}), false, "source revision drift가 있으면 작성 가이드를 모델 입력에 쓰지 않는다");
assert.equal(buildGrantAuthoringGuide({
  run: { runId: "legacy", inputSha256: sha, programIntent: null },
  criteria: [],
}), null);

console.log("authoring guide contract tests passed");
