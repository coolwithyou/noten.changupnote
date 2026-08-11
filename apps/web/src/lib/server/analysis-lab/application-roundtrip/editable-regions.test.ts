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

const relocationPledgeText = [
  "경기 권역 내 주소지 이전 확약서",
  "1. 기업정보",
  "회사명",
  "사업자등록번호",
  "현주소 (본점)",
  "대표자 이름 / (인 또는 서명)",
  "당사는 협약일로부터 1개월 이내에 사업장을 다음과 같이 이전 또는 신규등록 할 것을 확약합니다.",
  "2. 이전/신규등록 정보",
  "종류 / □ 본사 □ 지점 □ 연구소 □ 공장",
  "등록 형태 / □ 신규설립    □ 이전",
  "이전예정지역 / ※ 기초자치단체 단위까지 기재 예: 경기도 00구, 00군",
  "20  년    월    일",
  "기 업 명 :",
  "대    표 :                   (인)",
].join("\n");
const relocationBlocks: IRBlock[] = [{
  type: "table",
  pageNumber: 8,
  table: {
    rows: 1,
    cols: 1,
    hasHeader: false,
    cells: [row(relocationPledgeText)],
  },
}];
const relocationFields = extractContextualRoundtripFields(relocationBlocks, "b".repeat(64));
assert.equal(relocationFields.length, 10, "접힌 확약서를 10개 실제 입력 위치로 분해");
assert.equal(relocationFields.filter((field) => field.writeOperation === "insert_after_label").length, 7);
assert.equal(relocationFields.filter((field) => field.writeOperation === "toggle_text_choice").length, 2);
assert.equal(relocationFields.filter((field) => field.writeOperation === "replace_span").length, 1);
assert.ok(relocationFields.every((field) => field.location.target?.expectedText.length && field.location.target.textEnd <= relocationPledgeText.length));

const relocationField = (label: string) => {
  const field = relocationFields.find((candidate) => candidate.label === label);
  assert.ok(field, `relocation field not found: ${label}`);
  return field;
};
const siteType = relocationField("사업장 종류");
const registrationType = relocationField("등록 형태");
const relocationEdits = prepareContextualEdits(relocationFields, {
  [relocationField("회사명").fieldInstanceId]: "주식회사 창업노트",
  [relocationField("사업자등록번호").fieldInstanceId]: "000-00-00000",
  [relocationField("현주소 (본점)").fieldInstanceId]: "서울특별시 강남구 테헤란로 1",
  [relocationField("대표자 이름").fieldInstanceId]: "홍길동",
  [relocationField("이전 예정 지역").fieldInstanceId]: "경기도 성남시",
  [relocationField("확약일자").fieldInstanceId]: "2026년 8월 9일",
  [relocationField("기업명 (서명)").fieldInstanceId]: "주식회사 창업노트",
  [relocationField("대표자 (서명)").fieldInstanceId]: "홍길동",
}, {
  [siteType.fieldInstanceId]: [siteType.options[0]!.optionId],
  [registrationType.fieldInstanceId]: [registrationType.options[1]!.optionId],
});
assert.equal(relocationEdits.length, 10);
const editedRelocation = structuredClone(relocationBlocks);
applyContextualEdits(editedRelocation, relocationEdits);
const editedRelocationText = editedRelocation[0]!.table!.cells[0]![0]!.text;
assert.match(editedRelocationText, /회사명 주식회사 창업노트\n사업자등록번호 000-00-00000/);
assert.match(editedRelocationText, /현주소 \(본점\) 서울특별시 강남구 테헤란로 1/);
assert.match(editedRelocationText, /대표자 이름 \/ 홍길동 \(인 또는 서명\)/);
assert.match(editedRelocationText, /종류 \/ ☑ 본사 □ 지점 □ 연구소 □ 공장/);
assert.match(editedRelocationText, /등록 형태 \/ □ 신규설립\s+☑ 이전/);
assert.match(editedRelocationText, /이전예정지역 \/ 경기도 성남시 ※ 기초자치단체/);
assert.match(editedRelocationText, /2026년 8월 9일/);
assert.match(editedRelocationText, /기 업 명 : 주식회사 창업노트/);
assert.match(editedRelocationText, /대    표 : 홍길동\s+\(인\)/);

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
assert.equal(bounded.calls(), 2, "45개 후보는 구독 경로 40개 단위 2회 요청");
assert.equal(bounded.maxActive(), 2, "explicit 후보 chunk 동시성 상한 준수");
assert.deepEqual(bounded.models(), ["claude-opus-5", "claude-opus-5"]);
assert.equal(boundedPlan.summary.candidateConcurrency, 2);
assert.equal(boundedPlan.summary.candidateBatchSize, 40);
assert.equal(boundedPlan.summary.requestCount, 2);
assert.equal(boundedPlan.summary.inputTokens, 200);
assert.equal(boundedPlan.summary.outputTokens, 40);
assert.equal(boundedPlan.summary.costUsd, 0.002);

