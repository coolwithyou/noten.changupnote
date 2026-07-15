import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import {
  GRANT_ANALYSIS_EVALUATION_AXES,
  type GrantAnalysisEvaluationAxisJudgment,
  type GrantAnalysisEvaluationInputBlock,
} from "@cunote/core";
import { buildGrantAnalysisEvaluationJudgePacket } from "../ingestion/grantAnalysisEvaluationJudge";
import type { GrantAnalysisEvaluationAnthropicRequest } from "../ingestion/grantAnalysisEvaluationAnthropic";
import {
  buildGrantAnalysisEvaluationGate2Receipt,
  type GrantAnalysisEvaluationExtractorPacket,
  type GrantAnalysisEvaluationGate2FrozenInput,
} from "../ingestion/grantAnalysisEvaluationGate2";
import {
  Gate2ExecutionError,
  executeGrantAnalysisEvaluationGate2,
  type Gate2ProviderFactoryContext,
} from "./execute-grant-analysis-evaluation-gate2";

const confirmation = "RUN_GRANT_ANALYSIS_EVALUATION_PAID";

const happy = await fixtureDirectory("happy");
let constructed = 0;
const calls: Array<{ grantKey: string; stage: string; attempt: number }> = [];
const dynamicJudge3Axes: string[][] = [];
const happyStatus = await executeGrantAnalysisEvaluationGate2({
  receiptPath: happy.receiptPath,
  checkpointPath: happy.checkpointPath,
  execute: true,
  confirmation,
  apiKey: "synthetic-key-never-sent",
  providerFactory(context) {
    constructed += 1;
    return fakeProvider(context, calls, { dynamicJudge3Axes });
  },
});
assert.equal(constructed, 1);
assert.equal(happyStatus.status, "complete");
assert.equal(happyStatus.externalCallsMade, 11);
assert.deepEqual(stageCounts(calls), {
  extract_b: 3,
  extract_c: 1,
  judge_1: 3,
  judge_2: 3,
  judge_3: 1,
});
assert.deepEqual(dynamicJudge3Axes, [["industry"]], "Judge 3 receives only the exact disagreement subset");
assert.equal((await stat(happy.checkpointPath)).mode & 0o777, 0o600);
const happyCheckpoint = JSON.parse(await readFile(happy.checkpointPath, "utf8"));
assert.equal((await readFile(happy.checkpointPath, "utf8")).includes("do-not-persist"), false);
assert.equal(Object.keys(happyCheckpoint.grants).length, 3);
for (const grant of Object.values(happyCheckpoint.grants) as Array<{ stages: Record<string, { status: string; result?: unknown }> }>) {
  assert.ok(Object.values(grant.stages).every((stage) => stage.status === "success" || stage.status === "skipped"));
  assert.ok(Object.values(grant.stages).filter((stage) => stage.status === "success")
    .every((stage) => (stage.result as { recordType?: string }).recordType === "grant_analysis_evaluation_gate2_stage_result"));
}
const callsBeforeReplay = calls.length;
const replay = await executeGrantAnalysisEvaluationGate2({
  receiptPath: happy.receiptPath,
  checkpointPath: happy.checkpointPath,
  execute: true,
  confirmation,
  apiKey: "synthetic-key-never-sent",
  providerFactory(context) {
    return fakeProvider(context, calls);
  },
});
assert.equal(replay.status, "complete");
assert.equal(calls.length, callsBeforeReplay, "resume never repeats successful stages");
assert.equal(replay.attempts, happyStatus.attempts, "attempts remain the cumulative persisted reservation count");
assert.equal(replay.externalCallsMade, 0, "completed replay makes no fetches in this invocation");

