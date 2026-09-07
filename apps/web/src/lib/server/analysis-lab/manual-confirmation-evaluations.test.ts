import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LabCriterion, LabReview, LabRun } from "./lab-contract";
import {
  buildManualConfirmationEvaluationsArtifact,
  buildManualConfirmationEvaluationsRevisionArtifact,
  classifyManualConfirmationCriterion,
  manualConfirmationEvaluationSelectionForArtifact,
  mergeManualConfirmationEvaluations,
  readManualConfirmationEvaluations,
  readSelectedManualConfirmationEvaluations,
  resolveManualConfirmationEvaluationsForPreparation,
  saveManualConfirmationEvaluations,
  saveManualConfirmationEvaluationsRevision,
} from "./manual-confirmation-evaluations";
import { LAB_CONFIRMATIONS_SCHEMA, type LabConfirmationsFile } from "./confirmations";
import { planGrantPromotion, questionDefinitionSha256 } from "./promote";
import {
  capturePrimaryMatchingProjectionSnapshot,
  primaryProjectionSource,
} from "./primary-matching-projection";
import { saveLabReview } from "./review-store";
import {
  listLabRunSummaries,
  readLabRun,
  readLatestLabRun,
  readLatestLabRunIndex,
  saveLabRun,
} from "./run-store";

const criterion: LabCriterion = {
  dimension: "other",
  kind: "required",
  operator: "text_only",
  value: { note: "대표자가 직접 확인해야 하는 공고별 요건" },
  confidence: 0.9,
  sourceSpan: "대표자가 이 요건을 충족하는 기업",
  spanVerified: true,
  note: null,
};
let run: LabRun = {
  runId: "run-manual-confirmation-v2",
  grantId: "00000000-0000-4000-8000-0000000002c0",
  source: "bizinfo",
  sourceId: "manual-v2",
  title: "수동 질문 왕복",
  model: "fixture",
  promptVersion: "fixture-v1",
  startedAt: "2026-09-07T00:00:00.000Z",
  durationMs: 1,
  inputBlocks: [],
  inputTotalChars: 1,
  inputSha256: "a".repeat(64),
  sourceRevisionSha256: "b".repeat(64),
  usage: null,
  costUsd: null,
  analysisMarkdown: "",
  programIntent: null,
  criteria: [criterion],
  axisAssessments: [],
  taxonomyProposals: [],
  dimensionDiffs: [],
  primaryValidationOutcome: "publishable",
  matchingReadiness: "conditional",
  error: null,
};
run = {
  ...run,
  primaryMatchingProjection: capturePrimaryMatchingProjectionSnapshot({
    source: primaryProjectionSource({
      runId: run.runId,
      grantId: run.grantId,
      source: run.source,
      sourceId: run.sourceId,
      inputSha256: run.inputSha256,
      criteria: run.criteria,
    }),
    primaryExtractionAvailable: true,
  }),
};
const review: LabReview = {
  grantId: run.grantId,
  runId: run.runId,
  reviewerEmail: "reviewer@example.invalid",
  createdAt: "2026-09-07T00:01:00.000Z",
  updatedAt: "2026-09-07T00:01:00.000Z",
  criterionReviews: [{ criterionIndex: 0, verdict: "correct", note: null }],
  axisReviews: [],
  overallNote: null,
};
const items = [{
  criterionIndex: 0,
  resolutionScope: "per_notice",
  prompt: "이 공고의 해당 요건을 충족하나요?",
  options: [
    { value: "yes", label: "충족해요", evaluation: "satisfied" as const },
    { value: "no", label: "충족하지 않아요", evaluation: "unsatisfied" as const },
    { value: "unknown", label: "확인할 수 없어요", evaluation: "unknown" as const },
  ],
}];
const artifact = buildManualConfirmationEvaluationsArtifact({
  run,
  review,
  createdAt: "2026-09-07T00:02:00.000Z",
  items,
});
assert.equal(mergeManualConfirmationEvaluations(run, artifact).criteria[0]?.confirmation?.evaluationContractVersion, "confirmation-evaluation-v2");
const plan = planGrantPromotion({
  run,
  review,
  origin: "human",
  sidecar: null,
  manualEvaluationSidecar: artifact,
  sourceRawSha256: "c".repeat(64),
});
assert.equal(plan.questions[0]?.evaluationContractVersion, "confirmation-evaluation-v2");
assert.equal(plan.questions[0]?.sourceRawSha256, "c".repeat(64));
assert.equal(plan.questions[0]?.criterionIndex, 0);
assert.equal(plan.questions[0]?.resolutionState, "confirmed_correct");

