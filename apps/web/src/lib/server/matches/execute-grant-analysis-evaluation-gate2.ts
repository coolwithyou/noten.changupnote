import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GRANT_ANALYSIS_EVALUATION_AXES,
  buildGrantAnalysisEvaluationConsensus,
  type GrantAnalysisEvaluationJudgeLedger,
  type GrantAnalysisEvaluationJudgePacket,
} from "@cunote/core";
import { buildGrantAnalysisEvaluationJudgePacket } from "../ingestion/grantAnalysisEvaluationJudge";
import {
  GRANT_ANALYSIS_EVALUATION_ANTHROPIC_BOUNDARY_VERSION,
  GRANT_ANALYSIS_EVALUATION_ANTHROPIC_ENDPOINT,
  GRANT_ANALYSIS_EVALUATION_ANTHROPIC_VERSION,
  GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL,
  GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL,
  createGrantAnalysisEvaluationAnthropicProvider,
  type GrantAnalysisEvaluationAnthropicRequest,
  type GrantAnalysisEvaluationAnthropicResult,
} from "../ingestion/grantAnalysisEvaluationAnthropic";
import {
  GRANT_ANALYSIS_EVALUATION_GATE2_VERSION,
  GRANT_ANALYSIS_EVALUATION_GROUNDING_VERSION,
  GRANT_ANALYSIS_EVALUATION_JUDGE3_SCHEMA_FACTORY_VERSION,
  GRANT_ANALYSIS_EVALUATION_RESPONSE_NORMALIZER_VERSION,
  GRANT_ANALYSIS_EVALUATION_ROLE_PROMPTS,
  GRANT_ANALYSIS_EVALUATION_STAGE_MAX_OUTPUT_TOKENS,
  buildGrantAnalysisEvaluationJudge3OutputSchema,
  evaluationSchemas,
  normalizeGrantAnalysisEvaluationGate2StageOutput,
  serializeGrantAnalysisEvaluationExtractorPacketForProvider,
  serializeGrantAnalysisEvaluationJudgePacketForProvider,
  type GrantAnalysisEvaluationExtractorPacket,
  type GrantAnalysisEvaluationGate2FrozenInput,
} from "../ingestion/grantAnalysisEvaluationGate2";
import { GRANT_ANALYSIS_PILOT_INPUT_TRANSFORM_VERSION } from "../ingestion/grantAnalysisPilotInputs";
import {
  GRANT_ANALYSIS_EVALUATION_ABSOLUTE_MAX_CALLS,
  GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  grantAnalysisEvaluationRunFingerprint,
  runGrantAnalysisEvaluation,
  type GrantAnalysisEvaluationAttemptReservation,
  type GrantAnalysisEvaluationCheckpointStore,
  type GrantAnalysisEvaluationRunCheckpoint,
  type GrantAnalysisEvaluationRunFingerprintInput,
  type GrantAnalysisEvaluationRunGrant,
  type GrantAnalysisEvaluationStage,
  type GrantAnalysisEvaluationStageCheckpoint,
} from "./run-grant-analysis-evaluation";

export const DEFAULT_GRANT_ANALYSIS_EVALUATION_GATE2_RECEIPT =
  "tmp/grant-analysis-evaluation/2026-07-15/gate2-byte-verified/plan-receipt.json";

interface Gate2PlanReceipt {
  recordType: "grant_analysis_evaluation_gate2_plan_receipt";
  schemaVersion: 1;
  preparationVersion: string;
  mode: "plan";
  manifestSha256: string;
  selected: Array<Record<string, unknown> & { role: string; grantKey: string; sourceRevision: string }>;
  models: {
    primary: string;
    explicitAccessFallback: string;
    roleAssignments: Record<string, string>;
    access: {
      requestedModelIds: readonly string[];
      available: Record<string, boolean>;
      matchedModelIds: readonly string[];
      authenticatedModelsGetCalls: number;
    };
  };
  hashes: {
    promptSha256: Record<string, string>;
    schemaSha256: Record<string, string>;
    configSha256: string;
    inputLimitsSha256: string;
    modelAccessReceiptSha256: string;
    judge3SchemaFactorySha256: string;
  };
  fingerprintInput: GrantAnalysisEvaluationRunFingerprintInput;
  runGrants: GrantAnalysisEvaluationRunGrant[];
  calls: {
    base: { computedUpper: number; byStageUpper: Record<GrantAnalysisEvaluationStage, number> };
    maxAttemptsPerStage: number;
    maxCalls: number;
    globalAbsoluteCap: number;
  };
  paidConfirmation: string;
  persistenceRequiredBeforePaidCall: boolean;
  databaseWriteMode: boolean;
  externalMessagesCalls: number;
}

export interface LoadedGate2ExecutionPlan {
  receiptPath: string;
  receiptSha256: string;
  receipt: Gate2PlanReceipt;
  inputs: ReadonlyMap<string, GrantAnalysisEvaluationGate2FrozenInput>;
  inputArtifactSha256: Readonly<Record<string, string>>;
  checkpointPath: string;
}

type Gate2Provider = {
  call(request: GrantAnalysisEvaluationAnthropicRequest): Promise<GrantAnalysisEvaluationAnthropicResult>;
};