const interrupted = await fixtureDirectory("interrupted");
const interruptedCalls: Array<{ grantKey: string; stage: string; attempt: number }> = [];
let failAttachmentC = true;
const firstInterrupted = await executeGrantAnalysisEvaluationGate2({
  receiptPath: interrupted.receiptPath,
  checkpointPath: interrupted.checkpointPath,
  execute: true,
  confirmation,
  apiKey: "synthetic-key-never-sent",
  providerFactory(context) {
    return fakeProvider(context, interruptedCalls, {
      fail(request) {
        if (request.stage === "extract_c" && failAttachmentC) {
          failAttachmentC = false;
          return true;
        }
        return false;
      },
    });
  },
});
assert.equal(firstInterrupted.status, "incomplete");
assert.equal(firstInterrupted.externalCallsMade, 11, "post-fetch failure remains counted in its invocation");
const beforeResume = interruptedCalls.length;
const successfulBeforeResume = new Set(interruptedCalls
  .filter((call) => !(call.stage === "extract_c" && call.attempt === 1))
  .map(callKey));
const resumed = await executeGrantAnalysisEvaluationGate2({
  receiptPath: interrupted.receiptPath,
  checkpointPath: interrupted.checkpointPath,
  execute: true,
  confirmation,
  apiKey: "synthetic-key-never-sent",
  providerFactory(context) {
    return fakeProvider(context, interruptedCalls);
  },
});
assert.equal(resumed.status, "complete");
assert.equal(resumed.externalCallsMade, 1, "resume reports only its one new fetch");
assert.equal(interruptedCalls.length, beforeResume + 1, "resume retries only the interrupted stage");
assert.equal(interruptedCalls.at(-1)?.stage, "extract_c");
assert.equal(interruptedCalls.at(-1)?.attempt, 2);
assert.ok(interruptedCalls.slice(beforeResume).every((call) => !successfulBeforeResume.has(callKey(call))));

const guarded = await fixtureDirectory("guarded");
let guardedConstructed = 0;
const verifiedOnly = await executeGrantAnalysisEvaluationGate2({
  receiptPath: guarded.receiptPath,
  checkpointPath: guarded.checkpointPath,
  execute: false,
  providerFactory() {
    guardedConstructed += 1;
    throw new Error("must not construct");
  },
});
assert.equal(verifiedOnly.status, "verified");
assert.equal(verifiedOnly.externalCallsMade, 0);
assert.equal(guardedConstructed, 0);
const confirmationError = await rejectedError(executeGrantAnalysisEvaluationGate2({
  receiptPath: guarded.receiptPath,
  checkpointPath: guarded.checkpointPath,
  execute: true,
  confirmation: "wrong",
  providerFactory() {
    guardedConstructed += 1;
    throw new Error("must not construct");
  },
}));
assert.match((confirmationError as Error).message, /exact confirmation/);
assert.ok(confirmationError instanceof Gate2ExecutionError);
assert.equal((confirmationError as Gate2ExecutionError).externalCallsMade, 0);
assert.equal(guardedConstructed, 0);

const tampered = await fixtureDirectory("tampered");
const tamperedInputPath = join(tampered.directory, "inputs", "kstartup_sparse.json");
const tamperedInput = JSON.parse(await readFile(tamperedInputPath, "utf8"));
tamperedInput.rawB.blocks[0].text = "synthetic tamper";
await writeSecureJson(tamperedInputPath, tamperedInput);
let tamperConstructed = 0;
const tamperError = await rejectedError(executeGrantAnalysisEvaluationGate2({
  receiptPath: tampered.receiptPath,
  checkpointPath: tampered.checkpointPath,
  execute: true,
  confirmation,
  providerFactory() {
    tamperConstructed += 1;
    throw new Error("must not construct");
  },
}));
assert.match((tamperError as Error).message, /hash verification|packet\/hash mismatch/);
assert.equal((tamperError as Gate2ExecutionError).externalCallsMade, 0);
assert.equal(tamperConstructed, 0);

