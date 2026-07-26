import {
  DEEP_ANALYSIS_AGGREGATE_SPLIT_DEFAULT_MAX_COST_USD,
  DEEP_ANALYSIS_PRIMARY_MODELS,
  type DeepAnalysisUsage,
} from "@cunote/contracts";

import type {
  DeepAnalysisInputChunk,
  DeepAnalysisInputSeal,
} from "./inputManifest";
import { sha256Hex, stableJson } from "./sourceRevision";

export const AGGREGATE_SPLIT_MANIFEST_SCHEMA =
  "aggregate-split-manifest-v1" as const;
export const AGGREGATE_SPLIT_MAP_PROMPT_VERSION =
  "aggregate-split-map-v3" as const;
export const AGGREGATE_SPLIT_SYNTHESIS_PROMPT_VERSION =
  "aggregate-split-synthesis-v1" as const;
export const DEFAULT_AGGREGATE_SPLIT_SEGMENT_CHARS = 6_000;
export const DEFAULT_AGGREGATE_SPLIT_MAP_INPUT_CHARS = 72_000;
export const DEFAULT_AGGREGATE_SPLIT_MAX_COST_USD =
  DEEP_ANALYSIS_AGGREGATE_SPLIT_DEFAULT_MAX_COST_USD;

const MAP_MAX_TOKENS = 6_000;
const SYNTHESIS_MAX_TOKENS = 12_000;
const MODEL_TIMEOUT_MS = 240_000;
const RETRYABLE_STATUSES = new Set([429, 500, 529]);
const RETRY_DELAY_MS = 5_000;
const USD_PER_INPUT_TOKEN = 5 / 1e6;
const USD_PER_OUTPUT_TOKEN = 25 / 1e6;
const USD_PER_CACHE_READ_TOKEN = 0.5 / 1e6;

export interface AggregateSplitSegment {
  id: string;
  ordinal: number;
  sourceKind: DeepAnalysisInputChunk["sourceKind"];
  sourceId: string;
  startChar: number;
  endChar: number;
  chars: number;
  sha256: string;
  text: string;
}

export interface AggregateSplitProgram {
  stableKey: string;
  title: string;
  agency: string | null;
  segmentIds: string[];
  ownedChars: number;
  projectedInputChars: number;
}

export interface AggregateSplitManifest {
  schema: typeof AGGREGATE_SPLIT_MANIFEST_SCHEMA;
  caseId: string;
  parentGrantId: string;
  sourceRevisionSha256: string;
  inputSha256: string;
  model: string;
  promptVersions: {
    map: typeof AGGREGATE_SPLIT_MAP_PROMPT_VERSION;
    synthesis: typeof AGGREGATE_SPLIT_SYNTHESIS_PROMPT_VERSION;
  };
  segments: Array<Omit<AggregateSplitSegment, "text">>;
  sharedSegmentIds: string[];
  navigationSegmentIds: string[];
  programs: AggregateSplitProgram[];
  coverage: {
    inputChars: number;
    segmentCount: number;
    assignedSegmentCount: number;
    assignedChars: number;
    programChars: number;
    sharedChars: number;
    navigationChars: number;
  };
  execution: {
    mapPassCount: number;
    synthesisPassCount: 1;
    externalCallsMade: number;
    estimatedMaxCostUsd: number;
    actualCostUsd: number | null;
    usage: DeepAnalysisUsage | null;
  };
}

export interface AggregateSplitModelPass {
  phase: "map" | "synthesis";
  passId: string;
  inputChars: number;
  rawResponseText: string;
  rawToolInput: Record<string, unknown>;
  usage: DeepAnalysisUsage | null;
  costUsd: number | null;
  externalCallsMade: number;
}

interface MapAssignment {
  segmentId: string;
  disposition: "program" | "shared" | "navigation";
  provisionalProgramKey: string;
  programTitle: string;
  agency: string;
  confidence: number;
  reason: string;
}

interface MapModelResult {
  phase: "map";
  assignments: MapAssignment[];
  pass: AggregateSplitModelPass;
}

interface SynthesisMember {
  mapPassId: string;
  provisionalProgramKey: string;
}

interface SynthesisProgram {
  canonicalTitle: string;
  agency: string;
  members: SynthesisMember[];
}

interface SynthesisModelResult {
  phase: "synthesis";
  programs: SynthesisProgram[];
  pass: AggregateSplitModelPass;
}

export type AggregateSplitModelResult = MapModelResult | SynthesisModelResult;
export type AggregateSplitModelRunner = (input: {
  apiKey: string;
  model: string;
  phase: "map" | "synthesis";
  passId: string;
  inputText: string;
  fetchImpl?: typeof fetch;
}) => Promise<AggregateSplitModelResult>;