export interface Gate2ProviderFactoryContext {
  configSha256: string;
  fingerprintInput: GrantAnalysisEvaluationRunFingerprintInput;
  confirmation: string;
  apiKey?: string;
  verifyPersistedReservation(reservation: GrantAnalysisEvaluationAttemptReservation): Promise<boolean>;
  markFetchStarted(): void;
}

export interface ExecuteGate2Options {
  receiptPath?: string;
  checkpointPath?: string;
  execute: boolean;
  confirmation?: string;
  apiKey?: string;
  providerFactory?: (context: Gate2ProviderFactoryContext) => Gate2Provider;
}

export interface ExecuteGate2Status {
  status: "verified" | "complete" | "incomplete";
  receiptPath: string;
  receiptSha256: string;
  checkpointPath: string;
  attempts: number;
  successes: number;
  failures: number;
  skipped: number;
  externalCallsMade: number;
  databaseWriteMode: false;
}

export class Gate2ExecutionError extends Error {
  readonly externalCallsMade: number;

  constructor(error: unknown, externalCallsMade: number) {
    super(error instanceof Error ? error.message : "Gate 2 execution failed.");
    this.name = "Gate2ExecutionError";
    this.externalCallsMade = externalCallsMade;
  }
}

interface PersistedStageResult {
  recordType: "grant_analysis_evaluation_gate2_stage_result";
  schemaVersion: 1;
  stage: GrantAnalysisEvaluationStage;
  model: string;
  stopReason: string | null;
  usage: Record<string, number> | null;
  providerReceipt: {
    requestId: string | null;
    messageId: string | null;
    outputSha256: string;
  };
  normalizedOutput: unknown;
  normalizedOutputSha256: string;
}

export async function loadGrantAnalysisEvaluationGate2Plan(options: {
  receiptPath?: string;
  checkpointPath?: string;
} = {}): Promise<LoadedGate2ExecutionPlan> {
  const receiptPath = resolve(options.receiptPath ?? DEFAULT_GRANT_ANALYSIS_EVALUATION_GATE2_RECEIPT);
  const receiptBytes = await readSecureJsonBytes(receiptPath, "Gate 2 receipt");
  const receipt = parseRecord(receiptBytes, "Gate 2 receipt") as unknown as Gate2PlanReceipt;
  assertReceiptEnvelope(receipt);

  const inputsDirectory = join(dirname(receiptPath), "inputs");
  const expectedNames = receipt.runGrants.map((grant) => `${safeArtifactName(grant.grantKey)}.json`).sort();
  const directoryEntries = await readdir(inputsDirectory, { withFileTypes: true });
  const actualNames = directoryEntries.map((entry) => entry.name).sort();
  if (stableStringify(actualNames) !== stableStringify(expectedNames) ||
      directoryEntries.some((entry) => !entry.isFile() || entry.isSymbolicLink())) {
    throw new Error("Gate 2 inputs directory must contain exactly the three frozen regular input artifacts.");
  }

  const inputs = new Map<string, GrantAnalysisEvaluationGate2FrozenInput>();
  const inputArtifactSha256: Record<string, string> = {};
  for (const name of expectedNames) {
    const path = join(inputsDirectory, name);
    const bytes = await readSecureJsonBytes(path, `Gate 2 input ${name}`);
    const input = parseRecord(bytes, `Gate 2 input ${name}`) as unknown as GrantAnalysisEvaluationGate2FrozenInput;
    if (inputs.has(input.grantKey)) throw new Error("Gate 2 input grant identities must be unique.");
    inputs.set(input.grantKey, input);
    inputArtifactSha256[input.grantKey] = sha256(bytes);
  }
  verifyPlanBindings(receipt, inputs);

  return {
    receiptPath,
    receiptSha256: sha256(receiptBytes),
    receipt,
    inputs,
    inputArtifactSha256,
    checkpointPath: resolve(options.checkpointPath ?? join(dirname(receiptPath), "execution-checkpoint.json")),
  };
}

export async function executeGrantAnalysisEvaluationGate2(
  options: ExecuteGate2Options,
): Promise<ExecuteGate2Status> {
  let externalCallsMade = 0;
  try {
    return await executeGrantAnalysisEvaluationGate2Internal(
      options,
      () => { externalCallsMade += 1; },
      () => externalCallsMade,
    );
  } catch (error) {
    throw new Gate2ExecutionError(error, externalCallsMade);
  }
}