const { primaryMatchingProjection: _projection, ...legacyWithoutProjection } = run;
const inlineV2 = mergeManualConfirmationEvaluations(legacyWithoutProjection as LabRun, artifact);
assert.throws(() => planGrantPromotion({
  run: inlineV2,
  review,
  origin: "human",
  sidecar: null,
  sourceRawSha256: "c".repeat(64),
}), /검증된 manual sidecar가 필요/);

const definition = {
  prompt: items[0]!.prompt,
  options: items[0]!.options,
  answerType: "single" as const,
  reusable: "per_notice" as const,
  conditionKey: null,
  evaluationContractVersion: "confirmation-evaluation-v2" as const,
  sourceRevisionSha256: run.sourceRevisionSha256!,
};
assert.notEqual(
  questionDefinitionSha256({ ...definition, sourceRawSha256: "c".repeat(64) }),
  questionDefinitionSha256({ ...definition, sourceRawSha256: "d".repeat(64) }),
  "source-only drift는 새 question definition/ID를 요구한다",
);

assert.equal(classifyManualConfirmationCriterion({
  ...criterion,
  value: { note: "원문 모순", downgrade_reason: "exclusive_upper_bound_mismatch" },
}), "admin_source_review");

assert.throws(() => buildManualConfirmationEvaluationsArtifact({
  run,
  review: { ...review, reviewerEmail: "claude-reviewer@example.invalid" },
  createdAt: "2026-09-07T00:02:00.000Z",
  items,
}), /AI 라벨러/);
assert.throws(() => buildManualConfirmationEvaluationsArtifact({
  run,
  review,
  questionAuthorEmail: "gpt-question-author@example.invalid",
  createdAt: "2026-09-07T00:02:00.000Z",
  items,
}), /AI 라벨러/);