export interface BuildAggregateSplitManifestResult {
  manifest: AggregateSplitManifest;
  passes: AggregateSplitModelPass[];
}

/**
 * 서버가 만든 content-addressed segment만 모델이 분류하게 한다. 모델은 문자 offset이나
 * 원문을 새로 만들 수 없으며, 별도 validator가 전 segment의 정확한 1회 귀속을 검사한다.
 */
export async function buildAggregateSplitManifest(input: {
  caseId: string;
  seal: DeepAnalysisInputSeal;
  apiKey: string;
  model?: string;
  maxChildInputChars: number;
  maxCostUsd?: number;
  segmentChars?: number;
  mapInputChars?: number;
  runModel?: AggregateSplitModelRunner;
}): Promise<BuildAggregateSplitManifestResult> {
  assertSplittableSeal(input.seal);
  const model = input.model ?? DEEP_ANALYSIS_PRIMARY_MODELS[0];
  const maxCostUsd = input.maxCostUsd ?? DEFAULT_AGGREGATE_SPLIT_MAX_COST_USD;
  const segments = buildAggregateSplitSegments(
    input.seal,
    input.segmentChars ?? DEFAULT_AGGREGATE_SPLIT_SEGMENT_CHARS,
  );
  const batches = batchAggregateSplitSegments(
    segments,
    input.mapInputChars ?? DEFAULT_AGGREGATE_SPLIT_MAP_INPUT_CHARS,
  );
  const estimatedMaxCostUsd = estimateAggregateSplitMaxCostUsd({
    inputChars: input.seal.totalChars,
    segmentCount: segments.length,
    mapPassCount: batches.length,
  });
  if (estimatedMaxCostUsd > maxCostUsd) {
    throw new AggregateSplitManifestError(
      "aggregate_split_budget_exceeded",
      `분리 실행 최대 비용 추정 $${estimatedMaxCostUsd.toFixed(4)}가 상한 $${maxCostUsd.toFixed(4)}를 초과합니다.`,
      false,
    );
  }

  const runModel = input.runModel ?? runAggregateSplitModel;
  const mapResults: MapModelResult[] = [];
  let accumulatedCostUsd = 0;
  for (const [index, batch] of batches.entries()) {
    const passId = `map-${String(index + 1).padStart(3, "0")}`;
    const result = await runModel({
      apiKey: input.apiKey,
      model,
      phase: "map",
      passId,
      inputText: renderMapInput(batch),
    });
    if (result.phase !== "map") {
      throw new AggregateSplitManifestError(
        "aggregate_split_map_contract_invalid",
        `${passId}가 map 결과를 반환하지 않았습니다.`,
        true,
      );
    }
    validateMapAssignments(batch, result.assignments, passId);
    accumulatedCostUsd += result.pass.costUsd ?? 0;
    if (accumulatedCostUsd > maxCostUsd) {
      throw new AggregateSplitManifestError(
        "aggregate_split_actual_cost_exceeded",
        `분리 map 누적 비용 $${accumulatedCostUsd.toFixed(4)}가 상한 $${maxCostUsd.toFixed(4)}를 초과했습니다.`,
        false,
      );
    }
    mapResults.push(result);
  }

  const provisionalGroups = collectProvisionalGroups(mapResults);
  if (provisionalGroups.length < 2) {
    throw new AggregateSplitManifestError(
      "aggregate_split_program_count_invalid",
      `통합공고에서 서로 다른 하위사업 후보가 ${provisionalGroups.length}개만 확인됐습니다.`,
      true,
    );
  }
  const synthesis = await runModel({
    apiKey: input.apiKey,
    model,
    phase: "synthesis",
    passId: "synthesis-001",
    inputText: `${stableJson({
      schema: "aggregate-split-synthesis-input-v1",
      provisionalPrograms: provisionalGroups,
    })}\n`,
  });
  if (synthesis.phase !== "synthesis") {
    throw new AggregateSplitManifestError(
      "aggregate_split_synthesis_contract_invalid",
      "synthesis 결과가 올바른 phase를 반환하지 않았습니다.",
      true,
    );
  }
  accumulatedCostUsd += synthesis.pass.costUsd ?? 0;
  if (accumulatedCostUsd > maxCostUsd) {
    throw new AggregateSplitManifestError(
      "aggregate_split_actual_cost_exceeded",
      `분리 총 비용 $${accumulatedCostUsd.toFixed(4)}가 상한 $${maxCostUsd.toFixed(4)}를 초과했습니다.`,
      false,
    );
  }

  const passes = [...mapResults.map((result) => result.pass), synthesis.pass];
  const manifest = assembleAggregateSplitManifest({
    caseId: input.caseId,
    seal: input.seal,
    model,
    segments,
    mapResults,
    synthesis,
    maxChildInputChars: input.maxChildInputChars,
    estimatedMaxCostUsd,
    passes,
  });
  return { manifest, passes };
}