const reservationMismatch = await fixtureDirectory("reservation-mismatch");
let simulatedFetches = 0;
const mismatchStatus = await executeGrantAnalysisEvaluationGate2({
  receiptPath: reservationMismatch.receiptPath,
  checkpointPath: reservationMismatch.checkpointPath,
  execute: true,
  confirmation,
  apiKey: "synthetic-key-never-sent",
  providerFactory(context) {
    return {
      async call(request) {
        const checkpoint = JSON.parse(await readFile(reservationMismatch.checkpointPath, "utf8"));
        checkpoint.grants[request.reservation.grantKey].stages[request.stage].reservationId = "0".repeat(64);
        await writeSecureJson(reservationMismatch.checkpointPath, checkpoint);
        if (!await context.verifyPersistedReservation(request.reservation)) {
          throw new Error("reservation rejected before fetch");
        }
        simulatedFetches += 1;
        throw new Error("unreachable");
      },
    };
  },
});
assert.equal(mismatchStatus.status, "incomplete");
assert.ok(mismatchStatus.attempts > 0, "pre-fetch rejection still consumes persisted reservations");
assert.equal(mismatchStatus.externalCallsMade, 0);
assert.equal(simulatedFetches, 0, "reservation drift always rejects before simulated fetch");

const postFetchFailure = await fixtureDirectory("post-fetch-failure");
const postFetchError = await rejectedError(executeGrantAnalysisEvaluationGate2({
  receiptPath: postFetchFailure.receiptPath,
  checkpointPath: postFetchFailure.checkpointPath,
  execute: true,
  confirmation,
  apiKey: "synthetic-key-never-sent",
  providerFactory(context) {
    return {
      async call(request) {
        assert.equal(await context.verifyPersistedReservation(request.reservation), true);
        context.markFetchStarted();
        await chmod(postFetchFailure.checkpointPath, 0o644);
        const output = syntheticOutput(request.stage, request.reservation.grantKey, request.reservation.sourceRevision);
        return {
          stage: request.stage,
          model: request.model,
          stopReason: "end_turn",
          usage: { input_tokens: 10, output_tokens: 5 },
          output,
          receipt: {
            requestId: "req_synthetic",
            messageId: "msg_synthetic",
            usage: { input_tokens: 10, output_tokens: 5 },
            outputSha256: sha256(stableStringify(output)),
          },
        };
      },
    };
  },
}));
assert.match((postFetchError as Error).message, /checkpoint target/);
assert.ok(postFetchError instanceof Gate2ExecutionError);
assert.equal((postFetchError as Gate2ExecutionError).externalCallsMade, 1,
  "an uncaught post-fetch failure carries the nonzero invocation count to the CLI boundary");

console.log("execute-grant-analysis-evaluation-gate2.test.ts: all assertions passed");

function fakeProvider(
  context: Gate2ProviderFactoryContext,
  seen: Array<{ grantKey: string; stage: string; attempt: number }>,
  options: {
    fail?: (request: GrantAnalysisEvaluationAnthropicRequest) => boolean;
    dynamicJudge3Axes?: string[][];
  } = {},
) {
  return {
    async call(request: GrantAnalysisEvaluationAnthropicRequest) {
      seen.push({
        grantKey: request.reservation.grantKey,
        stage: request.stage,
        attempt: request.reservation.attempt,
      });
      assert.equal(await context.verifyPersistedReservation(request.reservation), true);
      context.markFetchStarted();
      if (options.fail?.(request)) throw new Error("synthetic interruption");
      if (request.stage === "judge_3") {
        const axes = (((request.outputSchema.properties as Record<string, unknown>).axes as Record<string, unknown>)
          .items as Record<string, unknown>).properties as Record<string, unknown>;
        options.dynamicJudge3Axes?.push([...(axes.dimension as { enum: string[] }).enum]);
      }
      const output = syntheticOutput(request.stage, request.reservation.grantKey, request.reservation.sourceRevision);
      assert.equal(request.validateOutput(output), true);
      const outputSha256 = sha256(stableStringify(output));
      return {
        stage: request.stage,
        model: request.model,
        stopReason: "end_turn",
        usage: { input_tokens: 10, output_tokens: 5, ignored_secret: "do-not-persist" },
        output,
        receipt: {
          requestId: "req_synthetic",
          messageId: "msg_synthetic",
          usage: { input_tokens: 10, output_tokens: 5 },
          outputSha256,
        },
      };
    },
  };
}

async function rejectedError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected promise to reject");
}

