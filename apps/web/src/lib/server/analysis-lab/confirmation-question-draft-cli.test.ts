import assert from "node:assert/strict";
import test from "node:test";
import { parseConfirmationQuestionDraftCliArgs } from "./confirmation-question-draft-cli";

test("CLI는 exact 옵션만 파싱한다", () => {
  assert.deepEqual(parseConfirmationQuestionDraftCliArgs([
    "--grantId=grant-1",
    "--runId=run-2026-09-09T000000.000Z-acde12",
    "--output-dir=/tmp/drafts",
  ]), {
    grantId: "grant-1",
    runId: "run-2026-09-09T000000.000Z-acde12",
    outputDirectory: "/tmp/drafts",
  });
});

test("CLI는 unknown/중복/부분 형식을 거부한다", () => {
  assert.throws(() => parseConfirmationQuestionDraftCliArgs([
    "--grantId=grant-1",
    "--runId=run-1",
    "--write=true",
  ]), /알 수 없는 옵션/);
  assert.throws(() => parseConfirmationQuestionDraftCliArgs([
    "--grantId=grant-1",
    "--grantId=grant-2",
    "--runId=run-1",
  ]), /중복 옵션/);
  assert.throws(() => parseConfirmationQuestionDraftCliArgs([
    "--grantId=grant-1",
    "--runId",
  ]), /--name=value/);
});