export function buildAggregateSplitSegments(
  seal: DeepAnalysisInputSeal,
  maxSegmentChars = DEFAULT_AGGREGATE_SPLIT_SEGMENT_CHARS,
): AggregateSplitSegment[] {
  if (
    !Number.isInteger(maxSegmentChars)
    || maxSegmentChars < 1_000
    || maxSegmentChars > 20_000
  ) {
    throw new Error("maxSegmentChars must be an integer between 1,000 and 20,000");
  }
  const sources = groupAndVerifyChunks(seal.chunks);
  const segments: AggregateSplitSegment[] = [];
  for (const source of sources) {
    let sourceStart = 0;
    while (sourceStart < source.text.length) {
      const sourceEnd = findSegmentEnd(source.text, sourceStart, maxSegmentChars);
      const text = source.text.slice(sourceStart, sourceEnd);
      const ordinal = segments.length;
      const sha256 = sha256Hex(text);
      segments.push({
        id: `seg-${String(ordinal + 1).padStart(5, "0")}-${sha256.slice(0, 12)}`,
        ordinal,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        startChar: sourceStart,
        endChar: sourceEnd,
        chars: text.length,
        sha256,
        text,
      });
      sourceStart = sourceEnd;
    }
  }
  if (segments.reduce((sum, segment) => sum + segment.chars, 0) !== seal.totalChars) {
    throw new Error("Aggregate split segment round-trip char count mismatch");
  }
  return segments;
}

export function estimateAggregateSplitMaxCostUsd(input: {
  inputChars: number;
  segmentCount: number;
  mapPassCount: number;
}): number {
  const conservativeInputTokens = input.inputChars + input.segmentCount * 1_000;
  const maxOutputTokens = input.mapPassCount * MAP_MAX_TOKENS + SYNTHESIS_MAX_TOKENS;
  return roundMoney(
    conservativeInputTokens * USD_PER_INPUT_TOKEN
    + maxOutputTokens * USD_PER_OUTPUT_TOKEN,
  );
}

export class AggregateSplitManifestError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly externalCallsMade = 0,
  ) {
    super(message);
    this.name = "AggregateSplitManifestError";
  }
}

export async function runAggregateSplitModel(input: {
  apiKey: string;
  model: string;
  phase: "map" | "synthesis";
  passId: string;
  inputText: string;
  fetchImpl?: typeof fetch;
}): Promise<AggregateSplitModelResult> {
  const toolName = input.phase === "map"
    ? "emit_aggregate_split_map"
    : "emit_aggregate_split_synthesis";
  const requestBody = JSON.stringify({
    model: input.model,
    max_tokens: input.phase === "map" ? MAP_MAX_TOKENS : SYNTHESIS_MAX_TOKENS,
    system: input.phase === "map" ? MAP_SYSTEM_PROMPT : SYNTHESIS_SYSTEM_PROMPT,
    messages: [{ role: "user", content: input.inputText }],
    tools: [input.phase === "map" ? MAP_TOOL_SCHEMA : SYNTHESIS_TOOL_SCHEMA],
    tool_choice: { type: "tool", name: toolName },
  });
  let externalCallsMade = 0;
  const attempt = async (): Promise<Response> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODEL_TIMEOUT_MS);
    try {
      externalCallsMade += 1;
      return await (input.fetchImpl ?? fetch)("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
        },
        signal: controller.signal,
        body: requestBody,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new AggregateSplitManifestError(
          "aggregate_split_model_timeout",
          `통합공고 분리 모델 호출이 ${MODEL_TIMEOUT_MS}ms 안에 끝나지 않았습니다.`,
          true,
          externalCallsMade,
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  };
  let response = await attempt();
  if (RETRYABLE_STATUSES.has(response.status)) {
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    response = await attempt();
  }
  const rawResponseText = await response.text();
  if (!response.ok) {
    throw new AggregateSplitManifestError(
      "aggregate_split_model_failed",
      `Anthropic aggregate split failed: ${response.status} ${response.statusText}\n${rawResponseText.slice(0, 1_000)}`,
      [429, 500, 529].includes(response.status),
      externalCallsMade,
    );
  }
  let payload: Record<string, unknown>;
  try {
    payload = parseRecordJson(rawResponseText, "Anthropic aggregate split response");
  } catch (error) {
    throw new AggregateSplitManifestError(
      "aggregate_split_model_contract_invalid",
      error instanceof Error ? error.message : String(error),
      true,
      externalCallsMade,
    );
  }
  const blocks = Array.isArray(payload.content) ? payload.content : [];
  const toolUse = blocks.find((block) => (
    isRecord(block)
    && block.type === "tool_use"
    && block.name === toolName
  ));
  if (!isRecord(toolUse) || !isRecord(toolUse.input)) {
    throw new AggregateSplitManifestError(
      "aggregate_split_model_contract_invalid",
      `${input.passId} 응답에 ${toolName} tool_use가 없습니다.`,
      true,
      externalCallsMade,
    );
  }
  const usage = normalizeUsage(payload.usage);
  const pass: AggregateSplitModelPass = {
    phase: input.phase,
    passId: input.passId,
    inputChars: input.inputText.length,
    rawResponseText,
    rawToolInput: toolUse.input,
    usage,
    costUsd: usage ? usageCostUsd(usage) : null,
    externalCallsMade,
  };
  if (input.phase === "map") {
    let assignments: MapAssignment[];
    try {
      assignments = normalizeMapAssignments(toolUse.input.assignments);
    } catch (error) {
      throw new AggregateSplitManifestError(
        "aggregate_split_model_contract_invalid",
        error instanceof Error ? error.message : String(error),
        true,
        externalCallsMade,
      );
    }
    return {
      phase: "map",
      assignments,
      pass,
    };
  }
  let programs: SynthesisProgram[];
  try {
    programs = normalizeSynthesisPrograms(toolUse.input.programs);
  } catch (error) {
    throw new AggregateSplitManifestError(
      "aggregate_split_model_contract_invalid",
      error instanceof Error ? error.message : String(error),
      true,
      externalCallsMade,
    );
  }
  return {
    phase: "synthesis",
    programs,
    pass,
  };
}

