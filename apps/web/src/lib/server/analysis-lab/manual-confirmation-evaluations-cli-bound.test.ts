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
import {
  manualConfirmationEvaluationsFilePath,
  manualConfirmationEvaluationsRevisionFilePath,
} from "./manual-confirmation-evaluations";
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

test("legacy run manual CLI는 명시한 current source revision으로 sidecar를 만든다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cunote-bound-legacy-manual-cli-"));
  const previousCwd = process.cwd();
  const sourceRevisionSha256 = "f".repeat(64);
  const { sourceRevisionSha256: _sourceRevisionSha256, ...runWithoutSourceRevision } = run;
  const legacyRun: LabRun = {
    ...runWithoutSourceRevision,
    runId: "run-2026-09-09T030000.000Z-acde12",
    grantId: "00000000-0000-4000-8000-0000000002d2",
    sourceId: "bound-cli-legacy-v1",
  } as LabRun;
  const legacyReview: LabReview = {
    ...review,
    runId: legacyRun.runId,
    grantId: legacyRun.grantId,
  };
  try {
    await writeFile(join(directory, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    process.chdir(directory);
    const runPath = await saveLabRun(legacyRun);
    await saveLabReview(legacyReview);
    const reviewPath = labReviewFilePath(legacyRun.source, legacyRun.sourceId, legacyRun.runId);
    const [runBytes, reviewBytes] = await Promise.all([readFile(runPath), readFile(reviewPath)]);
    const packet = buildConfirmationQuestionDraftPacket({
      run: { ...legacyRun, sourceRevisionSha256 },
      review: legacyReview,
      runArtifactSha256: createHash("sha256").update(runBytes).digest("hex"),
      reviewArtifactSha256: createHash("sha256").update(reviewBytes).digest("hex"),
    });
    const inputPath = join(directory, "bound-legacy-input.json");
    await writeFile(inputPath, JSON.stringify({
      schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
      draftPacket: packet,
      manualInput: {
        questionAuthorEmail: "author@example.invalid",
        items: [{
          criterionIndex: 0,
          resolutionScope: "per_notice",
          prompt: packet.items[0]!.prompt,
          options: packet.items[0]!.options,
        }],
      },
    }));

    await assert.rejects(runManualConfirmationEvaluationsCli([
      `--grantId=${legacyRun.grantId}`,
      `--runId=${legacyRun.runId}`,
      `--input=${inputPath}`,
    ]), /source-revision-sha256/);
    const result = await runManualConfirmationEvaluationsCli([
      `--grantId=${legacyRun.grantId}`,
      `--runId=${legacyRun.runId}`,
      `--input=${inputPath}`,
      `--source-revision-sha256=${sourceRevisionSha256}`,
    ]);
    const artifact = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(artifact.sourceRevisionSha256, sourceRevisionSha256);
    assert.equal(result.itemCount, 1);
  } finally {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
});

test("회사 사실은 bound packet의 검수 SHA와 구조화 scope/기준일이 있어야 CLI sidecar로 저장된다", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cunote-company-fact-cli-"));
  const previousCwd = process.cwd();
  const factRun: LabRun = {
    ...run,
    runId: "run-2026-09-09T040000.000Z-acde12",
    grantId: "00000000-0000-4000-8000-0000000002d3",
    sourceId: "bound-company-fact-v1",
    criteria: [{ ...criterion, value: { fact_scope: "registered_business", basis_date: "2026-09-22" } }],
  };
  const factReview: LabReview = { ...review, runId: factRun.runId, grantId: factRun.grantId };
  try {
    await writeFile(join(directory, "pnpm-workspace.yaml"), "packages: []\n", "utf8");
    process.chdir(directory);
    const runPath = await saveLabRun(factRun);
    await saveLabReview(factReview);
    const [runBytes, reviewBytes] = await Promise.all([
      readFile(runPath),
      readFile(labReviewFilePath(factRun.source, factRun.sourceId, factRun.runId)),
    ]);
    const packet = buildConfirmationQuestionDraftPacket({
      run: factRun,
      review: factReview,
      runArtifactSha256: createHash("sha256").update(runBytes).digest("hex"),
      reviewArtifactSha256: createHash("sha256").update(reviewBytes).digest("hex"),
    });
    const item = {
      criterionIndex: 0,
      resolutionScope: "company_fact",
      conditionKey: "registered_business_fact",
      companyFactReview: {
        meaning: "현재 등록 사업장 보유 여부",
        definitionKey: "registered_business_fact",
        definitionSource: "new_review",
        scopeField: "fact_scope",
        scopeValue: "registered_business",
        asOfField: "basis_date",
        asOfDate: "2026-09-22",
        reviewArtifactSha256: packet.source.reviewArtifactSha256,
      },
      prompt: "기준일에 등록 사업장을 보유하나요?",
      options: packet.items[0]!.options,
    };
    const inputPath = join(directory, "company-fact-bound.json");
    await writeFile(inputPath, JSON.stringify({
      schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
      draftPacket: packet,
      manualInput: { questionAuthorEmail: "author@example.invalid", items: [item] },
    }));
    const unboundPath = join(directory, "company-fact-unbound.json");
    await writeFile(unboundPath, JSON.stringify({ questionAuthorEmail: "author@example.invalid", items: [item] }));
    const argv = [`--grantId=${factRun.grantId}`, `--runId=${factRun.runId}`];
    await assert.rejects(runManualConfirmationEvaluationsCli([
      ...argv, `--input=${unboundPath}`,
    ]), /bound review artifact/);
    const result = await runManualConfirmationEvaluationsCli([
      ...argv, `--input=${inputPath}`,
    ]);
    const artifact = JSON.parse(await readFile(result.path, "utf8"));
    assert.equal(artifact.items[0].companyFactReview.reviewArtifactSha256, packet.source.reviewArtifactSha256);
    assert.equal(result.selector.artifactSha256.length, 64);

    const relatedRun: LabRun = {
      ...factRun,
      runId: "run-2026-09-09T050000.000Z-acde12",
      grantId: "00000000-0000-4000-8000-0000000002d4",
      sourceId: "bound-company-fact-existing-v1",
    };
    const relatedReview: LabReview = { ...factReview, runId: relatedRun.runId, grantId: relatedRun.grantId };
    const relatedRunPath = await saveLabRun(relatedRun);
    await saveLabReview(relatedReview);
    const [relatedRunBytes, relatedReviewBytes] = await Promise.all([
      readFile(relatedRunPath),
      readFile(labReviewFilePath(relatedRun.source, relatedRun.sourceId, relatedRun.runId)),
    ]);
    const relatedPacket = buildConfirmationQuestionDraftPacket({
      run: relatedRun,
      review: relatedReview,
      runArtifactSha256: createHash("sha256").update(relatedRunBytes).digest("hex"),
      reviewArtifactSha256: createHash("sha256").update(relatedReviewBytes).digest("hex"),
    });
    const relatedItem = {
      ...item,
      companyFactReview: {
        ...item.companyFactReview,
        definitionSource: "existing_reviewed",
        reviewArtifactSha256: relatedPacket.source.reviewArtifactSha256,
        existingDefinition: {
          grantId: factRun.grantId,
          runId: factRun.runId,
          revision: result.selector.revision,
          artifactSha256: result.selector.artifactSha256,
          criterionIndex: 0,
        },
      },
    };
    const relatedInputPath = join(directory, "company-fact-existing-bound.json");
    await writeFile(relatedInputPath, JSON.stringify({
      schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
      draftPacket: relatedPacket,
      manualInput: { questionAuthorEmail: "author@example.invalid", items: [relatedItem] },
    }));
    const relatedArgv = [`--grantId=${relatedRun.grantId}`, `--runId=${relatedRun.runId}`, `--input=${relatedInputPath}`];
    const relatedResult = await runManualConfirmationEvaluationsCli(relatedArgv);
    const relatedArtifact = JSON.parse(await readFile(relatedResult.path, "utf8"));
    assert.equal(relatedArtifact.items[0].conditionKey, artifact.items[0].conditionKey);
    const wrongSourcePath = join(directory, "company-fact-wrong-source.json");
    await writeFile(wrongSourcePath, JSON.stringify({
      schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
      draftPacket: relatedPacket,
      manualInput: { questionAuthorEmail: "author@example.invalid", items: [{
        ...relatedItem,
        companyFactReview: { ...relatedItem.companyFactReview, meaning: "등록 사업장 소유 여부" },
      }] },
    }));
    await assert.rejects(runManualConfirmationEvaluationsCli([
      ...relatedArgv.slice(0, 2), `--input=${wrongSourcePath}`,
    ]), /의미·검수 출처가 선택 artifact와 다릅니다/);

    const changedDateRun: LabRun = {
      ...relatedRun,
      runId: "run-2026-09-09T060000.000Z-acde12",
      grantId: "00000000-0000-4000-8000-0000000002d5",
      sourceId: "bound-company-fact-other-date-v1",
      criteria: [{ ...factRun.criteria[0]!, value: { fact_scope: "registered_business", basis_date: "2026-10-01" } }],
    };
    const changedDateReview: LabReview = { ...factReview, runId: changedDateRun.runId, grantId: changedDateRun.grantId };
    const changedDateRunPath = await saveLabRun(changedDateRun);
    await saveLabReview(changedDateReview);
    const [changedDateRunBytes, changedDateReviewBytes] = await Promise.all([
      readFile(changedDateRunPath),
      readFile(labReviewFilePath(changedDateRun.source, changedDateRun.sourceId, changedDateRun.runId)),
    ]);
    const changedDatePacket = buildConfirmationQuestionDraftPacket({
      run: changedDateRun,
      review: changedDateReview,
      runArtifactSha256: createHash("sha256").update(changedDateRunBytes).digest("hex"),
      reviewArtifactSha256: createHash("sha256").update(changedDateReviewBytes).digest("hex"),
    });
    const changedDatePath = join(directory, "company-fact-other-date.json");
    await writeFile(changedDatePath, JSON.stringify({
      schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
      draftPacket: changedDatePacket,
      manualInput: { questionAuthorEmail: "author@example.invalid", items: [{
        ...relatedItem,
        companyFactReview: {
          ...relatedItem.companyFactReview,
          asOfDate: "2026-10-01",
          reviewArtifactSha256: changedDatePacket.source.reviewArtifactSha256,
        },
      }] },
    }));
    await assert.rejects(runManualConfirmationEvaluationsCli([
      `--grantId=${changedDateRun.grantId}`,
      `--runId=${changedDateRun.runId}`,
      `--input=${changedDatePath}`,
    ]), /identity가 현재 criterion과 다릅니다/);

    const revisionInputPath = join(directory, "company-fact-revision.json");
    await writeFile(revisionInputPath, JSON.stringify({
      schema: CONFIRMATION_QUESTION_MANUAL_INPUT_SCHEMA,
      draftPacket: packet,
      manualInput: {
        questionAuthorEmail: "author@example.invalid",
        intent: "replace",
        withdrawnCriterionIndexes: [],
        items: [{ ...item, prompt: "기준일 현재 등록 사업장을 보유하나요?" }],
      },
    }));
    const revisionResult = await runManualConfirmationEvaluationsCli([
      ...argv.slice(0, 2),
      `--input=${revisionInputPath}`,
      `--parent-revision=${result.selector.revision}`,
      `--parent-sha256=${result.selector.artifactSha256}`,
    ]);
    assert.equal(revisionResult.path, manualConfirmationEvaluationsRevisionFilePath(
      factRun.source, factRun.sourceId, factRun.runId, 2,
    ));
    await assert.rejects(runManualConfirmationEvaluationsCli([
      ...relatedArgv.slice(0, 2), `--input=${wrongSourcePath}`,
    ]), /선택 revision 이후 수동 수정·철회/);
  } finally {
    process.chdir(previousCwd);
    await rm(directory, { recursive: true, force: true });
  }
});
