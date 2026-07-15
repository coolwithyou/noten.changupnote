import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  type GrantAnalysisEvaluationAttemptReservation,
  type GrantAnalysisEvaluationRunFingerprintInput,
  type GrantAnalysisEvaluationStage,
} from "../matches/run-grant-analysis-evaluation";
import {
  GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL,
  GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL,
  createGrantAnalysisEvaluationAnthropicProvider,
  type GrantAnalysisEvaluationAnthropicRequest,
} from "./grantAnalysisEvaluationAnthropic";

const schema = { type: "object", required: ["call"] };
const stages: GrantAnalysisEvaluationStage[] = ["extract_b", "extract_c", "judge_1", "judge_2", "judge_3"];
const fingerprintInput = config();
const executionConfig = { configSha256: "f".repeat(64), fingerprintInput };
let fetchCalls = 0;
const fakeFetch: typeof fetch = async (_url, init) => {
  fetchCalls += 1;
  const body = JSON.parse(String(init?.body)) as {
    model: string;
    temperature?: number;
    messages: Array<{ role: string; content: string }>;
    tools?: unknown;
    tool_choice?: unknown;
    output_config: { effort: string; format: { type: string; schema: Record<string, unknown> } };
  };
  assert.equal(body.messages.length, 1);
  assert.equal(body.messages[0]?.role, "user");
  assert.equal(body.temperature, undefined);
  assert.equal(body.tools, undefined);
  assert.equal(body.tool_choice, undefined);
  assert.equal(body.output_config.effort, "high");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(typeof body.output_config.format.schema, "object");
  return new Response(JSON.stringify({
    id: `msg_fixture_${fetchCalls}`,
    model: body.model,
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    content: [
      { type: "thinking", text: "fixture thinking" },
      { type: "redacted_thinking" },
      { type: "text", text: JSON.stringify({ call: fetchCalls }) },
    ],
  }), { status: 200, headers: { "request-id": `req_fixture_${fetchCalls}` } });
};

const planProvider = provider({ mode: "plan", fetchImpl: fakeFetch });
await assert.rejects(() => planProvider.call(request("extract_b", 1)), /Plan mode cannot call/);
assert.equal(fetchCalls, 0);

const unconfirmed = provider({ mode: "paid", fetchImpl: fakeFetch });
await assert.rejects(() => unconfirmed.call(request("extract_b", 1)), /requires confirmation/);
assert.equal(fetchCalls, 0);

const paid = provider({
  mode: "paid",
  confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  fetchImpl: fakeFetch,
});
for (const [index, stage] of stages.entries()) {
  const result = await paid.call(request(stage, index + 1));
  assert.deepEqual(result.output, { call: index + 1 });
  assert.equal(result.stage, stage);
  assert.equal(result.receipt.requestId, `req_fixture_${index + 1}`);
  assert.equal(result.receipt.messageId, `msg_fixture_${index + 1}`);
  assert.deepEqual(result.receipt.usage, { input_tokens: 10, output_tokens: 5 });
  assert.equal(result.receipt.outputSha256, sha256(stableStringify({ call: index + 1 })));
}
assert.equal(fetchCalls, 5);
const subsetSchema = {
  type: "object",
  additionalProperties: false,
  required: ["axes"],
  properties: { axes: { type: "array", items: { type: "string", enum: ["industry"] } } },
};
const subsetRequest = request("judge_3", 6);
subsetRequest.outputSchema = subsetSchema;
subsetRequest.reservation = {
  ...subsetRequest.reservation,
  outputSchemaSha256: sha256(stableStringify(subsetSchema)),
};
const subsetResult = await paid.call(subsetRequest);
assert.deepEqual(subsetResult.output, { call: 6 }, "dynamic Judge 3 subset schema is accepted when reservation-bound");
assert.equal(fetchCalls, 6);

