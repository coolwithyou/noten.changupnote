import assert from "node:assert/strict";
import type { IRBlock } from "kordoc";
import {
  applyContextualEdits,
  extractContextualRoundtripFields,
  prepareContextualEdits,
} from "./editable-regions";
import { planRoundtripFields } from "./field-planner";

const blocks: IRBlock[] = [
  {
    type: "table",
    pageNumber: 1,
    table: {
      rows: 7,
      cols: 4,
      hasHeader: true,
      cells: [
        row("사업자 구분", "□ 개인  □ 법인  □ 공동대표", "", ""),
        row("산업분야", "□ 자동차  □ 조선\n□ AI  □ 기타(  )", "업종", "자동차용 신품 제동장치 제조업 (C30392)\n[참고] 분류표 참조"),
        row("관련기술현황", "특허출원", "특허등록", "대표특허명"),
        row("", "※1건 이상 보유시 ○ 표시", "※1건 이상 보유시 ○ 표시", ""),
        row("재무현황", "2023년", "2024년", "2025년"),
        row("매출액", "(천원)", "(천원)", "(천원)"),
        row("종업원수", "(명)", "(명)", "(명)"),
      ],
    },
  },
  { type: "heading", text: "1. 사업 참여 목적 및 지원 필요성", pageNumber: 2 },
  {
    type: "paragraph",
    text: "- (기술·제품 소개) 핵심 기술과 제품의 차별성 제시\n- (정량 지표) 측정 가능한 목표 제시",
    pageNumber: 2,
  },
];

const fields = extractContextualRoundtripFields(blocks, "a".repeat(64));
assert.equal(fields.filter((field) => field.writeOperation === "toggle_text_choice").length, 2);
assert.equal(fields.filter((field) => field.writeOperation === "insert_before_unit").length, 6);
assert.equal(fields.filter((field) => field.writeOperation === "replace_instruction").length, 2);
assert.equal(fields.filter((field) => field.writeOperation === "replace_span").length, 3);

const businessType = requiredField("사업자 구분");
assert.equal(businessType.inputKind, "single_choice");
const revenue2024 = requiredField("매출액 · 2024년");
assert.equal(revenue2024.unit, "천원");
const patentApplication = requiredField("특허출원 보유 여부");
const industryCode = requiredField("업종");
const narrative = requiredField("기술·제품 소개");

const fieldChoices = {
  [businessType.fieldInstanceId]: [businessType.options[1]!.optionId],
  [patentApplication.fieldInstanceId]: [patentApplication.options[0]!.optionId],
};
const values = {
  [revenue2024.fieldInstanceId]: "123456",
  [industryCode.fieldInstanceId]: "응용 소프트웨어 개발 및 공급업 (J58222)",
  [narrative.fieldInstanceId]: "AI 문서 자동화 기술의 구조 보존 성능을 차별점으로 제시합니다.",
};
const edits = prepareContextualEdits(fields, values, fieldChoices);
assert.equal(edits.length, 5);
const edited = structuredClone(blocks);
applyContextualEdits(edited, edits);

const editedTable = edited[0]!.table!;
assert.match(editedTable.cells[0]![1]!.text, /□ 개인\s+☑ 법인/);
assert.equal(editedTable.cells[3]![1]!.text, "○");
assert.equal(editedTable.cells[5]![2]!.text, "123456 (천원)");
assert.match(editedTable.cells[1]![3]!.text, /^응용 소프트웨어 개발 및 공급업 \(J58222\)/);
assert.match(editedTable.cells[1]![3]!.text, /\[참고\] 분류표 참조$/);
assert.match(edited[2]!.text!, /^AI 문서 자동화 기술/);
assert.match(edited[2]!.text!, /\(정량 지표\)/);