function assembleAggregateSplitManifest(input: {
  caseId: string;
  seal: DeepAnalysisInputSeal;
  model: string;
  segments: AggregateSplitSegment[];
  mapResults: MapModelResult[];
  synthesis: SynthesisModelResult;
  maxChildInputChars: number;
  estimatedMaxCostUsd: number;
  passes: AggregateSplitModelPass[];
}): AggregateSplitManifest {
  const assignmentBySegmentId = new Map<string, MapAssignment>();
  const segmentsByProvisionalRef = new Map<string, string[]>();
  for (const result of input.mapResults) {
    for (const assignment of result.assignments) {
      assignmentBySegmentId.set(assignment.segmentId, assignment);
      if (assignment.disposition === "program") {
        const ref = provisionalRef(result.pass.passId, assignment.provisionalProgramKey);
        segmentsByProvisionalRef.set(ref, [
          ...(segmentsByProvisionalRef.get(ref) ?? []),
          assignment.segmentId,
        ]);
      }
    }
  }

  validateSynthesisMembership(
    [...segmentsByProvisionalRef.keys()],
    input.synthesis.programs,
  );
  const segmentById = new Map(input.segments.map((segment) => [segment.id, segment]));
  const sharedSegmentIds = input.segments
    .filter((segment) => assignmentBySegmentId.get(segment.id)?.disposition === "shared")
    .map((segment) => segment.id);
  const navigationSegmentIds = input.segments
    .filter((segment) => assignmentBySegmentId.get(segment.id)?.disposition === "navigation")
    .map((segment) => segment.id);
  const sharedChars = sumSegmentChars(sharedSegmentIds, segmentById);
  const programs = input.synthesis.programs.map((program) => {
    const segmentIds = [...new Set(program.members.flatMap((member) => (
      segmentsByProvisionalRef.get(
        provisionalRef(member.mapPassId, member.provisionalProgramKey),
      ) ?? []
    )))].sort((left, right) => (
      requiredSegment(segmentById, left).ordinal
      - requiredSegment(segmentById, right).ordinal
    ));
    const ownedChars = sumSegmentChars(segmentIds, segmentById);
    return {
      stableKey: "",
      title: program.canonicalTitle.trim(),
      agency: program.agency.trim() || null,
      segmentIds,
      ownedChars,
      projectedInputChars: ownedChars + sharedChars,
    };
  }).sort((left, right) => (
    requiredSegment(segmentById, left.segmentIds[0]!).ordinal
    - requiredSegment(segmentById, right.segmentIds[0]!).ordinal
  )).map((program, index) => ({
    ...program,
    stableKey: `p${String(index + 1).padStart(3, "0")}-${sha256Hex([
      input.seal.sourceRevisionSha256,
      program.title,
      program.segmentIds[0],
    ].join("\u0000")).slice(0, 12)}`,
  }));
  if (programs.length < 2 || programs.length > 300) {
    throw new AggregateSplitManifestError(
      "aggregate_split_program_count_invalid",
      `최종 하위사업 수 ${programs.length}개는 허용 범위 2~300 밖입니다.`,
      true,
    );
  }
  const duplicateIdentity = findDuplicate(programs.map((program) => [
    normalizeTitle(program.title),
    normalizeTitle(program.agency ?? ""),
  ].join("\u0000")));
  if (duplicateIdentity) {
    throw new AggregateSplitManifestError(
      "aggregate_split_duplicate_program_title",
      "최종 하위사업 제목과 기관 조합이 중복됩니다.",
      true,
    );
  }
  const oversized = programs.find(
    (program) => program.projectedInputChars > input.maxChildInputChars,
  );
  if (oversized) {
    throw new AggregateSplitManifestError(
      "aggregate_split_child_cap_exceeded",
      `${oversized.title}의 예상 입력 ${oversized.projectedInputChars}자가 하위 공고 상한 ${input.maxChildInputChars}자를 초과합니다.`,
      true,
    );
  }

  const programChars = programs.reduce((sum, program) => sum + program.ownedChars, 0);
  const navigationChars = sumSegmentChars(navigationSegmentIds, segmentById);
  if (navigationChars > input.seal.totalChars * 0.4) {
    throw new AggregateSplitManifestError(
      "aggregate_split_navigation_ratio_invalid",
      `목차·탐색 분류가 전체 입력의 ${(
        navigationChars / input.seal.totalChars * 100
      ).toFixed(1)}%로 과도합니다.`,
      true,
    );
  }
  const assignedChars = programChars + sharedChars + navigationChars;
  if (
    assignmentBySegmentId.size !== input.segments.length
    || assignedChars !== input.seal.totalChars
  ) {
    throw new AggregateSplitManifestError(
      "aggregate_split_coverage_invalid",
      "하위사업 manifest가 원문 segment 전체를 정확히 한 번 분류하지 못했습니다.",
      true,
    );
  }
  const usage = sumUsage(input.passes.map((pass) => pass.usage));
  const presentCosts = input.passes
    .map((pass) => pass.costUsd)
    .filter((cost): cost is number => cost !== null);
  return {
    schema: AGGREGATE_SPLIT_MANIFEST_SCHEMA,
    caseId: input.caseId,
    parentGrantId: input.seal.grantId,
    sourceRevisionSha256: input.seal.sourceRevisionSha256,
    inputSha256: input.seal.inputSha256,
    model: input.model,
    promptVersions: {
      map: AGGREGATE_SPLIT_MAP_PROMPT_VERSION,
      synthesis: AGGREGATE_SPLIT_SYNTHESIS_PROMPT_VERSION,
    },
    segments: input.segments.map(({ text: _text, ...segment }) => segment),
    sharedSegmentIds,
    navigationSegmentIds,
    programs,
    coverage: {
      inputChars: input.seal.totalChars,
      segmentCount: input.segments.length,
      assignedSegmentCount: assignmentBySegmentId.size,
      assignedChars,
      programChars,
      sharedChars,
      navigationChars,
    },
    execution: {
      mapPassCount: input.mapResults.length,
      synthesisPassCount: 1,
      externalCallsMade: input.passes.reduce(
        (sum, pass) => sum + pass.externalCallsMade,
        0,
      ),
      estimatedMaxCostUsd: input.estimatedMaxCostUsd,
      actualCostUsd: presentCosts.length === 0
        ? null
        : roundMoney(presentCosts.reduce((sum, cost) => sum + cost, 0)),
      usage,
    },
  };
}