async function executeGrantAnalysisEvaluationGate2Internal(
  options: ExecuteGate2Options,
  markFetchStarted: () => void,
  externalCallsMade: () => number,
): Promise<ExecuteGate2Status> {
  const plan = await loadGrantAnalysisEvaluationGate2Plan(options);
  if (!options.execute) {
    return {
      status: "verified",
      receiptPath: plan.receiptPath,
      receiptSha256: plan.receiptSha256,
      checkpointPath: plan.checkpointPath,
      attempts: 0,
      successes: 0,
      failures: 0,
      skipped: 0,
      externalCallsMade: 0,
      databaseWriteMode: false,
    };
  }
  if (options.confirmation !== plan.receipt.paidConfirmation ||
      options.confirmation !== GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION) {
    throw new Error("Gate 2 execution requires the exact confirmation frozen in the verified receipt.");
  }

  const checkpointStore = createGate2CheckpointStore(plan.checkpointPath);
  const verifyPersistedReservation = (reservation: GrantAnalysisEvaluationAttemptReservation) =>
    verifyGate2PersistedReservation({ checkpointStore, reservation });
  const providerFactory = options.providerFactory ?? ((context: Gate2ProviderFactoryContext) =>
    createGrantAnalysisEvaluationAnthropicProvider({
      mode: "paid",
      confirmation: context.confirmation,
      ...(context.apiKey ? { apiKey: context.apiKey } : {}),
      executionConfig: {
        configSha256: context.configSha256,
        fingerprintInput: context.fingerprintInput,
      },
      verifyPersistedReservation: context.verifyPersistedReservation,
      fetchImpl: ((input, init) => {
        context.markFetchStarted();
        return fetch(input, init);
      }) as typeof fetch,
    }));
  const provider = providerFactory({
      configSha256: plan.receipt.hashes.configSha256,
      fingerprintInput: plan.receipt.fingerprintInput,
      confirmation: options.confirmation,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      verifyPersistedReservation,
      markFetchStarted,
    });

  const schemas = evaluationSchemas();
  const receipt = await runGrantAnalysisEvaluation({
    mode: "paid",
    confirmation: options.confirmation,
    maxCalls: plan.receipt.calls.maxCalls,
    fingerprintInput: plan.receipt.fingerprintInput,
    grants: plan.receipt.runGrants,
    dependencies: {
      checkpointStore,
      judge3EligibleAxes({ judge1Result, judge2Result }) {
        return buildGrantAnalysisEvaluationConsensus({
          judge1: normalizedJudgeLedger(judge1Result, "judge_1"),
          judge2: normalizedJudgeLedger(judge2Result, "judge_2"),
        }).disagreementAxes;
      },
      stagePacketSha256({ grant, stage, eligibleAxes, priorStages }) {
        return serializeStage(plan, grant, stage, eligibleAxes, priorStages).packetSha256;
      },
      stageOutputSchemaSha256({ stage, eligibleAxes }) {
        return sha256(stableStringify(stage === "judge_3"
          ? buildGrantAnalysisEvaluationJudge3OutputSchema(eligibleAxes)
          : schemaForStage(schemas, stage)));
      },
      async executeStage(context) {
        const input = requiredInput(plan, context.grant.grantKey);
        const serialized = serializeStage(
          plan,
          context.grant,
          context.stage,
          context.eligibleAxes,
          context.priorStages,
        );
        const outputSchema = context.stage === "judge_3"
          ? buildGrantAnalysisEvaluationJudge3OutputSchema(context.eligibleAxes)
          : schemaForStage(schemas, context.stage);
        const packet = context.stage === "extract_b" ? input.rawB
          : context.stage === "extract_c" ? input.rawC
          : input.rawOnlyJudge;
        const systemPrompt = promptForStage(context.stage);
        let runtimeValidationFailure: string | null = null;
        let providerResult: GrantAnalysisEvaluationAnthropicResult;
        try {
          providerResult = await provider.call({
            stage: context.stage,
            model: plan.receipt.fingerprintInput.stages[context.stage].model,
            systemPrompt,
            userContent: serialized.userContent,
            maxTokens: plan.receipt.fingerprintInput.stages[context.stage].maxOutputTokens,
            outputSchema,
            reservation: context.reservation,
            validateOutput: (value) => {
              try {
                normalizeGrantAnalysisEvaluationGate2StageOutput({
                  stage: context.stage,
                  value,
                  grantKey: context.grant.grantKey,
                  sourceRevision: context.grant.sourceRevision,
                  packet,
                  ...(context.stage === "judge_3" ? { judge3EligibleAxes: context.eligibleAxes } : {}),
                });
                runtimeValidationFailure = null;
                return true;
              } catch (error) {
                runtimeValidationFailure = safeNormalizationFailureCode(error);
                return false;
              }
            },
          });
        } catch (error) {
          const providerFailure = safeProviderFailureCode(error);
          throw new Error(providerFailure === "provider_runtime_validation" && runtimeValidationFailure
            ? `${providerFailure}:${runtimeValidationFailure}`
            : providerFailure);
        }
        const providerOutputSha256 = requireSha256(providerResult.receipt.outputSha256, "provider output");
        if (providerResult.stage !== context.stage ||
            providerResult.model !== plan.receipt.fingerprintInput.stages[context.stage].model ||
            providerResult.stopReason !== "end_turn" ||
            providerOutputSha256 !== sha256(stableStringify(providerResult.output))) {
          throw new Error("provider_receipt_mismatch");
        }
        let normalizedOutput: unknown;
        try {
          normalizedOutput = normalizeGrantAnalysisEvaluationGate2StageOutput({
            stage: context.stage,
            value: providerResult.output,
            grantKey: context.grant.grantKey,
            sourceRevision: context.grant.sourceRevision,
            packet,
            ...(context.stage === "judge_3" ? { judge3EligibleAxes: context.eligibleAxes } : {}),
          });
        } catch {
          throw new Error("response_normalization_failed");
        }
        return {
          recordType: "grant_analysis_evaluation_gate2_stage_result",
          schemaVersion: 1,
          stage: context.stage,
          model: providerResult.model,
          stopReason: providerResult.stopReason,
          usage: safeUsage(providerResult.usage),
          providerReceipt: {
            requestId: safeProviderId(providerResult.receipt.requestId),
            messageId: safeProviderId(providerResult.receipt.messageId),
            outputSha256: providerOutputSha256,
          },
          normalizedOutput,
          normalizedOutputSha256: sha256(stableStringify(normalizedOutput)),
        } satisfies PersistedStageResult;
      },
    },
  });
  if (receipt.mode !== "paid") throw new Error("Gate 2 runner returned an unexpected plan receipt.");
  const complete = Object.values(receipt.checkpoint.grants).every((grant) =>
    (["extract_b", "extract_c", "judge_1", "judge_2", "judge_3"] as const).every((stage) =>
      grant.stages[stage]?.status === "success" || grant.stages[stage]?.status === "skipped"));
  return {
    status: complete ? "complete" : "incomplete",
    receiptPath: plan.receiptPath,
    receiptSha256: plan.receiptSha256,
    checkpointPath: plan.checkpointPath,
    attempts: receipt.attempts,
    successes: receipt.successes,
    failures: receipt.failures,
    skipped: receipt.skipped,
    externalCallsMade: externalCallsMade(),
    databaseWriteMode: false,
  };
}

