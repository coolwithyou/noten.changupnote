import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AnalysisLabDeepOnlyExecutionError,
  executePreparedLabAnalysis,
  type PreparedLabAnalysis,
} from "./analyze";
import { AnalysisLabExecutionPausedError } from "./analysis-execution-admission";

const preparedInputText = "[공모 딥분석 실험실 입력]\n단건 원문";
const prepared = {
  grant: {
    id: "grant-one",
    source: "kstartup",
    sourceId: "source-one",
    title: "단건 공고",
  },
  input: {
    text: preparedInputText,
    blocks: [{ label: "공고 구조화 필드", chars: 4, truncated: false }],
    totalChars: 21,
    inputSha256: createHash("sha256").update(preparedInputText).digest("hex"),
    attachmentManifestSha256: "c".repeat(64),
  },
  currentCriteria: [],
  currentSources: [],
} satisfies PreparedLabAnalysis;

const signal = new AbortController().signal;

await assert.rejects(
  executePreparedLabAnalysis(prepared, {
    model: "claude-opus-5",
    transport: "claude-cli",
    signal,
  }),
  AnalysisLabExecutionPausedError,
  "receipt-bound context 밖에서는 prepared execute도 계속 정적 차단한다",
);

await assert.rejects(
  executePreparedLabAnalysis(prepared, {
    model: "claude-opus-5",
    transport: "claude-cli",
    signal,
    withApplicationRoundtrip: true,
  } as never),
  AnalysisLabDeepOnlyExecutionError,
  "exact canary surface에 Kordoc/application 옵션을 밀어 넣을 수 없어야 한다",
);

const source = readFileSync(new URL("./analyze.ts", import.meta.url), "utf8");
const wrapperStart = source.indexOf("export async function runLabAnalysis(");
const prepareCall = source.indexOf("prepareLabAnalysis(grantId)", wrapperStart);
const admission = source.indexOf("assertAnalysisLabLiveExecutionAdmitted();", wrapperStart);
assert.ok(wrapperStart >= 0 && admission > wrapperStart && prepareCall > admission);
assert.ok(
  admission < prepareCall,
  "legacy wrapper는 DB read-only prepare보다 먼저 Gate R을 유지해야 한다",
);
const prepareStart = source.indexOf("export async function prepareLabAnalysis(");
const executeStart = source.indexOf("export async function executePreparedLabAnalysis(");
const internalStart = source.indexOf("async function executePreparedLabAnalysisInternal(");
assert.ok(prepareStart > wrapperStart && executeStart > prepareStart && internalStart > executeStart);
const prepareSource = source.slice(prepareStart, executeStart);
assert.match(prepareSource, /const db = getCunoteDb\(\);/);
assert.match(prepareSource, /const input = await assembleLabInput\(/);
assert.doesNotMatch(prepareSource, /runValidatedLabPrimary|buildClaudeCliFetch|saveLabRun/);
const executionTypeStart = source.indexOf("export interface PreparedLabAnalysisExecution");
const executionTypeEnd = source.indexOf("export class AnalysisLabDeepOnlyExecutionError", executionTypeStart);
const executionTypeSource = source.slice(executionTypeStart, executionTypeEnd);
assert.doesNotMatch(
  executionTypeSource,
  /application|roundtrip|review|promotion|taskInstruction/i,
  "receipt-bound execute type은 deep-primary 외 레인을 표현할 수 없어야 한다",
);
const internalSource = source.slice(internalStart);
assert.ok(
  internalSource.indexOf("assertAnalysisLabLiveExecutionAdmitted({")
    < internalSource.indexOf("const bindingPromise ="),
  "exact authority binding 검사는 transport/model 시작보다 먼저여야 한다",
);
assert.match(internalSource, /runValidatedLabPrimary\(\{[\s\S]*opts\?\.signal/);

console.log("analysis-lab prepared execution tests: ok");