for (const [label, mutate, pattern] of [
  ["unverified", (r: GrantAnalysisEvaluationAnthropicRequest) => r, /reservation was not verified/],
  ["config", (r: GrantAnalysisEvaluationAnthropicRequest) => ({ ...r, reservation: { ...r.reservation, configSha256: "0".repeat(64) } }), /valid persisted attempt/],
  ["model", (r: GrantAnalysisEvaluationAnthropicRequest) => ({ ...r, model: GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL }), /valid persisted attempt|frozen execution policy/],
  ["tokens", (r: GrantAnalysisEvaluationAnthropicRequest) => ({ ...r, maxTokens: 101 }), /valid persisted attempt|frozen execution policy/],
  ["replay", (r: GrantAnalysisEvaluationAnthropicRequest) => ({ ...r, reservation: { ...r.reservation, successfulStageExists: true as never } }), /valid persisted attempt/],
  ["attempt", (r: GrantAnalysisEvaluationAnthropicRequest) => ({ ...r, reservation: { ...r.reservation, attempt: 3 } }), /valid persisted attempt/],
  ["budget", (r: GrantAnalysisEvaluationAnthropicRequest) => ({ ...r, reservation: { ...r.reservation, persistedAttempts: 21 } }), /valid persisted attempt/],
  ["packet", (r: GrantAnalysisEvaluationAnthropicRequest) => ({ ...r, userContent: `${r.userContent}-drift` }), /frozen execution policy/],
  ["prompt", (r: GrantAnalysisEvaluationAnthropicRequest) => ({ ...r, systemPrompt: "drift" }), /frozen execution policy/],
  ["schema", (r: GrantAnalysisEvaluationAnthropicRequest) => ({ ...r, outputSchema: subsetSchema }), /frozen execution policy/],
] as const) {
  let localFetches = 0;
  const guarded = provider({
    mode: "paid",
    confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
    verifyPersistedReservation: label !== "unverified",
    fetchImpl: async (...args) => { localFetches += 1; return fakeFetch(...args); },
  });
  await assert.rejects(() => guarded.call(mutate(request("extract_b", 99))), pattern);
  assert.equal(localFetches, 0, `${label} rejection must make zero fetch calls`);
}

const unavailableConfig = structuredClone(fingerprintInput);
unavailableConfig.modelAccess = {
  ...unavailableConfig.modelAccess,
  [GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL]: false,
};
let unavailableFetches = 0;
const unavailable = createGrantAnalysisEvaluationAnthropicProvider({
  mode: "paid",
  confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  apiKey: "fixture-key",
  executionConfig: { configSha256: executionConfig.configSha256, fingerprintInput: unavailableConfig },
  verifyPersistedReservation: () => true,
  fetchImpl: async () => { unavailableFetches += 1; return new Response(); },
});
await assert.rejects(() => unavailable.call(request("extract_b", 1)), /frozen execution policy/);
assert.equal(unavailableFetches, 0, "unavailable assigned model fails before fetch");

await assertProviderRejects({
  model: GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL, stop_reason: "max_tokens",
  content: [{ type: "text", text: "{}" }],
}, /reached max_tokens/);
await assertProviderRejects({
  model: GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL, stop_reason: "refusal",
  content: [{ type: "text", text: "{}" }],
}, /refused the request/);
await assertProviderRejects({
  model: GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL, stop_reason: "end_turn",
  content: [{ type: "thinking", text: "hidden" }],
}, /exactly one text output/);
await assertProviderRejects({
  model: GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL, stop_reason: "end_turn",
  content: [{ type: "tool_use" }, { type: "text", text: "{}" }],
}, /non-text structured output/);
await assertProviderRejects({
  model: GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL, stop_reason: "end_turn",
  content: [{ type: "text", text: "not-json" }],
}, /invalid structured JSON/);
await assertProviderRejects({
  model: GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL, stop_reason: "end_turn",
  content: [{ type: "text", text: "{}" }],
}, /runtime schema validation/);
await assertProviderRejects({
  model: GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL, stop_reason: "end_turn",
  content: [{ type: "text", text: "{}" }, { type: "text", text: "{}" }],
}, /exactly one text output/);
await assertProviderRejects({
  model: GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL, stop_reason: "end_turn",
  content: [{ type: "text", text: "{}" }],
}, /unpinned model/);