let explicitRequestModel: string | null = null;
const usageEvents: Array<{
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}> = [];
const planned = await planRoundtripFields({
  fields: [revenue2024],
  markdown: "매출액 2024년 (천원)",
  apiKey: "test-key",
  model: "claude-opus-5",
  timeoutMs: 900_000,
  transport: "claude-cli",
  candidateConcurrency: 1,
  parentLabRunId: "run-parent-test",
  onUsage: (usage) => { usageEvents.push(usage); },
  fetchImpl: async (_input, init) => {
    explicitRequestModel = (JSON.parse(String(init?.body)) as { model: string }).model;
    return new Response(JSON.stringify({
      stop_reason: "tool_use",
      usage: { input_tokens: 1_000, output_tokens: 100, cache_read_input_tokens: 0 },
      content: [{
        type: "tool_use",
        name: "emit_application_field_plan",
        input: {
          decisions: [{
            candidate_id: revenue2024.fieldInstanceId,
            is_user_input: true,
            suggested_label: "2024년 매출액",
            input_kind: "number",
            confidence: 0.99,
            help_text: "2024년 매출액을 천원 단위로 입력",
            evidence: "매출액 2024년 (천원)",
          }],
        },
      }],
    }), { status: 200 });
  },
});
assert.equal(planned.summary.status, "llm");
assert.equal(planned.fields[0]!.analysisSource, "llm");
assert.equal(planned.fields[0]!.inputKind, "number");
assert.equal(planned.fields[0]!.helperText, "2024년 매출액을 천원 단위로 입력");
assert.equal(explicitRequestModel, "claude-opus-5");
assert.equal(planned.summary.transport, "claude-cli");
assert.equal(planned.summary.requestedModel, "claude-opus-5");
assert.equal(planned.summary.timeoutMs, 900_000);
assert.equal(planned.summary.candidateConcurrency, 1);
assert.equal(planned.summary.parentLabRunId, "run-parent-test");
assert.equal(planned.summary.failureCode, null);
assert.equal(planned.summary.requestCount, 1);
assert.equal(planned.summary.inputTokens, 1_000);
assert.equal(planned.summary.outputTokens, 100);
assert.equal(planned.summary.costUsd, 0.0075);
assert.equal(usageEvents.length, 1);
assert.equal(usageEvents[0]?.requestCount, 1);
assert.equal(usageEvents[0]?.inputTokens, 1_000);
assert.equal(usageEvents[0]?.outputTokens, 100);
assert.equal(usageEvents[0]?.costUsd, 0.0075);

const manyFields = Array.from({ length: 45 }, (_, index) => plannerField(revenue2024, index));

const bounded = fakePlannerFetch(8);
const boundedPlan = await planRoundtripFields({
  fields: manyFields,
  markdown: "매출액 입력 후보 45건",
  apiKey: "subscription",
  model: "claude-opus-5",
  timeoutMs: 900_000,
  transport: "claude-cli",
  candidateConcurrency: 2,
  parentLabRunId: "run-bounded",
  fetchImpl: bounded.fetchImpl,
});
assert.equal(boundedPlan.summary.status, "llm");
assert.equal(bounded.calls(), 3, "45개 후보는 20개 단위 3회 요청");
assert.equal(bounded.maxActive(), 2, "explicit 후보 chunk 동시성 상한 준수");
assert.deepEqual(bounded.models(), ["claude-opus-5", "claude-opus-5", "claude-opus-5"]);
assert.equal(boundedPlan.summary.candidateConcurrency, 2);
assert.equal(boundedPlan.summary.requestCount, 3);
assert.equal(boundedPlan.summary.inputTokens, 300);
assert.equal(boundedPlan.summary.outputTokens, 60);
assert.equal(boundedPlan.summary.costUsd, 0.003);

const subscriptionDefault = fakePlannerFetch(4);
const subscriptionDefaultPlan = await planRoundtripFields({
  fields: manyFields,
  markdown: "구독 기본 동시성",
  apiKey: "subscription",
  model: "claude-opus-5",
  transport: "claude-cli",
  fetchImpl: subscriptionDefault.fetchImpl,
});
assert.equal(subscriptionDefaultPlan.summary.status, "llm");
assert.equal(subscriptionDefault.maxActive(), 1, "구독 transport 기본 chunk 동시성은 1");
assert.equal(subscriptionDefaultPlan.summary.candidateConcurrency, 1);

const apiDefault = fakePlannerFetch(8);
const apiDefaultPlan = await planRoundtripFields({
  fields: manyFields,
  markdown: "API 기존 병렬 호환",
  apiKey: "test-key",
  model: "claude-sonnet-5",
  transport: "api",
  fetchImpl: apiDefault.fetchImpl,
});
assert.equal(apiDefaultPlan.summary.status, "llm");
assert.equal(apiDefault.maxActive(), 3, "API는 기존처럼 문서의 모든 chunk를 병렬 처리");

const heuristicWithoutKey = await planRoundtripFields({
  fields: [revenue2024],
  markdown: "키 없는 기존 heuristic 경로",
  apiKey: null,
  model: "claude-sonnet-5",
});
assert.equal(heuristicWithoutKey.summary.status, "heuristic_fallback");
assert.equal(heuristicWithoutKey.summary.transport, "api");
assert.equal(heuristicWithoutKey.summary.model, null);
assert.equal(heuristicWithoutKey.summary.failureCode, "api_key_missing");

let globalFetchCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = (async () => {
  globalFetchCalls += 1;
  throw new Error("global fetch must not be called");
}) as typeof fetch;
try {
  const missingTransport = await planRoundtripFields({
    fields: [revenue2024],
    markdown: "구독 fetch 미주입",
    apiKey: "subscription",
    model: "claude-opus-5",
    transport: "claude-cli",
  });
  assert.equal(missingTransport.summary.status, "heuristic_fallback");
  assert.equal(missingTransport.summary.failureCode, "transport_not_configured");
  assert.equal(globalFetchCalls, 0, "구독 fetch 미주입 시 API 자동 폴백 금지");
} finally {
  globalThis.fetch = originalFetch;
}

const windowExhausted = await planRoundtripFields({
  fields: [revenue2024],
  markdown: "구독 윈도 소진",
  apiKey: "subscription",
  model: "claude-opus-5",
  transport: "claude-cli",
  fetchImpl: async () => new Response(
    "Claude Max 사용량 윈도 소진 [CLAUDE_CLI_WINDOW_EXHAUSTED]",
    { status: 400 },
  ),
});
assert.equal(windowExhausted.summary.status, "heuristic_fallback");
assert.equal(windowExhausted.summary.failureCode, "window_exhausted");

const timedOut = await planRoundtripFields({
  fields: [revenue2024],
  markdown: "타임아웃",
  apiKey: "subscription",
  model: "claude-opus-5",
  timeoutMs: 5,
  transport: "claude-cli",
  fetchImpl: abortingFetch(),
});
assert.equal(timedOut.summary.status, "heuristic_fallback");
assert.equal(timedOut.summary.failureCode, "request_timeout");
assert.match(timedOut.summary.warning ?? "", /5ms/);

console.log("application-roundtrip editable region tests: ok");

function row(...texts: string[]) {
  return texts.map((text) => ({ text, colSpan: 1, rowSpan: 1 }));
}

function requiredField(labelIncludes: string) {
  const field = fields.find((candidate) => candidate.label.includes(labelIncludes));
  assert.ok(field, `field not found: ${labelIncludes}`);
  return field;
}

function plannerField(base: ReturnType<typeof requiredField>, index: number) {
  return {
    ...base,
    fieldInstanceId: `planner-${index}`,
    label: `입력 후보 ${index}`,
    displayLabel: `입력 후보 ${index}`,
    normalizedLabel: `입력후보${index}`,
    inputSignals: [...base.inputSignals],
    options: base.options.map((option) => ({ ...option })),
    location: base.location.target
      ? { ...base.location, target: { ...base.location.target }, occurrence: index }
      : { ...base.location, occurrence: index },
  };
}

function fakePlannerFetch(delayMs: number): {
  fetchImpl: typeof fetch;
  calls: () => number;
  maxActive: () => number;
  models: () => string[];
} {
  let callCount = 0;
  let active = 0;
  let peak = 0;
  const requestedModels: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1;
    active += 1;
    peak = Math.max(peak, active);
    const request = JSON.parse(String(init?.body)) as {
      model: string;
      messages: Array<{ content: string }>;
    };
    requestedModels.push(request.model);
    const content = request.messages[0]?.content ?? "";
    const candidates = JSON.parse(content.slice(content.indexOf("\n") + 1)) as Array<{
      candidate_id: string;
      proposed_label: string;
    }>;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    return new Response(JSON.stringify({
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
      content: [{
        type: "tool_use",
        name: "emit_application_field_plan",
        input: {
          decisions: candidates.map((candidate) => ({
            candidate_id: candidate.candidate_id,
            is_user_input: true,
            suggested_label: candidate.proposed_label,
            input_kind: "text",
            confidence: 0.9,
            help_text: "테스트 입력",
            evidence: candidate.proposed_label,
          })),
        },
      }],
    }), { status: 200 });
  }) as typeof fetch;
  return {
    fetchImpl,
    calls: () => callCount,
    maxActive: () => peak,
    models: () => requestedModels,
  };
}

function abortingFetch(): typeof fetch {
  return ((_: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    const abort = () => {
      const error = new Error("The operation was aborted");
      error.name = "AbortError";
      reject(error);
    };
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
  })) as typeof fetch;
}