const missingInLargeBatch = missingDecisionPlannerFetch();
const recoveredLargeBatch = await planRoundtripFields({
  fields: manyFields,
  markdown: "40개 묶음 누락 후보 자동 복구",
  apiKey: "subscription",
  model: "claude-opus-5",
  transport: "claude-cli",
  candidateConcurrency: 2,
  fetchImpl: missingInLargeBatch.fetchImpl,
});
assert.equal(missingInLargeBatch.calls(), 3, "최초 2묶음 + 누락 후보만 1차 재판정");
assert.deepEqual(missingInLargeBatch.initialBatchSizes().sort((a, b) => a - b), [5, 40]);
assert.equal(recoveredLargeBatch.summary.adjudicationRounds, 1);
assert.equal(recoveredLargeBatch.summary.adjudicatedCandidateCount, 2);
assert.equal(recoveredLargeBatch.summary.processedCandidateCount, 45);
assert.equal(recoveredLargeBatch.summary.remainingUnresolvedCandidateCount, 0, "큰 묶음 누락을 품질 하락으로 숨기지 않음");

const originalCliMaxConcurrency = process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY;
process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY = "4";
const subscriptionDefault = fakePlannerFetch(4);
let subscriptionDefaultPlan: Awaited<ReturnType<typeof planRoundtripFields>>;
try {
  subscriptionDefaultPlan = await planRoundtripFields({
    fields: manyFields,
    markdown: "구독 기본 동시성",
    apiKey: "subscription",
    model: "claude-opus-5",
    transport: "claude-cli",
    fetchImpl: subscriptionDefault.fetchImpl,
  });
} finally {
  if (originalCliMaxConcurrency === undefined) {
    delete process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY;
  } else {
    process.env.ANALYSIS_LAB_CLAUDE_CLI_MAX_CONCURRENCY = originalCliMaxConcurrency;
  }
}
assert.equal(subscriptionDefaultPlan.summary.status, "llm");
assert.equal(subscriptionDefault.maxActive(), 2, "45개 후보의 2개 chunk를 모두 병렬 실행");
assert.equal(subscriptionDefaultPlan.summary.candidateConcurrency, 2, "구독 Kordoc 기본 동시성은 primary 슬롯을 위해 2-way로 제한");

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
assert.equal(apiDefault.maxActive(), 3, "API는 기존 20개 묶음과 모든 chunk 병렬 처리를 보존");
assert.equal(apiDefaultPlan.summary.candidateBatchSize, 20);

const overLegacyLimit = Array.from({ length: 205 }, (_, index) => plannerField(revenue2024, index));
const subscriptionSerial = fakePlannerFetch(8);
const subscriptionSerialPlan = await planRoundtripFields({
  fields: overLegacyLimit,
  markdown: "구독 전체 후보 직렬 처리",
  apiKey: "subscription",
  model: "claude-opus-5",
  transport: "claude-cli",
  candidateConcurrency: 1,
  fetchImpl: subscriptionSerial.fetchImpl,
});
const subscriptionAll = fakePlannerFetch(8);
const subscriptionAllPlan = await planRoundtripFields({
  fields: overLegacyLimit,
  markdown: "구독 전체 후보 처리",
  apiKey: "subscription",
  model: "claude-opus-5",
  transport: "claude-cli",
  candidateConcurrency: 4,
  fetchImpl: subscriptionAll.fetchImpl,
});
assert.equal(subscriptionSerial.calls(), 6);
assert.equal(subscriptionSerial.maxActive(), 1);
assert.equal(subscriptionAll.calls(), 6, "구독 경로는 180개 상한 뒤의 후보도 40개씩 모두 처리");
assert.equal(subscriptionAll.maxActive(), 4, "마지막 heavy notice는 후보 chunk에서 CLI 4슬롯을 활용");
assert.equal(subscriptionSerialPlan.summary.requestCount, subscriptionAllPlan.summary.requestCount, "1대4 호출 수 불변");
assert.deepEqual(subscriptionSerialPlan.fields, subscriptionAllPlan.fields, "1대4 결과 계약 불변");
assert.equal(subscriptionAllPlan.summary.candidateLimit, null);
assert.equal(subscriptionAllPlan.summary.processedCandidateCount, 205);
assert.equal(subscriptionAllPlan.summary.unprocessedCandidateCount, 0);