function validateMapAssignments(
  segments: AggregateSplitSegment[],
  assignments: MapAssignment[],
  passId: string,
): void {
  const expected = new Set(segments.map((segment) => segment.id));
  const seen = new Set<string>();
  for (const assignment of assignments) {
    if (!expected.has(assignment.segmentId) || seen.has(assignment.segmentId)) {
      throw new AggregateSplitManifestError(
        "aggregate_split_map_coverage_invalid",
        `${passId}의 segment 귀속이 누락 또는 중복됐습니다: ${assignment.segmentId}`,
        true,
      );
    }
    seen.add(assignment.segmentId);
    if (assignment.disposition === "program") {
      if (!assignment.provisionalProgramKey.trim() || !assignment.programTitle.trim()) {
        throw new AggregateSplitManifestError(
          "aggregate_split_map_program_invalid",
          `${passId}/${assignment.segmentId}의 하위사업 key/title이 비었습니다.`,
          true,
        );
      }
    } else if (assignment.provisionalProgramKey.trim() || assignment.programTitle.trim()) {
      throw new AggregateSplitManifestError(
        "aggregate_split_map_non_program_invalid",
        `${passId}/${assignment.segmentId}의 비사업 segment에 program 값이 있습니다.`,
        true,
      );
    }
  }
  if (seen.size !== expected.size) {
    const missing = [...expected].filter((segmentId) => !seen.has(segmentId));
    throw new AggregateSplitManifestError(
      "aggregate_split_map_coverage_invalid",
      `${passId}가 segment ${missing.slice(0, 5).join(", ")}를 분류하지 않았습니다.`,
      true,
    );
  }
}