function syntheticOutput(stage: string, grantKey: string, sourceRevision: string) {
  if (stage === "extract_b" || stage === "extract_c") {
    return {
      recordType: "grant_analysis_evaluation_extractor_output",
      schemaVersion: 1,
      grantKey,
      sourceRevision,
      truncated: false,
      schemaRecovered: false,
      requiredDocuments: [],
      axisAssessments: allUnknownAxes(),
    };
  }
  if (stage === "judge_3") {
    return {
      recordType: "grant_analysis_evaluation_judge_ledger",
      schemaVersion: 1,
      judgeId: "judge_3",
      grantKey,
      sourceRevision,
      truncated: false,
      schemaRecovered: false,
      axes: [unknownAxis("industry")],
    };
  }
  const axes = allUnknownAxes();
  if (stage === "judge_2" && grantKey === "kstartup:control") {
    const industry = axes.find((axis) => axis.dimension === "industry")!;
    Object.assign(industry, {
      state: "condition_present",
      normalizedCondition: {
        json: JSON.stringify({
          criteria: [{ operator: "in", kind: "required", value: { tags: ["synthetic"] } }],
        }),
      },
      evidence: [{
        artifactId: `raw-api:${grantKey}:content`,
        locatorKind: "paragraph",
        locator: "block-1",
        quote: "synthetic evidence",
      }],
      confidence: 0.9,
    });
  }
  return {
    recordType: "grant_analysis_evaluation_judge_ledger",
    schemaVersion: 1,
    judgeId: stage,
    grantKey,
    sourceRevision,
    truncated: false,
    schemaRecovered: false,
    axes,
  };
}

function allUnknownAxes(): GrantAnalysisEvaluationAxisJudgment[] {
  return GRANT_ANALYSIS_EVALUATION_AXES.map((axis) => unknownAxis(axis));
}

function unknownAxis(dimension: (typeof GRANT_ANALYSIS_EVALUATION_AXES)[number]): GrantAnalysisEvaluationAxisJudgment {
  return {
    dimension,
    state: "unknown",
    normalizedCondition: null,
    evidence: [],
    confidence: 0.5,
    exceptions: [],
    logicalRelation: "unknown",
    applicablePeriod: null,
    note: "synthetic",
  };
}

async function fixtureDirectory(label: string) {
  const directory = await mkdtemp(join(tmpdir(), `cunote-gate2-${label}-`));
  const inputsDirectory = join(directory, "inputs");
  const inputs = [
    frozenInput("kstartup:sparse", "sparse", false),
    frozenInput("bizinfo:attachment", "attachment_loadable", true),
    frozenInput("kstartup:control", "structured_control", false),
  ];
  const receipt = buildGrantAnalysisEvaluationGate2Receipt({
    manifest: { manifestSha256: sha256("synthetic-manifest") } as never,
    frozen: inputs,
    modelAccess: {
      requestedModelIds: ["claude-fable-5", "claude-opus-4-8"],
      available: { "claude-fable-5": true, "claude-opus-4-8": true },
      matchedModelIds: ["claude-fable-5", "claude-opus-4-8"],
      authenticatedModelsGetCalls: 1,
    },
  });
  const receiptPath = join(directory, "plan-receipt.json");
  await writeSecureJson(receiptPath, receipt);
  for (const input of inputs) {
    await writeSecureJson(join(inputsDirectory, `${input.grantKey.replace(/[^a-zA-Z0-9._-]+/g, "_")}.json`), input);
  }
  return { directory, receiptPath, checkpointPath: join(directory, "execution-checkpoint.json") };
}

