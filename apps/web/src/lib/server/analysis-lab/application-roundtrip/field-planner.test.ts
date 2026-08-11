// 2단 effort 배선 검증(2026-08-11 계획 §2-3-3, §3-T1):
// ① effort env/옵션 해석(미설정→null, 무효값 fail-fast)
// ② round 0에만 output_config.effort를 싣고 재판정 라운드는 기본 effort
// ③ round 0 저효율의 거절 수락 임계 0.85(경계 구간은 uncertain → 재판정에서 회복)
// ④ effort 미설정이면 현행과 100% 동일 동작
import assert from "node:assert/strict";
import type { RoundtripFieldCandidate } from "@/features/dev/analysis-lab/application-roundtrip-contract";
import {
  planRoundtripFields,
  resolveRoundtripEffort,
  resolveRoundtripFieldPlannerRuntimeConfig,
} from "./field-planner";

const originalEffortEnv = process.env.APPLICATION_ROUNDTRIP_EFFORT;

try {
  // ---- ① effort 해석 -------------------------------------------------------------
  delete process.env.APPLICATION_ROUNDTRIP_EFFORT;
  assert.equal(resolveRoundtripEffort(), null, "env 미설정 → null(현행 = effort 미지정)");
  process.env.APPLICATION_ROUNDTRIP_EFFORT = "  ";
  assert.equal(resolveRoundtripEffort(), null, "공백/빈 문자열 → null");
  process.env.APPLICATION_ROUNDTRIP_EFFORT = "medium";
  assert.equal(resolveRoundtripEffort(), "medium");
  assert.equal(resolveRoundtripEffort("low"), "low", "명시 옵션이 env보다 우선");
  assert.equal(resolveRoundtripEffort("high"), "high");
  assert.equal(resolveRoundtripEffort(null), null, "명시 null은 env를 무시하고 미지정");
  assert.equal(
    resolveRoundtripFieldPlannerRuntimeConfig({ transport: "claude-cli" }).effort,
    "medium",
    "runtime config가 env를 해석",
  );
  process.env.APPLICATION_ROUNDTRIP_EFFORT = "meduim";
  assert.throws(() => resolveRoundtripEffort(), /APPLICATION_ROUNDTRIP_EFFORT/, "env 오타 fail-fast");
  assert.throws(() => resolveRoundtripEffort("max"), /APPLICATION_ROUNDTRIP_EFFORT/, "명시 옵션 오타도 fail-fast");
  delete process.env.APPLICATION_ROUNDTRIP_EFFORT;
  assert.equal(
    resolveRoundtripFieldPlannerRuntimeConfig({ transport: "claude-cli" }).effort,
    null,
    "env 미설정 기본값은 현행과 동일(미지정)",
  );
  console.log("✅ resolveRoundtripEffort — 미설정/빈값/low/medium/high/오타 fail-fast");

  // ---- ② round 0에만 output_config.effort ----------------------------------------
  {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = buildFetch(bodies, [
      // round 0: cand-a 확정, cand-b는 저신뢰 입력 → uncertain으로 남아 재판정 유발
      [decision("cand-a", true, 0.9), decision("cand-b", true, 0.5)],
      // round 1: cand-b 확정
      [decision("cand-b", true, 0.9)],
    ]);
    const { summary } = await planRoundtripFields({
      fields: [candidate("cand-a"), candidate("cand-b")],
      markdown: "회사명: ____",
      apiKey: "test-key",
      fetchImpl,
      transport: "claude-cli",
      effort: "medium",
    });
    assert.equal(bodies.length, 2, "최초 판정 1회 + 재판정 1회");
    assert.deepEqual(bodies[0]?.output_config, { effort: "medium" }, "round 0 요청에는 effort를 싣는다");
    assert.equal("output_config" in (bodies[1] ?? {}), false, "재판정 라운드는 effort 미지정(기본)");
    assert.equal(summary.effort, "medium", "summary에 effort provenance 기록");
    assert.equal(summary.adjudicationStatus, "resolved");
    console.log("✅ 2단 effort — round 0에만 output_config.effort, 재판정은 기본 effort");
  }

  // ---- ③ round 0 저효율 거절 임계 0.85 --------------------------------------------
  {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = buildFetch(bodies, [
      // round 0(저효율): 0.8 거절은 0.85 게이트에 걸려 uncertain, 0.9 거절은 즉시 수락
      [decision("cand-a", false, 0.8), decision("cand-b", false, 0.9)],
      // round 1(기본 effort): 같은 0.8 거절이 현행 임계 0.75로 확정
      [decision("cand-a", false, 0.8)],
    ]);
    const { fields, summary } = await planRoundtripFields({
      fields: [candidate("cand-a"), candidate("cand-b")],
      markdown: "회사명: ____",
      apiKey: "test-key",
      fetchImpl,
      transport: "claude-cli",
      effort: "medium",
    });
    const candA = fields.find((field) => field.fieldInstanceId === "cand-a");
    const candB = fields.find((field) => field.fieldInstanceId === "cand-b");
    assert.equal(candB?.llmDecision, "not_input", "conf 0.9 거절은 저효율에서도 즉시 수락");
    assert.equal(candB?.llmDecisionRound, 0);
    assert.equal(candA?.llmDecision, "not_input");
    assert.equal(
      candA?.llmDecisionRound,
      1,
      "conf 0.8 거절은 round 0(저효율)에서 uncertain으로 남아 재판정에서 확정",
    );
    assert.equal(summary.adjudicationRounds, 1);
    console.log("✅ 저효율 거절 임계 — [0.75,0.85) 경계 구간을 재판정으로 회복");
  }

  // ---- ④ effort 미설정 = 현행 동일 -------------------------------------------------
  {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = buildFetch(bodies, [[decision("cand-a", false, 0.8)]]);
    const { fields, summary } = await planRoundtripFields({
      fields: [candidate("cand-a")],
      markdown: "회사명: ____",
      apiKey: "test-key",
      fetchImpl,
      transport: "claude-cli",
    });
    assert.equal(bodies.length, 1, "재판정 라운드 없음");
    assert.equal("output_config" in (bodies[0] ?? {}), false, "effort 미지정이면 요청 본문 현행 동일");
    assert.equal(fields[0]?.llmDecision, "not_input", "conf 0.8 거절은 현행 임계 0.75로 즉시 수락");
    assert.equal(fields[0]?.llmDecisionRound, 0);
    assert.equal(summary.effort, null);
    console.log("✅ effort 미설정 — 요청 본문·거절 임계 모두 현행 그대로");
  }
} finally {
  if (originalEffortEnv === undefined) delete process.env.APPLICATION_ROUNDTRIP_EFFORT;
  else process.env.APPLICATION_ROUNDTRIP_EFFORT = originalEffortEnv;
}