function validateSynthesisMembership(
  expectedRefs: string[],
  programs: SynthesisProgram[],
): void {
  const expected = new Set(expectedRefs);
  const seen = new Set<string>();
  for (const program of programs) {
    if (!program.canonicalTitle.trim() || program.members.length === 0) {
      throw new AggregateSplitManifestError(
        "aggregate_split_synthesis_program_invalid",
        "synthesis 하위사업의 제목 또는 구성원이 비었습니다.",
        true,
      );
    }
    for (const member of program.members) {
      const ref = provisionalRef(member.mapPassId, member.provisionalProgramKey);
      if (!expected.has(ref) || seen.has(ref)) {
        throw new AggregateSplitManifestError(
          "aggregate_split_synthesis_coverage_invalid",
          `synthesis provisional ref가 누락·중복·위조됐습니다: ${ref}`,
          true,
        );
      }
      seen.add(ref);
    }
  }
  if (seen.size !== expected.size) {
    throw new AggregateSplitManifestError(
      "aggregate_split_synthesis_coverage_invalid",
      "synthesis가 모든 provisional program을 정확히 한 번 병합하지 못했습니다.",
      true,
    );
  }
}

function collectProvisionalGroups(mapResults: MapModelResult[]) {
  const groups = new Map<string, {
    mapPassId: string;
    provisionalProgramKey: string;
    observedTitles: string[];
    observedAgencies: string[];
    segmentIds: string[];
  }>();
  for (const result of mapResults) {
    for (const assignment of result.assignments) {
      if (assignment.disposition !== "program") continue;
      const ref = provisionalRef(result.pass.passId, assignment.provisionalProgramKey);
      const group = groups.get(ref) ?? {
        mapPassId: result.pass.passId,
        provisionalProgramKey: assignment.provisionalProgramKey,
        observedTitles: [],
        observedAgencies: [],
        segmentIds: [],
      };
      group.observedTitles.push(assignment.programTitle);
      if (assignment.agency.trim()) group.observedAgencies.push(assignment.agency);
      group.segmentIds.push(assignment.segmentId);
      groups.set(ref, group);
    }
  }
  return [...groups.values()];
}