// 실제 filesystem workflow: immutable run → 사람 review → immutable manual sidecar →
// run 목록/단건 읽기 → 파생 merge/plan. sidecar 생성 전후 원 run bytes는 같아야 한다.
const directory = await mkdtemp(join(tmpdir(), "cunote-manual-confirmation-"));
const previousCwd = process.cwd();
try {
  await writeFile(join(directory, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
  process.chdir(directory);
  const fsRunBase: LabRun = {
    ...run,
    runId: "run-2026-09-07T000000.000Z-acde12",
  };
  const fsRun: LabRun = {
    ...fsRunBase,
    primaryMatchingProjection: capturePrimaryMatchingProjectionSnapshot({
      source: primaryProjectionSource({
        runId: fsRunBase.runId,
        grantId: fsRunBase.grantId,
        source: fsRunBase.source,
        sourceId: fsRunBase.sourceId,
        inputSha256: fsRunBase.inputSha256,
        criteria: fsRunBase.criteria,
      }),
      primaryExtractionAvailable: true,
    }),
  };
  const fsReview: LabReview = {
    ...review,
    runId: fsRun.runId,
  };
  const fsArtifact = buildManualConfirmationEvaluationsArtifact({
    run: fsRun,
    review: fsReview,
    questionAuthorEmail: "question-author@example.invalid",
    createdAt: "2026-09-07T00:02:00.000Z",
    items,
  });
  const runPath = await saveLabRun(fsRun);
  await saveLabReview(fsReview);
  const beforeSha256 = createHash("sha256").update(await readFile(runPath)).digest("hex");
  const path = await saveManualConfirmationEvaluations(fsArtifact, fsRun);
  assert.deepEqual(await readManualConfirmationEvaluations(fsRun, path), fsArtifact);
  await assert.rejects(() => saveManualConfirmationEvaluations(fsArtifact, fsRun, path), { code: "EEXIST" });
  assert.equal(createHash("sha256").update(await readFile(runPath)).digest("hex"), beforeSha256);

  const summaries = await listLabRunSummaries(fsRun.source, fsRun.sourceId);
  assert.deepEqual(summaries.map((summary) => summary.runId), [fsRun.runId]);
  assert.equal((await readLatestLabRun(fsRun.source, fsRun.sourceId))?.runId, fsRun.runId);
  assert.equal((await readLatestLabRunIndex()).get(fsRun.grantId)?.runId, fsRun.runId);
  const storedRun = await readLabRun(fsRun.grantId, fsRun.runId);
  assert.deepEqual(storedRun, fsRun);
  const storedArtifact = await readManualConfirmationEvaluations(storedRun!);
  const fsPlan = planGrantPromotion({
    run: storedRun!,
    review: fsReview,
    origin: "human",
    sidecar: null,
    manualEvaluationSidecar: storedArtifact,
    sourceRawSha256: "c".repeat(64),
  });
  assert.equal(fsPlan.questions[0]?.evaluationContractVersion, "confirmation-evaluation-v2");
  assert.equal(fsArtifact.criterionReviewerEmail, fsReview.reviewerEmail);
  assert.equal(fsArtifact.questionAuthorEmail, "question-author@example.invalid");

  // 같은 immutable run에 full-snapshot revision을 연속 발행한다. required/preferred/exclusion
  // 질문은 독립적으로 유지되고, 철회한 manual 질문이 legacy 질문까지 지우지는 않는다.
  const revisionCriteria = (["required", "preferred", "exclusion"] as const).map(
    (kind, index): LabCriterion => ({
      ...criterion,
      kind,
      sourceSpan: `검수된 공고별 조건 ${index}`,
      value: { note: `공고별 조건 ${index}` },
    }),
  );
  const revisionRunBase: LabRun = {
    ...fsRun,
    runId: "run-2026-09-08T000000.000Z-abc123",
    criteria: revisionCriteria,
  };
  const revisionRun: LabRun = {
    ...revisionRunBase,
    primaryMatchingProjection: capturePrimaryMatchingProjectionSnapshot({
      source: primaryProjectionSource({
        runId: revisionRunBase.runId,
        grantId: revisionRunBase.grantId,
        source: revisionRunBase.source,
        sourceId: revisionRunBase.sourceId,
        inputSha256: revisionRunBase.inputSha256,
        criteria: revisionRunBase.criteria,
      }),
      primaryExtractionAvailable: true,
    }),
  };
  const revisionReview: LabReview = {
    ...fsReview,
    runId: revisionRun.runId,
    criterionReviews: revisionCriteria.map((_, criterionIndex) => ({
      criterionIndex,
      verdict: "correct" as const,
      note: null,
    })),
  };
  const question = (criterionIndex: number, prompt = `질문 ${criterionIndex}`) => ({
    criterionIndex,
    resolutionScope: "per_notice" as const,
    prompt,
    options: items[0]!.options,
  });
  const revision1 = buildManualConfirmationEvaluationsArtifact({
    run: revisionRun,
    review: revisionReview,
    questionAuthorEmail: "question-author@example.invalid",
    createdAt: "2026-09-08T00:01:00.000Z",
    items: [question(0), question(1), question(2)],
  });
  await saveManualConfirmationEvaluations(revision1, revisionRun);
  const revision1Selection = manualConfirmationEvaluationSelectionForArtifact(revision1);
  const selected1 = await readSelectedManualConfirmationEvaluations(
    revisionRun,
    revision1Selection,
  );
  const revision2 = buildManualConfirmationEvaluationsRevisionArtifact({
    run: revisionRun,
    review: revisionReview,
    parent: selected1,
    questionAuthorEmail: "question-author@example.invalid",
    createdAt: "2026-09-08T00:02:00.000Z",
    intent: "replace",
    withdrawnCriterionIndexes: [2],
    items: [question(0, "수정된 질문 0"), question(1)],
  });
  await saveManualConfirmationEvaluationsRevision(revision2, revisionRun);
  const revision2Selection = manualConfirmationEvaluationSelectionForArtifact(revision2);
  const selected2 = await readSelectedManualConfirmationEvaluations(
    revisionRun,
    revision2Selection,
  );
  assert.deepEqual(selected2.artifact.items.map((item) => item.criterionIndex), [0, 1]);
  assert.throws(() => planGrantPromotion({
    run: revisionRun,
    review: revisionReview,
    origin: "human",
    sidecar: null,
    manualEvaluationSidecar: selected2.artifact,
    sourceRawSha256: "c".repeat(64),
  }), /exact selection/);
  await assert.rejects(
    () => resolveManualConfirmationEvaluationsForPreparation(revisionRun),
    /명시적으로 선택/,
  );
  const legacySidecar: LabConfirmationsFile = {
    schema: LAB_CONFIRMATIONS_SCHEMA,
    grantId: revisionRun.grantId,
    runId: revisionRun.runId,
    model: "fixture",
    promptVersion: "confirmations-v1",
    createdAt: "2026-09-08T00:02:30.000Z",
    usage: null,
    costUsd: null,
    items: [{
      criterionIndex: 2,
      confirmation: {
        prompt: "기존 exclusion 질문",
        options: [
          { value: "yes", label: "해당해요", disqualifies: true },
          { value: "no", label: "해당하지 않아요", disqualifies: false },
        ],
        answerType: "single",
        reusable: "per_notice",
        conditionKey: null,
      },
    }],
  };
  const revision2Plan = planGrantPromotion({
    run: revisionRun,
    review: revisionReview,
    origin: "human",
    sidecar: legacySidecar,
    manualEvaluationSidecar: selected2.artifact,
    manualConfirmationEvaluationSelection: selected2.selection,
    sourceRawSha256: "c".repeat(64),
  });
  assert.equal(revision2Plan.criteria.length, 3);
  assert.deepEqual(
    revision2Plan.questions.map((entry) => entry.evaluationContractVersion ?? "legacy"),
    ["confirmation-evaluation-v2", "confirmation-evaluation-v2", "legacy"],
  );
  assert.equal(revision2Plan.questions[0]?.prompt, "수정된 질문 0");

  const revision3 = buildManualConfirmationEvaluationsRevisionArtifact({
    run: revisionRun,
    review: revisionReview,
    parent: selected2,
    questionAuthorEmail: "question-author@example.invalid",
    createdAt: "2026-09-08T00:03:00.000Z",
    intent: "withdraw_all",
    withdrawnCriterionIndexes: [0, 1],
    items: [],
  });
  await saveManualConfirmationEvaluationsRevision(revision3, revisionRun);
  const selected3 = await readSelectedManualConfirmationEvaluations(
    revisionRun,
    manualConfirmationEvaluationSelectionForArtifact(revision3),
  );
  const withdrawnPlan = planGrantPromotion({
    run: revisionRun,
    review: revisionReview,
    origin: "human",
    sidecar: legacySidecar,
    manualEvaluationSidecar: selected3.artifact,
    manualConfirmationEvaluationSelection: selected3.selection,
    sourceRawSha256: "c".repeat(64),
  });
  assert.equal(withdrawnPlan.questions.length, 1);
  assert.equal(withdrawnPlan.questions[0]?.prompt, "기존 exclusion 질문");
  assert.equal(withdrawnPlan.manualConfirmationEvaluationSelection?.intent, "withdraw_all");
  // 후속 revision 출현은 과거 exact revision 1 선택과 원 bytes/plan을 바꾸지 않는다.
  assert.deepEqual(
    (await readSelectedManualConfirmationEvaluations(revisionRun, revision1Selection)).artifact,
    revision1,
  );

  const revision4a = buildManualConfirmationEvaluationsRevisionArtifact({
    run: revisionRun,
    review: revisionReview,
    parent: selected3,
    questionAuthorEmail: "question-author@example.invalid",
    createdAt: "2026-09-08T00:04:00.000Z",
    intent: "replace",
    withdrawnCriterionIndexes: [],
    items: [question(0, "다시 추가 A")],
  });
  const revision4b = buildManualConfirmationEvaluationsRevisionArtifact({
    run: revisionRun,
    review: revisionReview,
    parent: selected3,
    questionAuthorEmail: "question-author@example.invalid",
    createdAt: "2026-09-08T00:04:01.000Z",
    intent: "replace",
    withdrawnCriterionIndexes: [],
    items: [question(0, "다시 추가 B")],
  });
  const concurrent = await Promise.allSettled([
    saveManualConfirmationEvaluationsRevision(revision4a, revisionRun),
    saveManualConfirmationEvaluationsRevision(revision4b, revisionRun),
  ]);
  assert.equal(concurrent.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((entry) => entry.status === "rejected").length, 1);
  const winningRevision4 = concurrent[0]?.status === "fulfilled" ? revision4a : revision4b;
  assert.deepEqual(
    (await readSelectedManualConfirmationEvaluations(
      revisionRun,
      manualConfirmationEvaluationSelectionForArtifact(winningRevision4),
    )).artifact,
    winningRevision4,
  );
} finally {
  process.chdir(previousCwd);
  await rm(directory, { recursive: true, force: true });
}
assert.equal(classifyManualConfirmationCriterion({
  ...criterion,
  value: { note: "원문 모순", downgrade_reason: "sanction_cause_state_flattening" },
}), "admin_source_review");

console.log("manual-confirmation-evaluations: ok");