const apiBounded = fakePlannerFetch(0);
const apiBoundedPlan = await planRoundtripFields({
  fields: overLegacyLimit,
  markdown: "API 비용 상한 보존",
  apiKey: "test-key",
  model: "claude-sonnet-5",
  transport: "api",
  fetchImpl: apiBounded.fetchImpl,
});
assert.equal(apiBounded.calls(), 9, "API 경로는 180개 상한을 유지");
assert.equal(apiBoundedPlan.summary.candidateLimit, 180);
assert.equal(apiBoundedPlan.summary.processedCandidateCount, 180);
assert.equal(apiBoundedPlan.summary.unprocessedCandidateCount, 25);
assert.equal(apiBoundedPlan.summary.remainingUnresolvedCandidateCount, 25);

const feedbackSerial = feedbackPlannerFetch();
const feedbackSerialPlan = await planRoundtripFields({
  fields: overLegacyLimit.slice(0, 2),
  markdown: "최초 누락과 저신뢰 후보를 직렬 재판정",
  apiKey: "subscription",
  model: "claude-opus-5",
  transport: "claude-cli",
  candidateConcurrency: 1,
  fetchImpl: feedbackSerial.fetchImpl,
});
const feedback = feedbackPlannerFetch();
const feedbackPlan = await planRoundtripFields({
  fields: overLegacyLimit.slice(0, 2),
  markdown: "최초 누락과 저신뢰 후보를 재판정",
  apiKey: "subscription",
  model: "claude-opus-5",
  transport: "claude-cli",
  candidateConcurrency: 4,
  fetchImpl: feedback.fetchImpl,
});
assert.equal(feedbackSerial.calls(), 3);
assert.deepEqual(feedbackSerial.batchSizes(), [2, 2, 1]);
assert.equal(feedback.calls(), 3, "최초 판정 뒤 필요한 후보만 최대 2회 재판정");
assert.deepEqual(feedback.batchSizes(), [2, 2, 1]);
assert.equal(feedbackSerialPlan.summary.requestCount, feedbackPlan.summary.requestCount, "재판정 포함 1대4 호출 수 불변");
assert.equal(feedbackSerialPlan.summary.adjudicationRounds, feedbackPlan.summary.adjudicationRounds, "최대 2회 재판정 불변");
assert.deepEqual(feedbackSerialPlan.fields, feedbackPlan.fields, "저신뢰 0.75 재판정 결과도 1대4 불변");
assert.equal(feedbackPlan.summary.adjudicationStatus, "resolved");
assert.equal(feedbackPlan.summary.adjudicationRounds, 2);
assert.equal(feedbackPlan.summary.adjudicatedCandidateCount, 2);
assert.equal(feedbackPlan.summary.remainingUnresolvedCandidateCount, 0);
assert.equal(feedbackPlan.summary.requestCount, 3);
assert.equal(feedbackPlan.fields[0]?.llmDecision, "not_input");
assert.equal(feedbackPlan.fields[0]?.llmDecisionRound, 1);
assert.equal(
  feedbackPlan.fields[0]?.recommendedInput,
  false,
  "최초 저신뢰 입력 판정은 즉시 채택하지 않고 재판정에서 false positive를 제거",
);
assert.equal(feedbackPlan.fields[1]?.llmDecision, "input");
assert.equal(feedbackPlan.fields[1]?.llmDecisionRound, 2);
assert.match(feedbackPlan.fields[1]?.inputSignals.join(" ") ?? "", /2차 재판정/);