function frozenInput(
  grantKey: string,
  role: GrantAnalysisEvaluationGate2FrozenInput["selectionRole"],
  distinctC: boolean,
): GrantAnalysisEvaluationGate2FrozenInput {
  const sourceRevision = sha256(`${grantKey}:revision`);
  const apiBlock: GrantAnalysisEvaluationInputBlock = {
    artifactId: `raw-api:${grantKey}:content`,
    kind: "raw_api",
    locatorKind: "paragraph",
    locator: "block-1",
    text: "synthetic evidence only",
    expected: true,
    included: true,
  };
  const attachmentBlock: GrantAnalysisEvaluationInputBlock = {
    artifactId: `attachment:${sha256(grantKey)}`,
    kind: "attachment_markdown",
    locatorKind: "paragraph",
    locator: "document",
    text: "synthetic attachment evidence",
    expected: distinctC,
    included: distinctC,
  };
  const rawB = extractorPacket(grantKey, sourceRevision, [apiBlock]);
  const rawC = extractorPacket(grantKey, sourceRevision, distinctC ? [apiBlock, attachmentBlock] : [apiBlock]);
  const limits = {
    maxAttachments: 3,
    maxCharsPerAttachment: 64_000,
    maxTotalChars: 96_000,
    maxDeclaredBytes: 2_000_000,
  };
  const rawOnlyJudge = buildGrantAnalysisEvaluationJudgePacket({
    grantKey,
    sourceRevision,
    blocks: rawC.blocks,
    inputLimits: limits,
  });
  const count = distinctC ? 1 : 0;
  return {
    recordType: "grant_analysis_evaluation_gate2_frozen_input",
    schemaVersion: 1,
    selectionRole: role,
    selectionRationale: `synthetic ${role}`,
    grantKey,
    canonicalId: sha256(`${grantKey}:canonical`).slice(0, 32),
    title: `synthetic ${role}`,
    sourceRevision,
    pilotSourceRevision: sha256(`${grantKey}:pilot`),
    baselineCriteriaCount: role === "structured_control" ? 10 : 0,
    rawB,
    rawC,
    rawOnlyJudge,
    judgeInputSha256: sha256(stableStringify(rawOnlyJudge)),
    cReusesB: !distinctC,
    attachments: {
      transformVersion: "grant-analysis-pilot-input-transform-v2-byte-source-sanitize-core-clean",
      limits,
      counts: {
        sourceDeclaredExpected: count,
        manifestExpected: count,
        expected: count,
        present: count,
        fetched: count,
        converted: count,
        loadableConverted: count,
        selectedForLoad: count,
        loaded: count,
        included: count,
        skippedConversion: 0,
        failedConversion: 0,
      },
      characters: {
        apiOnlyInput: apiBlock.text.length,
        loadedAttachmentMarkdown: distinctC ? attachmentBlock.text.length : 0,
        includedAttachmentMarkdown: distinctC ? attachmentBlock.text.length : 0,
        apiPlusAttachmentsInput: apiBlock.text.length + (distinctC ? attachmentBlock.text.length : 0),
        attachmentInputEnvelope: 0,
      },
      truncation: {
        truncatedAttachmentCount: 0,
        skippedOversizeCount: 0,
        excludedByAttachmentLimitCount: 0,
        selectedButNotLoadedCount: 0,
      },
      includedAttachments: [],
      failures: [],
    },
    warnings: [],
    readOnly: true,
    externalLlmCalls: 0,
  };
}

function extractorPacket(
  grantKey: string,
  sourceRevision: string,
  blocks: GrantAnalysisEvaluationInputBlock[],
): GrantAnalysisEvaluationExtractorPacket {
  const packetWithoutHash = {
    recordType: "grant_analysis_evaluation_extractor_packet" as const,
    schemaVersion: 1 as const,
    grantKey,
    sourceRevision,
    blocks,
    inputOrder: blocks.map((block) => `${block.artifactId}#${block.locatorKind}:${block.locator}`),
  };
  return { ...packetWithoutHash, packetSha256: sha256(stableStringify(packetWithoutHash)) };
}

async function writeSecureJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}

function stageCounts(calls: Array<{ stage: string }>): Record<string, number> {
  return Object.fromEntries(["extract_b", "extract_c", "judge_1", "judge_2", "judge_3"]
    .map((stage) => [stage, calls.filter((call) => call.stage === stage).length]));
}

function callKey(call: { grantKey: string; stage: string }): string {
  return `${call.grantKey}:${call.stage}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