function batchAggregateSplitSegments(
  segments: AggregateSplitSegment[],
  maxInputChars: number,
): AggregateSplitSegment[][] {
  if (!Number.isInteger(maxInputChars) || maxInputChars < 10_000 || maxInputChars > 140_000) {
    throw new Error("maxInputChars must be an integer between 10,000 and 140,000");
  }
  const batches: AggregateSplitSegment[][] = [];
  let current: AggregateSplitSegment[] = [];
  let chars = 0;
  for (const segment of segments) {
    const renderedChars = segment.text.length + 300;
    if (current.length > 0 && chars + renderedChars > maxInputChars) {
      batches.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += renderedChars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function renderMapInput(segments: AggregateSplitSegment[]): string {
  return segments.map((segment) => [
    `<<<AGGREGATE_SEGMENT id="${segment.id}" source_kind="${segment.sourceKind}" source_id="${segment.sourceId}" sha256="${segment.sha256}">>>`,
    segment.text,
    "<<<END_AGGREGATE_SEGMENT>>>",
  ].join("\n")).join("\n\n");
}

function groupAndVerifyChunks(chunks: DeepAnalysisInputChunk[]): Array<{
  sourceKind: DeepAnalysisInputChunk["sourceKind"];
  sourceId: string;
  text: string;
}> {
  const groups = new Map<string, DeepAnalysisInputChunk[]>();
  for (const chunk of chunks) {
    const key = `${chunk.sourceKind}\u0000${chunk.sourceId}`;
    groups.set(key, [...(groups.get(key) ?? []), chunk]);
  }
  return [...groups.values()].map((group) => {
    const ordered = group.sort((left, right) => left.index - right.index);
    let expectedStart = 0;
    for (const chunk of ordered) {
      if (
        chunk.startChar !== expectedStart
        || chunk.endChar !== chunk.startChar + chunk.text.length
        || chunk.sha256 !== sha256Hex(chunk.text)
      ) {
        throw new Error(`Invalid deep analysis chunk sequence: ${chunk.id}`);
      }
      expectedStart = chunk.endChar;
    }
    return {
      sourceKind: ordered[0]!.sourceKind,
      sourceId: ordered[0]!.sourceId,
      text: ordered.map((chunk) => chunk.text).join(""),
    };
  });
}

function findSegmentEnd(text: string, start: number, maxChars: number): number {
  const hardEnd = Math.min(text.length, start + maxChars);
  // Converted HWP/PDF booklets preserve page headings. A single page normally
  // represents one support program, while the old generic 6k boundary could
  // pack several pages/programs into one indivisible segment. Keep the marker
  // with the next segment and let synthesis merge a program that spans pages.
  const nextPageHeading = text.indexOf("\n## Page ", start + 1);
  if (nextPageHeading >= start && nextPageHeading < hardEnd) {
    return nextPageHeading + 1;
  }
  if (hardEnd === text.length) return hardEnd;
  const minPreferred = start + Math.floor(maxChars * 0.5);
  for (const delimiter of ["\f", "\n\n", "\n"]) {
    const position = text.lastIndexOf(delimiter, hardEnd - 1);
    if (position >= minPreferred) return position + delimiter.length;
  }
  return hardEnd;
}

function normalizeMapAssignments(value: unknown): MapAssignment[] {
  if (!Array.isArray(value)) return [];
  return value.map((row, index) => {
    if (!isRecord(row)) throw new Error(`assignments[${index}] must be an object`);
    const disposition = requiredEnum(
      row.disposition,
      ["program", "shared", "navigation"] as const,
      `assignments[${index}].disposition`,
    );
    // The tool schema keeps these string fields required so every assignment has
    // one stable shape. Models may still add descriptive labels such as "__toc__"
    // to navigation rows. Disposition is the ownership decision; canonicalize
    // non-program metadata away at the model adapter boundary while preserving
    // the untouched tool input in the raw evidence artifact.
    const isProgram = disposition === "program";
    return {
      segmentId: requiredString(row.segment_id, `assignments[${index}].segment_id`),
      disposition,
      provisionalProgramKey: isProgram ? stringOrEmpty(row.provisional_program_key) : "",
      programTitle: isProgram ? stringOrEmpty(row.program_title) : "",
      agency: stringOrEmpty(row.agency),
      confidence: boundedNumber(row.confidence, `assignments[${index}].confidence`),
      reason: requiredString(row.reason, `assignments[${index}].reason`),
    };
  });
}

function normalizeSynthesisPrograms(value: unknown): SynthesisProgram[] {
  if (!Array.isArray(value)) return [];
  return value.map((row, index) => {
    if (!isRecord(row) || !Array.isArray(row.members)) {
      throw new Error(`programs[${index}] must contain members`);
    }
    return {
      canonicalTitle: requiredString(row.canonical_title, `programs[${index}].canonical_title`),
      agency: stringOrEmpty(row.agency),
      members: row.members.map((member, memberIndex) => {
        if (!isRecord(member)) {
          throw new Error(`programs[${index}].members[${memberIndex}] must be an object`);
        }
        return {
          mapPassId: requiredString(
            member.map_pass_id,
            `programs[${index}].members[${memberIndex}].map_pass_id`,
          ),
          provisionalProgramKey: requiredString(
            member.provisional_program_key,
            `programs[${index}].members[${memberIndex}].provisional_program_key`,
          ),
        };
      }),
    };
  });
}

function assertSplittableSeal(seal: DeepAnalysisInputSeal): void {
  const blockerCodes = [...new Set(seal.blockers.map((blocker) => blocker.code))];
  if (seal.sealed || blockerCodes.length !== 1 || blockerCodes[0] !== "blocked_cap") {
    throw new AggregateSplitManifestError(
      "aggregate_split_input_not_eligible",
      `분리 입력은 blocked_cap만 있어야 합니다: ${blockerCodes.join(",") || "none"}`,
      false,
    );
  }
}

function normalizeUsage(value: unknown): DeepAnalysisUsage | null {
  if (!isRecord(value)) return null;
  const inputTokens = nonnegativeInteger(value.input_tokens);
  const outputTokens = nonnegativeInteger(value.output_tokens);
  if (inputTokens === null || outputTokens === null) return null;
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens: nonnegativeInteger(
      value.cache_read_input_tokens ?? value.cache_read_tokens,
    ),
  };
}

function sumUsage(values: Array<DeepAnalysisUsage | null>): DeepAnalysisUsage | null {
  const present = values.filter((value): value is DeepAnalysisUsage => value !== null);
  if (present.length === 0) return null;
  return {
    inputTokens: present.reduce((sum, value) => sum + value.inputTokens, 0),
    outputTokens: present.reduce((sum, value) => sum + value.outputTokens, 0),
    cacheReadTokens: present.every((value) => value.cacheReadTokens === null)
      ? null
      : present.reduce((sum, value) => sum + (value.cacheReadTokens ?? 0), 0),
  };
}

function usageCostUsd(usage: DeepAnalysisUsage): number {
  return roundMoney(
    usage.inputTokens * USD_PER_INPUT_TOKEN
    + usage.outputTokens * USD_PER_OUTPUT_TOKEN
    + (usage.cacheReadTokens ?? 0) * USD_PER_CACHE_READ_TOKEN,
  );
}

function provisionalRef(mapPassId: string, provisionalProgramKey: string): string {
  return `${mapPassId}\u0000${provisionalProgramKey}`;
}

function sumSegmentChars(
  segmentIds: string[],
  segments: Map<string, AggregateSplitSegment>,
): number {
  return segmentIds.reduce(
    (sum, segmentId) => sum + requiredSegment(segments, segmentId).chars,
    0,
  );
}

function requiredSegment(
  segments: Map<string, AggregateSplitSegment>,
  segmentId: string,
): AggregateSplitSegment {
  const segment = segments.get(segmentId);
  if (!segment) throw new Error(`Unknown aggregate split segment: ${segmentId}`);
  return segment;
}

function normalizeTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLocaleLowerCase("ko-KR");
}

function findDuplicate(values: string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return null;
}

function parseRecordJson(value: string, label: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  if (!isRecord(parsed)) throw new Error(`${label} must be a JSON object`);
  return parsed;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundedNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1`);
  }
  return value;
}

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  label: string,
): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${label} must be one of ${values.join(",")}`);
  }
  return value as T[number];
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