export function createGate2CheckpointStore(path: string): GrantAnalysisEvaluationCheckpointStore {
  const checkpointPath = resolve(path);
  return {
    async read() {
      try {
        const bytes = await readSecureJsonBytes(checkpointPath, "Gate 2 checkpoint");
        return parseRecord(bytes, "Gate 2 checkpoint") as unknown as GrantAnalysisEvaluationRunCheckpoint;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
    },
    async write(checkpoint) {
      await writeAtomicSecureJson(checkpointPath, checkpoint);
    },
  };
}

export async function verifyGate2PersistedReservation(options: {
  checkpointStore: GrantAnalysisEvaluationCheckpointStore;
  reservation: GrantAnalysisEvaluationAttemptReservation;
}): Promise<boolean> {
  const checkpoint = await options.checkpointStore.read();
  if (!checkpoint) return false;
  const reservation = options.reservation;
  const stage = checkpoint.grants[reservation.grantKey]?.stages[reservation.stage];
  const policy = checkpoint.fingerprintInput.stages[reservation.stage];
  const recomputedConfigSha256 = sha256(stableStringify({
    fingerprintInput: checkpoint.fingerprintInput,
    grantsFingerprint: checkpoint.grantsFingerprint,
  }));
  const persistedAttempts = Object.values(checkpoint.grants).reduce((total, grant) =>
    total + Object.values(grant.stages).reduce((sum, item) => sum + (item?.attempts ?? 0), 0), 0);
  return checkpoint.recordType === "grant_analysis_evaluation_run_checkpoint" &&
    checkpoint.schemaVersion === 1 && checkpoint.databaseWriteMode === false &&
    checkpoint.fingerprint === reservation.configSha256 && checkpoint.fingerprint === recomputedConfigSha256 &&
    checkpoint.grants[reservation.grantKey]?.grantKey === reservation.grantKey &&
    checkpoint.grants[reservation.grantKey]?.sourceRevision === reservation.sourceRevision &&
    stage?.status === "running" && stage.attempts === reservation.attempt &&
    stage.reservationId === reservation.reservationId &&
    stage.packetSha256 === reservation.packetSha256 &&
    stage.outputSchemaSha256 === reservation.outputSchemaSha256 &&
    policy?.model === reservation.plannedModel && policy.maxOutputTokens === reservation.maxTokens &&
    reservation.persistedStatus === "running" && reservation.successfulStageExists === false &&
    reservation.attempt >= 1 && reservation.attempt <= 2 &&
    persistedAttempts === reservation.persistedAttempts &&
    reservation.maxCalls === checkpoint.fingerprintInput.retry.maxCalls &&
    reservation.globalAbsoluteCap === checkpoint.fingerprintInput.retry.globalAbsoluteCap &&
    reservation.globalAbsoluteCap === GRANT_ANALYSIS_EVALUATION_ABSOLUTE_MAX_CALLS &&
    persistedAttempts <= reservation.maxCalls;
}

async function writeAtomicSecureJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await assertSafeCheckpointTarget(path);
  const bytes = Buffer.from(`${stableStringify(value)}\n`, "utf8");
  const expectedHash = sha256(bytes);
  const tempPath = join(dirname(path), `.${randomBytes(16).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(tempPath, "wx", 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const tempInfo = await lstat(tempPath);
    if (!tempInfo.isFile() || tempInfo.isSymbolicLink() || (tempInfo.mode & 0o777) !== 0o600 ||
        sha256(await readFile(tempPath)) !== expectedHash) {
      throw new Error("Gate 2 checkpoint temporary write verification failed.");
    }
    await assertSafeCheckpointTarget(path);
    await rename(tempPath, path);
    await chmod(path, 0o600);
    const finalInfo = await lstat(path);
    if (!finalInfo.isFile() || finalInfo.isSymbolicLink() || (finalInfo.mode & 0o777) !== 0o600 ||
        sha256(await readFile(path)) !== expectedHash) {
      throw new Error("Gate 2 checkpoint final write verification failed.");
    }
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    if (handle) await handle.close().catch(() => undefined);
    await unlink(tempPath).catch(() => undefined);
  }
}

async function assertSafeCheckpointTarget(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
      throw new Error("Gate 2 checkpoint target must be a regular non-symlink 0600 file.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

async function readSecureJsonBytes(path: string, label: string): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must be a regular non-symlink 0600 file.`);
  }
  return readFile(path);
}

