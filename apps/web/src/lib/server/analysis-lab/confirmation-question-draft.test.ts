import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
  canonicalConfirmationQuestionDraftJson,
  confirmationQuestionDraftPacketBody,
  parseConfirmationQuestionDraftPacket,
} from "@cunote/contracts/confirmation-question-draft";
import type { LabCriterion, LabReview, LabRun } from "./lab-contract";
import {
  buildConfirmationQuestionDraftPacket,
  generateConfirmationQuestionDraftFromStoredRun,
  validateBoundManualConfirmationInput,
} from "./confirmation-question-draft";
import { saveLabReview } from "./review-store";
import { saveLabRun } from "./run-store";

const criterion = (kind: "required" | "preferred" | "exclusion", sourceSpan: string): LabCriterion => ({
  dimension: "other",
  kind,
  operator: "text_only",
  value: { note: sourceSpan },
  confidence: 0.9,
  sourceSpan,
  spanVerified: true,
  note: null,
});

const run: LabRun = {
  runId: "run-2026-09-09T000000.000Z-acde12",
  grantId: "00000000-0000-4000-8000-0000000002d0",
  source: "bizinfo",
  sourceId: "question-draft-v1",
  title: "확인질문 초안",
  model: "fixture",
  promptVersion: "fixture-v1",
  startedAt: "2026-09-09T00:00:00.000Z",
  durationMs: 1,
  inputBlocks: [],
  inputTotalChars: 1,
  inputSha256: "a".repeat(64),
  sourceRevisionSha256: "b".repeat(64),
  attachmentManifestSha256: "c".repeat(64),
  usage: null,
  costUsd: null,
  analysisMarkdown: "",
  programIntent: null,
  criteria: [
    criterion("required", "대표자는 공고일 기준 만 39세 이하여야 한다."),
    criterion("preferred", "수출 실적 보유 기업을 우대한다."),
    criterion("exclusion", "휴업 또는 폐업 중인 기업은 신청할 수 없다."),
    { ...criterion("required", "이미 질문이 있는 조건"), confirmation: {
      prompt: "기존 질문",
      options: [],
      answerType: "single",
      reusable: "per_notice",
      conditionKey: null,
    } },
  ],
  axisAssessments: [],
  taxonomyProposals: [],
  dimensionDiffs: [],
  primaryValidationOutcome: "publishable",
  matchingReadiness: "conditional",
  error: null,
};

const review: LabReview = {
  grantId: run.grantId,
  runId: run.runId,
  reviewerEmail: "reviewer@example.invalid",
  createdAt: "2026-09-09T00:01:00.000Z",
  updatedAt: "2026-09-09T00:02:00.000Z",
  criterionReviews: run.criteria.map((_, criterionIndex) => ({
    criterionIndex,
    verdict: "correct" as const,
    note: null,
  })),
  axisReviews: [],
  overallNote: null,
};

test("사람이 correct로 확정한 미질문 조건만 중립 문구와 명시적 3상태 극성으로 만든다", () => {
  const packet = buildConfirmationQuestionDraftPacket({
    run,
    review,
    runArtifactSha256: "d".repeat(64),
    reviewArtifactSha256: "e".repeat(64),
  });
  assert.equal(packet.items.length, 3);
  assert.match(packet.items[0]!.prompt, /필수 조건을 충족하나요/);
  assert.match(packet.items[0]!.prompt, /대표자는 공고일 기준/);
  assert.deepEqual(packet.items[2]!.options.map((option) => option.evaluation), [
    "unsatisfied",
    "satisfied",
    "unknown",
  ]);
  assert.equal(packet.authority.currentServiceStateVerified, false);
  assert.equal(packet.authority.liveQuestionWriteAuthorized, false);
  assert.equal(packet.contentSha256, createHash("sha256").update(
    canonicalConfirmationQuestionDraftJson(confirmationQuestionDraftPacketBody(packet)),
  ).digest("hex"));
});

test("문구가 exclusion처럼 보여도 kind가 required이면 극성을 뒤집지 않는다", () => {
  const misleadingRun = {
    ...run,
    criteria: [criterion("required", "휴업 기업은 제외한다.")],
  };
  const packet = buildConfirmationQuestionDraftPacket({
    run: misleadingRun,
    review: { ...review, criterionReviews: [{ criterionIndex: 0, verdict: "correct", note: null }] },
    runArtifactSha256: "d".repeat(64),
    reviewArtifactSha256: "e".repeat(64),
  });
  assert.equal(packet.items[0]!.criterionKind, "required");
  assert.equal(packet.items[0]!.options[0]!.evaluation, "satisfied");
});