const MAP_SYSTEM_PROMPT = [
  "너는 대용량 통합공고를 하위사업 단위로 분리하는 분석기다.",
  "입력의 각 AGGREGATE_SEGMENT를 정확히 한 번 분류하라.",
  "실제 신청 대상·조건·지원 내용이 있는 하위사업 본문은 program, 여러 사업에 공통 적용되는 안내는 shared, 목차·색인·단순 탐색 안내는 navigation이다.",
  "segment를 자르거나 합성하지 말고 제공된 segment_id만 반환하라.",
  "같은 하위사업 segment에는 이 pass 안에서 같은 provisional_program_key를 사용하라.",
  "shared와 navigation이면 provisional_program_key와 program_title은 빈 문자열로 반환하라.",
  "불확실하다는 이유로 program 본문을 shared나 navigation으로 숨기지 마라.",
].join(" ");

const SYNTHESIS_SYSTEM_PROMPT = [
  "너는 chunk별 통합공고 분리 결과의 동일 하위사업을 병합하는 분석기다.",
  "모든 provisional program ref를 정확히 한 번만 최종 program에 포함하라.",
  "서로 다른 하위사업을 합치지 말고, 같은 하위사업이 map pass 경계에서 나뉜 경우만 병합하라.",
  "입력에 없는 하위사업이나 ref를 만들지 마라.",
].join(" ");

const MAP_TOOL_SCHEMA = {
  name: "emit_aggregate_split_map",
  description: "각 원문 segment의 하위사업 귀속을 반환한다.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      assignments: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            segment_id: { type: "string" },
            disposition: { type: "string", enum: ["program", "shared", "navigation"] },
            provisional_program_key: {
              type: "string",
              description: "program이면 pass 내부 안정 key, shared/navigation이면 빈 문자열",
            },
            program_title: {
              type: "string",
              description: "program이면 하위사업 제목, shared/navigation이면 빈 문자열",
            },
            agency: { type: "string" },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            reason: { type: "string" },
          },
          required: [
            "segment_id",
            "disposition",
            "provisional_program_key",
            "program_title",
            "agency",
            "confidence",
            "reason",
          ],
        },
      },
    },
    required: ["assignments"],
  },
} as const;

const SYNTHESIS_TOOL_SCHEMA = {
  name: "emit_aggregate_split_synthesis",
  description: "provisional program을 최종 하위사업으로 병합한다.",
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      programs: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            canonical_title: { type: "string" },
            agency: { type: "string" },
            members: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  map_pass_id: { type: "string" },
                  provisional_program_key: { type: "string" },
                },
                required: ["map_pass_id", "provisional_program_key"],
              },
            },
          },
          required: ["canonical_title", "agency", "members"],
        },
      },
    },
    required: ["programs"],
  },
} as const;