function verifyPlanBindings(
  receipt: Gate2PlanReceipt,
  inputs: ReadonlyMap<string, GrantAnalysisEvaluationGate2FrozenInput>,
): void {
  if (receipt.runGrants.length !== 3 || receipt.selected.length !== 3 || inputs.size !== 3) {
    throw new Error("Gate 2 execution requires exactly three grants and three frozen inputs.");
  }
  const roles = receipt.selected.map((entry) => entry.role).sort();
  if (stableStringify(roles) !== stableStringify(["attachment_loadable", "sparse", "structured_control"])) {
    throw new Error("Gate 2 selected role set mismatch.");
  }
  if (receipt.calls.maxAttemptsPerStage !== 2 || receipt.calls.maxCalls !== 26 ||
      receipt.calls.globalAbsoluteCap !== GRANT_ANALYSIS_EVALUATION_ABSOLUTE_MAX_CALLS ||
      receipt.calls.maxCalls !== receipt.fingerprintInput.retry.maxCalls ||
      receipt.calls.globalAbsoluteCap !== receipt.fingerprintInput.retry.globalAbsoluteCap) {
    throw new Error("Gate 2 call budget mismatch.");
  }
  const distinctCCount = [...inputs.values()].filter((input) => !input.cReusesB).length;
  const expectedCallsByStage = {
    extract_b: 3,
    extract_c: distinctCCount,
    judge_1: 3,
    judge_2: 3,
    judge_3: 3,
  };
  if (receipt.calls.base.computedUpper !== Object.values(expectedCallsByStage).reduce((sum, value) => sum + value, 0) ||
      stableStringify(receipt.calls.base.byStageUpper) !== stableStringify(expectedCallsByStage)) {
    throw new Error("Gate 2 planned stage call counts mismatch.");
  }

  const schemas = evaluationSchemas();
  const expectedPromptHashes = {
    extractor: sha256(GRANT_ANALYSIS_EVALUATION_ROLE_PROMPTS.extractor),
    judge1: sha256(GRANT_ANALYSIS_EVALUATION_ROLE_PROMPTS.judge1),
    judge2: sha256(GRANT_ANALYSIS_EVALUATION_ROLE_PROMPTS.judge2),
    judge3: sha256(GRANT_ANALYSIS_EVALUATION_ROLE_PROMPTS.judge3),
  };
  const expectedSchemaHashes = {
    extractor: sha256(stableStringify(schemas.extractor)),
    judge1: sha256(stableStringify(schemas.judge1)),
    judge2: sha256(stableStringify(schemas.judge2)),
    judge3: sha256(stableStringify(schemas.judge3)),
  };
  const expectedJudge3FactoryHash = sha256(stableStringify({
    version: GRANT_ANALYSIS_EVALUATION_JUDGE3_SCHEMA_FACTORY_VERSION,
    canonicalAxes: GRANT_ANALYSIS_EVALUATION_AXES,
    genericSchema: schemas.judge3,
  }));
  const limits = receipt.runGrants.map((grant) => requiredInput({ inputs } as LoadedGate2ExecutionPlan, grant.grantKey).attachments.limits);
  const expectedLimitsHash = sha256(stableStringify(limits));
  const expectedAccessHash = sha256(stableStringify(receipt.models.access));
  if (stableStringify(receipt.hashes.promptSha256) !== stableStringify(expectedPromptHashes) ||
      stableStringify(receipt.hashes.schemaSha256) !== stableStringify(expectedSchemaHashes) ||
      receipt.hashes.judge3SchemaFactorySha256 !== expectedJudge3FactoryHash ||
      receipt.hashes.inputLimitsSha256 !== expectedLimitsHash ||
      receipt.hashes.modelAccessReceiptSha256 !== expectedAccessHash ||
      receipt.fingerprintInput.inputLimitsSha256 !== expectedLimitsHash ||
      receipt.fingerprintInput.converter.policySha256 !== expectedLimitsHash ||
      receipt.fingerprintInput.judge3SchemaFactorySha256 !== expectedJudge3FactoryHash ||
      receipt.fingerprintInput.modelAccessReceiptSha256 !== expectedAccessHash) {
    throw new Error("Gate 2 prompt/schema/input/model-access binding mismatch.");
  }
  const stageBindings = receipt.fingerprintInput.stages;
  if (stageBindings.extract_b.promptSha256 !== expectedPromptHashes.extractor ||
      stageBindings.extract_c.promptSha256 !== expectedPromptHashes.extractor ||
      stageBindings.judge_1.promptSha256 !== expectedPromptHashes.judge1 ||
      stageBindings.judge_2.promptSha256 !== expectedPromptHashes.judge2 ||
      stageBindings.judge_3.promptSha256 !== expectedPromptHashes.judge3 ||
      stageBindings.extract_b.schemaSha256 !== expectedSchemaHashes.extractor ||
      stageBindings.extract_c.schemaSha256 !== expectedSchemaHashes.extractor ||
      stageBindings.judge_1.schemaSha256 !== expectedSchemaHashes.judge1 ||
      stageBindings.judge_2.schemaSha256 !== expectedSchemaHashes.judge2 ||
      stageBindings.judge_3.schemaSha256 !== expectedSchemaHashes.judge3 ||
      Object.entries(stageBindings).some(([stage, binding]) =>
        binding.maxOutputTokens !== GRANT_ANALYSIS_EVALUATION_STAGE_MAX_OUTPUT_TOKENS[stage as GrantAnalysisEvaluationStage])) {
    throw new Error("Gate 2 stage prompt/schema policy mismatch.");
  }
  if (receipt.fingerprintInput.converter.version !== GRANT_ANALYSIS_PILOT_INPUT_TRANSFORM_VERSION ||
      receipt.fingerprintInput.provider.boundaryVersion !== GRANT_ANALYSIS_EVALUATION_ANTHROPIC_BOUNDARY_VERSION ||
      receipt.fingerprintInput.provider.apiVersion !== GRANT_ANALYSIS_EVALUATION_ANTHROPIC_VERSION ||
      receipt.fingerprintInput.provider.endpoint !== GRANT_ANALYSIS_EVALUATION_ANTHROPIC_ENDPOINT ||
      receipt.fingerprintInput.provider.effort !== "high" ||
      receipt.fingerprintInput.provider.thinkingPolicy !== "fable-5-adaptive-thinking-omitted-request-field" ||
      receipt.fingerprintInput.provider.stopPolicy !== "accept-end_turn-only-reject-refusal-max_tokens-and-nonterminal" ||
      receipt.fingerprintInput.responseNormalizerVersion !== GRANT_ANALYSIS_EVALUATION_RESPONSE_NORMALIZER_VERSION ||
      receipt.fingerprintInput.groundingVersion !== GRANT_ANALYSIS_EVALUATION_GROUNDING_VERSION) {
    throw new Error("Gate 2 committed runtime boundary mismatch.");
  }
  if (receipt.models.primary !== GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL ||
      receipt.models.explicitAccessFallback !== GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL ||
      receipt.models.access.authenticatedModelsGetCalls !== 1 ||
      stableStringify(receipt.models.access.requestedModelIds) !== stableStringify([
        GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL,
        GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL,
      ]) ||
      stableStringify(receipt.models.roleAssignments) !== stableStringify({
        extractor: receipt.models.primary,
        judge1: receipt.models.primary,
        judge2: receipt.models.primary,
        judge3: receipt.models.primary,
      }) ||
      Object.values(receipt.fingerprintInput.stages).some((stage) =>
        stage.model !== receipt.models.primary || receipt.models.access.available[stage.model] !== true) ||
      stableStringify(receipt.fingerprintInput.modelAccess) !== stableStringify(receipt.models.access.available)) {
    throw new Error("Gate 2 model assignment/access mismatch.");
  }

  for (const runGrant of receipt.runGrants) {
    const input = requiredInput({ inputs } as LoadedGate2ExecutionPlan, runGrant.grantKey);
    const selected = receipt.selected.find((entry) => entry.grantKey === runGrant.grantKey);
    if (!selected || input.recordType !== "grant_analysis_evaluation_gate2_frozen_input" ||
        input.schemaVersion !== 1 || input.readOnly !== true || input.externalLlmCalls !== 0 ||
        input.grantKey !== runGrant.grantKey || input.sourceRevision !== runGrant.sourceRevision ||
        input.rawB.grantKey !== input.grantKey || input.rawC.grantKey !== input.grantKey ||
        input.rawOnlyJudge.grantKey !== input.grantKey ||
        input.rawB.sourceRevision !== input.sourceRevision || input.rawC.sourceRevision !== input.sourceRevision ||
        input.rawOnlyJudge.sourceRevision !== input.sourceRevision) {
      throw new Error(`${runGrant.grantKey}: Gate 2 identity/revision mismatch.`);
    }
    const selectedProjection = {
      role: input.selectionRole,
      rationale: input.selectionRationale,
      grantKey: input.grantKey,
      canonicalId: input.canonicalId,
      title: input.title,
      sourceRevision: input.sourceRevision,
      baselineCriteriaCount: input.baselineCriteriaCount,
      rawBInputSha256: input.rawB.packetSha256,
      rawCInputSha256: input.rawC.packetSha256,
      judgeInputSha256: input.judgeInputSha256,
      cReusesB: input.cReusesB,
      attachmentCompleteness: input.attachments.counts,
      attachmentTruncation: input.attachments.truncation,
      attachmentFailures: input.attachments.failures,
      warnings: input.warnings,
    };
    if (stableStringify(selected) !== stableStringify(selectedProjection) ||
        Object.values(input.attachments.truncation).some((value) => value !== 0) ||
        input.attachments.transformVersion !== receipt.fingerprintInput.converter.version) {
      throw new Error(`${runGrant.grantKey}: Gate 2 role/metadata/truncation mismatch.`);
    }
    const rawB = serializeGrantAnalysisEvaluationExtractorPacketForProvider(input.rawB);
    const rawC = serializeGrantAnalysisEvaluationExtractorPacketForProvider(input.rawC);
    const rebuiltJudge = buildGrantAnalysisEvaluationJudgePacket({
      grantKey: input.grantKey,
      sourceRevision: input.sourceRevision,
      blocks: input.rawC.blocks,
      inputLimits: input.attachments.limits,
    });
    const judge1 = serializeGrantAnalysisEvaluationJudgePacketForProvider({ stage: "judge_1", raw: input.rawOnlyJudge });
    const judge2 = serializeGrantAnalysisEvaluationJudgePacketForProvider({ stage: "judge_2", raw: input.rawOnlyJudge });
    if (stableStringify(rebuiltJudge) !== stableStringify(input.rawOnlyJudge) ||
        sha256(stableStringify(input.rawOnlyJudge)) !== input.judgeInputSha256 ||
        input.cReusesB !== (rawB.packetSha256 === rawC.packetSha256) ||
        stableStringify(runGrant.inputOrderByStage) !== stableStringify({
          extract_b: input.rawB.inputOrder,
          extract_c: input.rawC.inputOrder,
          judge_1: input.rawOnlyJudge.inputOrder,
          judge_2: input.rawOnlyJudge.inputOrder,
          judge_3: input.rawOnlyJudge.inputOrder,
        }) || runGrant.packetSha256.extract_b !== rawB.packetSha256 ||
        runGrant.packetSha256.extract_c !== rawC.packetSha256 ||
        runGrant.packetSha256.judge_1 !== judge1.packetSha256 ||
        runGrant.packetSha256.judge_2 !== judge2.packetSha256 ||
        runGrant.packetSha256.judge_3 !== sha256(stableStringify({
          stage: "judge_3",
          rawPacketSha256: input.judgeInputSha256,
          judge3SchemaFactorySha256: expectedJudge3FactoryHash,
        })) ||
        runGrant.apiInputSha256 !== rawB.packetSha256 ||
        runGrant.attachmentInputSha256 !== rawC.packetSha256 ||
        runGrant.judgeInputSha256 !== input.judgeInputSha256) {
      throw new Error(`${runGrant.grantKey}: Gate 2 frozen packet/hash mismatch.`);
    }
  }
  const fingerprint = grantAnalysisEvaluationRunFingerprint({
    fingerprintInput: receipt.fingerprintInput,
    grants: receipt.runGrants,
  });
  if (receipt.manifestSha256 !== receipt.fingerprintInput.manifestSha256 ||
      fingerprint.fingerprint !== receipt.hashes.configSha256) {
    throw new Error("Gate 2 execution config hash mismatch.");
  }
}