const uncertain = alwaysUncertainPlannerFetch();
const uncertainPlan = await planRoundtripFields({
  fields: overLegacyLimit.slice(0, 1),
  markdown: "원문만으로 확정 불가능한 후보",
  apiKey: "subscription",
  model: "claude-opus-5",
  transport: "claude-cli",
  fetchImpl: uncertain.fetchImpl,
});
assert.equal(uncertain.calls(), 3, "최초 1회와 재판정 최대 2회 뒤 종료");
assert.equal(uncertainPlan.summary.adjudicationStatus, "partial");
assert.equal(uncertainPlan.summary.remainingUnresolvedCandidateCount, 1);
assert.equal(uncertainPlan.fields[0]?.llmDecision, "uncertain");
assert.equal(uncertainPlan.fields[0]?.recommendedInput, false, "모호한 후보를 억지로 입력 필드로 승격하지 않음");

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

function missingDecisionPlannerFetch(): {
  fetchImpl: typeof fetch;
  calls: () => number;
  initialBatchSizes: () => number[];
} {
  let callCount = 0;
  const initialSizes: number[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1;
    const request = JSON.parse(String(init?.body)) as {
      system: string;
      messages: Array<{ content: string }>;
    };
    const content = request.messages[0]?.content ?? "";
    const candidates = JSON.parse(content.slice(content.indexOf("\n") + 1)) as Array<{
      candidate_id: string;
      proposed_label: string;
    }>;
    const adjudication = request.system.includes("차 독립 재판정");
    if (!adjudication) initialSizes.push(candidates.length);
    const decided = adjudication ? candidates : candidates.slice(0, -1);
    return new Response(JSON.stringify({
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
      content: [{
        type: "tool_use",
        name: "emit_application_field_plan",
        input: {
          decisions: decided.map((candidate) => ({
            candidate_id: candidate.candidate_id,
            is_user_input: true,
            suggested_label: candidate.proposed_label,
            input_kind: "text",
            confidence: 0.95,
            help_text: "누락 자동 재판정 테스트",
            evidence: candidate.proposed_label,
          })),
        },
      }],
    }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls: () => callCount, initialBatchSizes: () => initialSizes };
}

function feedbackPlannerFetch(): {
  fetchImpl: typeof fetch;
  calls: () => number;
  batchSizes: () => number[];
} {
  let callCount = 0;
  const sizes: number[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1;
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const content = request.messages[0]?.content ?? "";
    const candidates = JSON.parse(content.slice(content.indexOf("\n") + 1)) as Array<{
      candidate_id: string;
      proposed_label: string;
    }>;
    sizes.push(candidates.length);
    const decisions = callCount === 1
      ? [{ ...candidates[0]!, is_user_input: true, confidence: 0.6 }]
      : callCount === 2
        ? candidates.map((candidate, index) => ({
            ...candidate,
            is_user_input: false,
            confidence: index === 0 ? 0.95 : 0.6,
          }))
        : candidates.map((candidate) => ({ ...candidate, is_user_input: true, confidence: 0.96 }));
    return new Response(JSON.stringify({
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
      content: [{
        type: "tool_use",
        name: "emit_application_field_plan",
        input: {
          decisions: decisions.map((decision) => ({
            candidate_id: decision.candidate_id,
            is_user_input: decision.is_user_input,
            suggested_label: decision.proposed_label,
            input_kind: decision.is_user_input ? "text" : "none",
            confidence: decision.confidence,
            help_text: "재판정 테스트",
            evidence: decision.proposed_label,
          })),
        },
      }],
    }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls: () => callCount, batchSizes: () => sizes };
}

function alwaysUncertainPlannerFetch(): { fetchImpl: typeof fetch; calls: () => number } {
  let callCount = 0;
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    callCount += 1;
    const request = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
    const content = request.messages[0]?.content ?? "";
    const candidates = JSON.parse(content.slice(content.indexOf("\n") + 1)) as Array<{
      candidate_id: string;
      proposed_label: string;
    }>;
    return new Response(JSON.stringify({
      stop_reason: "tool_use",
      usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 0 },
      content: [{
        type: "tool_use",
        name: "emit_application_field_plan",
        input: {
          decisions: candidates.map((candidate) => ({
            candidate_id: candidate.candidate_id,
            is_user_input: false,
            suggested_label: candidate.proposed_label,
            input_kind: "none",
            confidence: 0.6,
            help_text: "원문 정보 부족",
            evidence: candidate.proposed_label,
          })),
        },
      }],
    }), { status: 200 });
  }) as typeof fetch;
  return { fetchImpl, calls: () => callCount };
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