const redacted = provider({
  mode: "paid",
  confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
  fetchImpl: async () => new Response("secret provider body", {
    status: 400,
    headers: { "request-id": "req_safe" },
  }),
});
await assert.rejects(
  () => redacted.call(request("judge_1", 99)),
  (error: unknown) => error instanceof Error && error.message.includes("status=400 requestId=req_safe") &&
    !error.message.includes("secret provider body"),
);

console.log("grantAnalysisEvaluationAnthropic.test.ts: all assertions passed");

function provider(options: {
  mode: "plan" | "paid";
  confirmation?: string;
  fetchImpl: typeof fetch;
  verifyPersistedReservation?: boolean;
}) {
  return createGrantAnalysisEvaluationAnthropicProvider({
    ...options,
    apiKey: "fixture-key",
    executionConfig,
    verifyPersistedReservation: () => options.verifyPersistedReservation ?? true,
  });
}

async function assertProviderRejects(payload: unknown, pattern: RegExp): Promise<void> {
  const guarded = provider({
    mode: "paid",
    confirmation: GRANT_ANALYSIS_EVALUATION_PAID_CONFIRMATION,
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  await assert.rejects(() => guarded.call(request("judge_1", 99)), pattern);
}

function request(stage: GrantAnalysisEvaluationStage, call: number): GrantAnalysisEvaluationAnthropicRequest {
  const userContent = `raw-input-${call}`;
  const model = GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL;
  return {
    stage,
    model,
    systemPrompt: `role-prompt-${stage}`,
    userContent,
    maxTokens: 100,
    outputSchema: schema,
    validateOutput(value) {
      return typeof value === "object" && value !== null &&
        typeof (value as { call?: unknown }).call === "number";
    },
    reservation: reservation(stage, model, userContent),
  };
}

function reservation(
  stage: GrantAnalysisEvaluationStage,
  model: string,
  userContent: string,
): GrantAnalysisEvaluationAttemptReservation {
  return {
    recordType: "grant_analysis_evaluation_attempt_reservation",
    schemaVersion: 1,
    reservationId: sha256(`reservation:${stage}:${userContent}`),
    configSha256: executionConfig.configSha256,
    grantKey: "kstartup:fixture",
    sourceRevision: "a".repeat(64),
    stage,
    attempt: 1,
    plannedModel: model,
    maxTokens: 100,
    packetSha256: sha256(userContent),
    outputSchemaSha256: sha256(stableStringify(schema)),
    persistedStatus: "running",
    successfulStageExists: false,
    persistedAttempts: 1,
    maxCalls: 20,
    globalAbsoluteCap: 200,
  };
}

function config(): GrantAnalysisEvaluationRunFingerprintInput {
  const stagePolicies = Object.fromEntries(stages.map((stage) => [stage, {
    model: GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL,
    maxOutputTokens: 100,
    promptSha256: sha256(`role-prompt-${stage}`),
    schemaSha256: sha256(stableStringify(schema)),
  }])) as GrantAnalysisEvaluationRunFingerprintInput["stages"];
  return {
    runVersion: "grant-analysis-evaluation-gate1-v1",
    manifestSha256: "manifest",
    inputLimitsSha256: "limits",
    converter: { version: "converter", policySha256: "policy" },
    provider: {
      boundaryVersion: "grant-analysis-evaluation-anthropic-boundary-v2",
      apiVersion: "2023-06-01",
      endpoint: "https://api.anthropic.com/v1/messages",
      effort: "high",
      thinkingPolicy: "adaptive",
      stopPolicy: "end_turn_only",
    },
    responseNormalizerVersion: "normalizer",
    groundingVersion: "grounding",
    stages: stagePolicies,
    judge3SchemaFactorySha256: "factory",
    modelAccessReceiptSha256: "access",
    modelAccess: {
      [GRANT_ANALYSIS_EVALUATION_PRIMARY_MODEL]: true,
      [GRANT_ANALYSIS_EVALUATION_FALLBACK_MODEL]: true,
    },
    retry: { maxAttemptsPerStage: 2, maxCalls: 20, globalAbsoluteCap: 200 },
  };
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