function assertReceiptEnvelope(receipt: Gate2PlanReceipt): void {
  if (!receipt || receipt.recordType !== "grant_analysis_evaluation_gate2_plan_receipt" ||
      receipt.schemaVersion !== 1 || receipt.preparationVersion !== GRANT_ANALYSIS_EVALUATION_GATE2_VERSION ||
      receipt.mode !== "plan" || receipt.paidConfirmation !== GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION ||
      receipt.persistenceRequiredBeforePaidCall !== true || receipt.databaseWriteMode !== false ||
      receipt.externalMessagesCalls !== 0 || !Array.isArray(receipt.selected) || !Array.isArray(receipt.runGrants)) {
    throw new Error("Gate 2 receipt contract mismatch.");
  }
}

function serializeStage(
  plan: LoadedGate2ExecutionPlan,
  grant: GrantAnalysisEvaluationRunGrant,
  stage: GrantAnalysisEvaluationStage,
  eligibleAxes: readonly (typeof GRANT_ANALYSIS_EVALUATION_AXES)[number][],
  priorStages: Readonly<Partial<Record<GrantAnalysisEvaluationStage, GrantAnalysisEvaluationStageCheckpoint>>>,
): { userContent: string; packetSha256: string } {
  const input = requiredInput(plan, grant.grantKey);
  if (stage === "extract_b") return serializeGrantAnalysisEvaluationExtractorPacketForProvider(input.rawB);
  if (stage === "extract_c") return serializeGrantAnalysisEvaluationExtractorPacketForProvider(input.rawC);
  if (stage === "judge_1" || stage === "judge_2") {
    return serializeGrantAnalysisEvaluationJudgePacketForProvider({ stage, raw: input.rawOnlyJudge });
  }
  return serializeGrantAnalysisEvaluationJudgePacketForProvider({
    stage: "judge_3",
    raw: input.rawOnlyJudge,
    judge1: normalizedJudgeLedger(priorStages.judge_1?.result, "judge_1"),
    judge2: normalizedJudgeLedger(priorStages.judge_2?.result, "judge_2"),
    eligibleAxes,
  });
}

