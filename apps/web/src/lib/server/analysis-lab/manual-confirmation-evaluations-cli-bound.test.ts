import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA } from "@cunote/contracts/confirmation-question-draft";
import type { LabCriterion, LabReview, LabRun } from "./lab-contract";
import { buildConfirmationQuestionDraftPacket } from "./confirmation-question-draft";
import {
  loadManualConfirmationCliInput,
  runManualConfirmationEvaluationsCli,
} from "./manual-confirmation-evaluations-cli";
import { manualConfirmationEvaluationsFilePath } from "./manual-confirmation-evaluations";
import { labReviewFilePath, saveLabReview } from "./review-store";
import { saveLabRun } from "./run-store";

const criterion: LabCriterion = {
  dimension: "other",
  kind: "required",
  operator: "text_only",
  value: { note: "대표자 직접 확인" },
  confidence: 0.9,
  sourceSpan: "대표자는 이 공고별 조건을 충족해야 한다.",
  spanVerified: true,
  note: null,
};

const run: LabRun = {
  runId: "run-2026-09-09T020000.000Z-acde12",
  grantId: "00000000-0000-4000-8000-0000000002d1",
  source: "bizinfo",
  sourceId: "bound-cli-v1",
  title: "Bound CLI",
  model: "fixture",
  promptVersion: "fixture-v1",
  startedAt: "2026-09-09T02:00:00.000Z",
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

const review: LabReview = {
  grantId: run.grantId,
  runId: run.runId,
  reviewerEmail: "reviewer@example.invalid",
  createdAt: "2026-09-09T02:01:00.000Z",
  updatedAt: "2026-09-09T02:01:00.000Z",
  criterionReviews: [{ criterionIndex: 0, verdict: "correct", note: null }],
  axisReviews: [],
  overallNote: null,
};

test("기존 manual CLI loader가 bound export를 raw artifact에 재결속하고 review drift를 거부한다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cunote-bound-manual-cli-"));
  const previousCwd = process.cwd();
  try {
    await writeFile(join(directory, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    process.chdir(directory);
    const runPath = await saveLabRun(run);
    await saveLabReview(review);
    const reviewPath = labReviewFilePath(run.source, run.sourceId, run.runId);
    const [runBytes, reviewBytes] = await Promise.all([readFile(runPath), readFile(reviewPath)]);
    const packet = buildConfirmationQuestionDraftPacket({
      run,
      review,
      runArtifactSha256: createHash("sha256").update(runBytes).digest("hex"),
      reviewArtifactSha256: createHash("sha256").update(reviewBytes).digest("hex"),
    });
    const inputPath = join(directory, "bound-input.json");
    const outputPath = manualConfirmationEvaluationsFilePath(
      run.source,
      run.sourceId,
      run.runId,
    );
    const envelope = {
      schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
      draftPacket: packet,
      manualInput: {
        questionAuthorEmail: "author@example.invalid",
        items: [{
          criterionIndex: 0,
          resolutionScope: "per_notice",
          prompt: "관리자가 확정한 질문",
          options: packet.items[0]!.options,
        }],
      },
    };
    await writeFile(inputPath, JSON.stringify(envelope));
    const loaded = await loadManualConfirmationCliInput({
      grantId: run.grantId,
      runId: run.runId,
      inputPath,
    });
    assert.equal(loaded.manualInput.questionAuthorEmail, "author@example.invalid");

    const unknownSchemaPath = join(directory, "unknown-schema.json");
    await writeFile(unknownSchemaPath, JSON.stringify({ ...envelope, schema: "unknown-v2" }));
    await assert.rejects(loadManualConfirmationCliInput({
      grantId: run.grantId,
      runId: run.runId,
      inputPath: unknownSchemaPath,
    }), /정확한 envelope schema/);
    await assert.rejects(runManualConfirmationEvaluationsCli([
      `--grantId=${run.grantId}`,
      `--runId=${run.runId}`,
      `--input=${unknownSchemaPath}`,
    ]), /정확한 envelope schema/);
    await assert.rejects(access(outputPath), { code: "ENOENT" });

    const { schema: _schema, ...missingSchemaEnvelope } = envelope;
    const missingSchemaPath = join(directory, "missing-schema.json");
    await writeFile(missingSchemaPath, JSON.stringify(missingSchemaEnvelope));
    await assert.rejects(loadManualConfirmationCliInput({
      grantId: run.grantId,
      runId: run.runId,
      inputPath: missingSchemaPath,
    }), /정확한 envelope schema/);
    await assert.rejects(runManualConfirmationEvaluationsCli([
      `--grantId=${run.grantId}`,
      `--runId=${run.runId}`,
      `--input=${missingSchemaPath}`,
    ]), /정확한 envelope schema/);
    await assert.rejects(access(outputPath), { code: "ENOENT" });

    await writeFile(reviewPath, JSON.stringify({
      ...review,
      updatedAt: "2026-09-09T02:02:00.000Z",
    }));
    await assert.rejects(loadManualConfirmationCliInput({
      grantId: run.grantId,
      runId: run.runId,
      inputPath,
    }), /raw run\/review와 일치하지/);

    await writeFile(reviewPath, reviewBytes);
    const result = await runManualConfirmationEvaluationsCli([
      `--grantId=${run.grantId}`,
      `--runId=${run.runId}`,
      `--input=${inputPath}`,
    ]);
    assert.equal(result.path, outputPath);
    assert.equal(result.itemCount, 1);
    assert.equal(JSON.parse(await readFile(outputPath, "utf8")).questionAuthorEmail, "author@example.invalid");
  } finally {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
});