test("검수 결속/중복/AI 작성자와 후보 없음은 fail-closed한다", () => {
  const hashes = { runArtifactSha256: "d".repeat(64), reviewArtifactSha256: "e".repeat(64) };
  assert.throws(() => buildConfirmationQuestionDraftPacket({
    run,
    review: { ...review, runId: "different" },
    ...hashes,
  }), /run과 일치하지/);
  assert.throws(() => buildConfirmationQuestionDraftPacket({
    run,
    review: { ...review, criterionReviews: [review.criterionReviews[0]!, review.criterionReviews[0]!] },
    ...hashes,
  }), /중복/);
  assert.throws(() => buildConfirmationQuestionDraftPacket({
    run,
    review: { ...review, reviewerEmail: "gpt-reviewer@example.invalid" },
    ...hashes,
  }), /AI 라벨러/);
  assert.throws(() => buildConfirmationQuestionDraftPacket({
    run,
    review: { ...review, criterionReviews: review.criterionReviews.map((item) => ({ ...item, verdict: "wrong" })) },
    ...hashes,
  }), /후보가 없습니다/);
});

test("저장 workflow는 원 run/review를 보존하고 동일 입력을 같은 content address에 idempotent 저장한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cunote-question-draft-"));
  const previousCwd = process.cwd();
  try {
    await writeFile(join(directory, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    process.chdir(directory);
    const runPath = await saveLabRun(run);
    await saveLabReview(review);
    const runBefore = await readFile(runPath);
    const outputDirectory = join(directory, "drafts");
    const first = await generateConfirmationQuestionDraftFromStoredRun({
      grantId: run.grantId,
      runId: run.runId,
      outputDirectory,
    });
    const second = await generateConfirmationQuestionDraftFromStoredRun({
      grantId: run.grantId,
      runId: run.runId,
      outputDirectory,
    });
    assert.equal(first.path, second.path);
    assert.deepEqual(first.packet, second.packet);
    assert.deepEqual(await readFile(runPath), runBefore);
    assert.deepEqual(
      parseConfirmationQuestionDraftPacket(JSON.parse(await readFile(first.path, "utf8"))),
      first.packet,
    );
  } finally {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
});

test("bound manual input은 raw run/review와 packet criterion을 재결속하고 wrong-run/drift를 거부한다", () => {
  const runArtifactBytes = Buffer.from(`${JSON.stringify(run, null, 2)}\n`);
  const reviewArtifactBytes = Buffer.from(`${JSON.stringify(review, null, 2)}\n`);
  const packet = buildConfirmationQuestionDraftPacket({
    run,
    review,
    runArtifactSha256: createHash("sha256").update(runArtifactBytes).digest("hex"),
    reviewArtifactSha256: createHash("sha256").update(reviewArtifactBytes).digest("hex"),
  });
  const raw = {
    schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
    draftPacket: packet,
    manualInput: {
      questionAuthorEmail: "author@example.invalid",
      items: [{
        criterionIndex: packet.items[0]!.criterionIndex,
        resolutionScope: "per_notice",
        prompt: "관리자가 검토한 질문",
        options: packet.items[0]!.options,
      }],
    },
  };
  const validated = validateBoundManualConfirmationInput({
    raw,
    runArtifactBytes,
    reviewArtifactBytes,
  });
  assert.equal(validated.run.runId, run.runId);
  assert.equal(validated.manualInput.items[0]?.prompt, "관리자가 검토한 질문");

  const wrongRunBytes = Buffer.from(JSON.stringify({
    ...run,
    criteria: [{ ...run.criteria[0]!, sourceSpan: "같은 index의 다른 run 조건" }, ...run.criteria.slice(1)],
  }));
  assert.throws(() => validateBoundManualConfirmationInput({
    raw,
    runArtifactBytes: wrongRunBytes,
    reviewArtifactBytes,
  }), /raw run\/review와 일치하지/);

  const driftedReviewBytes = Buffer.from(JSON.stringify({
    ...review,
    updatedAt: "2026-09-09T00:03:00.000Z",
  }));
  assert.throws(() => validateBoundManualConfirmationInput({
    raw,
    runArtifactBytes,
    reviewArtifactBytes: driftedReviewBytes,
  }), /raw run\/review와 일치하지/);
});