function normalizedJudgeLedger(value: unknown, expected: "judge_1" | "judge_2"): GrantAnalysisEvaluationJudgeLedger {
  const result = value as Partial<PersistedStageResult> | undefined;
  const ledger = result?.normalizedOutput as GrantAnalysisEvaluationJudgeLedger | undefined;
  if (result?.recordType !== "grant_analysis_evaluation_gate2_stage_result" ||
      ledger?.recordType !== "grant_analysis_evaluation_judge_ledger" || ledger.judgeId !== expected) {
    throw new Error(`Gate 2 ${expected} normalized checkpoint result is unavailable.`);
  }
  return ledger;
}

function requiredInput(
  plan: Pick<LoadedGate2ExecutionPlan, "inputs">,
  grantKey: string,
): GrantAnalysisEvaluationGate2FrozenInput {
  const input = plan.inputs.get(grantKey);
  if (!input) throw new Error(`${grantKey}: missing frozen Gate 2 input.`);
  return input;
}

function schemaForStage(schemas: ReturnType<typeof evaluationSchemas>, stage: GrantAnalysisEvaluationStage) {
  if (stage === "extract_b" || stage === "extract_c") return schemas.extractor;
  if (stage === "judge_1") return schemas.judge1;
  if (stage === "judge_2") return schemas.judge2;
  return schemas.judge3;
}