console.log("application roundtrip field-planner effort tests: ok");

function candidate(id: string): RoundtripFieldCandidate {
  return {
    fieldInstanceId: id,
    label: `${id} 라벨`,
    displayLabel: `${id} 라벨`,
    normalizedLabel: `${id} 라벨`,
    originalValue: "",
    type: "text",
    required: false,
    empty: true,
    recommendedInput: false,
    inputLikelihood: 0.5,
    inputSignals: [],
    sampleValue: "",
    sampleReason: "",
    source: "kordoc-form",
    inputKind: "text",
    writeOperation: "kordoc_field",
    helperText: null,
    unit: null,
    options: [],
    analysisSource: "heuristic",
    llmConfidence: null,
    location: { blockIndex: 0, row: 0, col: 0, occurrence: 0, pageNumber: null },
  };
}

function decision(candidateId: string, isUserInput: boolean, confidence: number): Record<string, unknown> {
  return {
    candidate_id: candidateId,
    is_user_input: isUserInput,
    suggested_label: "",
    input_kind: isUserInput ? "text" : "none",
    confidence,
    help_text: "",
    evidence: "",
  };
}

/** 요청 body를 캡처하고 라운드(호출 순서)별 준비된 판정을 돌려주는 주입용 fetch. */
function buildFetch(
  capturedBodies: Array<Record<string, unknown>>,
  decisionsByCall: Array<Array<Record<string, unknown>>>,
): typeof fetch {
  let call = 0;
  return (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    capturedBodies.push(body);
    const decisions = decisionsByCall[Math.min(call, decisionsByCall.length - 1)] ?? [];
    call += 1;
    return new Response(
      JSON.stringify({
        content: [{ type: "tool_use", name: "emit_application_field_plan", input: { decisions } }],
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
}
