import type {
  DeepAnalysisModelResult,
  DeepAnalysisUsage,
} from "@cunote/contracts";
import type { DeepAnalysisInputChunk, DeepAnalysisInputSeal } from "./inputManifest";
import { sumDeepAnalysisActualCosts } from "./costPolicy";
import { runDeepGrantAnalysis } from "./extractor";

export const DEEP_ANALYSIS_SINGLE_PROMPT_CHARS = 140_000;

export interface DeepAnalysisModelPass {
  kind: "single" | "map" | "synthesis" | "repair";
  chunkId: string | null;
  inputChars: number;
  result: DeepAnalysisModelResult;
}

export interface DeepAnalysisExecution {
  result: DeepAnalysisModelResult;
  passes: DeepAnalysisModelPass[];
  evidenceText: string;
}

type ModelRunner = typeof runDeepGrantAnalysis;

/**
 * 입력 seal의 모든 chunk를 모델에 전달한다. 장문은 각 chunk를 독립 분석한 뒤 원문 span을
 * 유지한 synthesis를 수행하며, map 결과와 usage도 버리지 않고 raw artifact에 남길 수 있게
 * 반환한다.
 */
export async function analyzeSealedDeepAnalysisInput(input: {
  seal: DeepAnalysisInputSeal;
  apiKey: string;
  model: string;
  singlePromptChars?: number;
  runModel?: ModelRunner;
}): Promise<DeepAnalysisExecution> {
  if (!input.seal.sealed) {
    throw new Error(`Deep analysis input is not sealed: ${input.seal.blockers.map((item) => item.code).join(",")}`);
  }
  const evidenceText = renderDeepAnalysisChunks(input.seal.chunks);
  const threshold = input.singlePromptChars ?? DEEP_ANALYSIS_SINGLE_PROMPT_CHARS;
  if (!Number.isInteger(threshold) || threshold < 1_000) {
    throw new Error("singlePromptChars must be an integer >= 1,000");
  }
  const runModel = input.runModel ?? runDeepGrantAnalysis;
  if (evidenceText.length <= threshold || input.seal.chunks.length <= 1) {
    const result = await runModel({
      apiKey: input.apiKey,
      inputText: evidenceText,
      evidenceText,
      model: input.model,
    });
    return {
      result,
      evidenceText,
      passes: [{ kind: "single", chunkId: null, inputChars: evidenceText.length, result }],
    };
  }

  const mapPasses: DeepAnalysisModelPass[] = [];
  for (const chunk of input.seal.chunks) {
    const chunkText = renderDeepAnalysisChunks([chunk]);
    const result = await runModel({
      apiKey: input.apiKey,
      inputText: chunkText,
      evidenceText: chunkText,
      model: input.model,
      taskInstruction: [
        "이 입력은 전체 공고를 무손실 분할한 한 chunk다.",
        "이 chunk에서 직접 확인되는 조건만 22축으로 분석하고 다른 chunk 내용을 추정하지 마라.",
        "관련 내용이 이 chunk에 없으면 inspected_no_condition으로 두되 최종 전축 판정은 synthesis가 수행한다.",
      ].join(" "),
    });
    mapPasses.push({
      kind: "map",
      chunkId: chunk.id,
      inputChars: chunkText.length,
      result,
    });
  }

  const synthesisInput = renderSynthesisInput(mapPasses);
  const synthesized = await runModel({
    apiKey: input.apiKey,
    inputText: synthesisInput,
    evidenceText,
    model: input.model,
    taskInstruction: [
      "아래에는 같은 공고의 무손실 chunk별 독립 분석 결과가 있다.",
      "모든 결과를 합쳐 공고 전체의 최종 22축 판정을 한 번만 반환하라.",
      "source_span은 chunk 결과에 제시된 원문 문자열만 글자 그대로 사용하고 새 인용을 만들지 마라.",
      "어느 chunk에서든 condition_found이면 다른 chunk의 inspected_no_condition보다 우선한다.",
      "서로 충돌하거나 안전하게 합칠 수 없으면 ambiguous로 둔다.",
    ].join(" "),
  });
  const passes: DeepAnalysisModelPass[] = [
    ...mapPasses,
    {
      kind: "synthesis",
      chunkId: null,
      inputChars: synthesisInput.length,
      result: synthesized,
    },
  ];
  return {
    evidenceText,
    passes,
    result: {
      ...synthesized,
      usage: sumUsage(passes.map((pass) => pass.result.usage)),
      costUsd: sumDeepAnalysisActualCosts(passes.map((pass) => pass.result.costUsd)),
    },
  };
}

export function renderDeepAnalysisChunks(chunks: readonly DeepAnalysisInputChunk[]): string {
  return chunks.map((chunk) => [
    `<<<DEEP_ANALYSIS_SOURCE id="${chunk.id}" kind="${chunk.sourceKind}" sha256="${chunk.sha256}">>>`,
    chunk.text,
    "<<<END_DEEP_ANALYSIS_SOURCE>>>",
  ].join("\n")).join("\n\n");
}

function renderSynthesisInput(passes: readonly DeepAnalysisModelPass[]): string {
  return passes.map((pass, index) => JSON.stringify({
    chunkIndex: index,
    chunkId: pass.chunkId,
    analysisMarkdown: pass.result.analysisMarkdown,
    programIntent: pass.result.programIntent,
    criteria: pass.result.criteria,
    axisAssessments: pass.result.axisAssessments,
    taxonomyProposals: pass.result.taxonomyProposals,
  })).join("\n");
}

function sumUsage(values: Array<DeepAnalysisUsage | null>): DeepAnalysisUsage | null {
  const present = values.filter((value): value is DeepAnalysisUsage => value !== null);
  if (present.length === 0) return null;
  const cacheValues = present.map((value) => value.cacheReadTokens);
  return {
    inputTokens: present.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: present.reduce((sum, value) => sum + value.outputTokens, 0),
    cacheReadTokens: cacheValues.every((value) => value === null)
      ? null
      : cacheValues.reduce<number>((sum, value) => sum + (value ?? 0), 0),
  };
}