function promptForStage(stage: GrantAnalysisEvaluationStage): string {
  if (stage === "extract_b" || stage === "extract_c") return GRANT_ANALYSIS_EVALUATION_ROLE_PROMPTS.extractor;
  if (stage === "judge_1") return GRANT_ANALYSIS_EVALUATION_ROLE_PROMPTS.judge1;
  if (stage === "judge_2") return GRANT_ANALYSIS_EVALUATION_ROLE_PROMPTS.judge2;
  return GRANT_ANALYSIS_EVALUATION_ROLE_PROMPTS.judge3;
}

function safeUsage(value: Record<string, unknown> | null): Record<string, number> | null {
  if (!value) return null;
  return Object.fromEntries(Object.entries(value)
    .filter((entry): entry is [string, number] => {
      const [key, item] = entry;
      return /^[a-z][a-z0-9_]{0,63}$/.test(key) && typeof item === "number" && Number.isFinite(item);
    }));
}

function safeProviderId(value: string | null): string | null {
  return value && /^[a-zA-Z0-9._:-]{1,200}$/.test(value) ? value : null;
}

function safeProviderFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("reached max_tokens")) return "provider_max_tokens";
  if (message.includes("refused the request")) return "provider_refusal";
  if (message.includes("returned a non-terminal stop reason")) return "provider_nonterminal";
  if (message.includes("returned an unpinned model")) return "provider_model_mismatch";
  if (message.includes("returned invalid envelope JSON")) return "provider_invalid_envelope";
  if (message.includes("returned invalid structured JSON")) return "provider_invalid_structured_json";
  if (message.includes("failed runtime schema validation")) return "provider_runtime_validation";
  if (message.includes("returned non-text structured output") ||
      message.includes("did not return exactly one text output")) {
    return "provider_output_shape";
  }
  if (message.includes("request failed before response")) return "provider_transport_failure";
  const status = message.match(/failed \(status=(\d{3})/);
  return status ? `provider_http_${status[1]}` : "provider_call_failed";
}

function safeNormalizationFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Truncated or schema-recovered")) return "truncated_or_recovered";
  if (message.includes("explicit_no_condition is forbidden")) return "explicit_no_condition_unread_input";
  if (message.includes("confirmed states require grounded evidence")) return "grounding_required";
  if (message.includes("not grounded in its claimed packet block")) return "grounding_mismatch";
  if (message.includes("canonical bytewise order") || message.includes("canonical axis order") ||
      message.includes("eligible axis") || message.includes("eligible axes") ||
      message.includes("Duplicate axis") || message.includes("every eligible axis")) {
    return "axis_set_or_order";
  }
  if (message.includes("normalizedCondition") || message.includes("criteria[")) return "normalized_condition";
  if (message.includes("requiredDocuments") || message.includes("required document")) return "required_documents";
  if (message.includes("identity") || message.includes("revision drifted")) return "identity";
  if (message.includes("missing or extra keys") || message.includes("must be an object") ||
      message.includes("must be an array")) return "output_shape";
  if (message.includes("confidence") || message.includes("exceptions") ||
      message.includes("logicalRelation") || message.includes("applicablePeriod") ||
      message.includes("note must be") || message.includes("state is invalid")) return "axis_fields";
  return "normalization_unknown";
}

function requireSha256(value: string, label: string): string {
  if (!/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${label} hash is invalid.`);
  return value.toLowerCase();
}

function safeArtifactName(grantKey: string): string {
  return grantKey.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function parseRecord(bytes: Buffer, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a JSON object.`);
  return value as Record<string, unknown>;
}

function sha256(value: string | Uint8Array): string {
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

function readArg(name: string): string | undefined {
  return process.argv.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
}

function assertCliArguments(arguments_: readonly string[]): void {
  for (const argument of arguments_) {
    if (argument === "--execute" || argument.startsWith("--confirmation=") ||
        argument.startsWith("--receipt=") || argument.startsWith("--checkpoint=")) continue;
    throw new Error(`Unsupported Gate 2 execution argument: ${argument}`);
  }
}

async function main(): Promise<void> {
  assertCliArguments(process.argv.slice(2));
  const execute = process.argv.includes("--execute");
  const confirmation = readArg("confirmation");
  const receiptPath = readArg("receipt");
  const checkpointPath = readArg("checkpoint");
  const apiKey = execute ? process.env.ANTHROPIC_API_KEY : undefined;
  const status = await executeGrantAnalysisEvaluationGate2({
    execute,
    ...(confirmation ? { confirmation } : {}),
    ...(receiptPath ? { receiptPath } : {}),
    ...(checkpointPath ? { checkpointPath } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  console.log(JSON.stringify(status));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(JSON.stringify({
      status: "failed",
      error: error instanceof Error ? error.message : "Gate 2 execution failed.",
      externalCallsMade: error instanceof Gate2ExecutionError ? error.externalCallsMade : 0,
      databaseWriteMode: false,
    }));
    process.exitCode = 1;
  });
}
