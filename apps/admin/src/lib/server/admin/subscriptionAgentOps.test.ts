import assert from "node:assert/strict"

import {
  buildSubscriptionAgentProcessSpec,
  inferSubscriptionAgentStage,
  parseSubscriptionAgentPlanOutput,
  summarizeSubscriptionAgentReport,
} from "./subscriptionAgentOps"

{
  const plan = parseSubscriptionAgentPlanOutput(
    "[subscription-agent] 기존 품질 보정 2 · 미분석 실행 18 · 신규 안전 후보 292 · 최대 30건",
    new Date("2026-08-10T00:00:00.000Z"),
  )
  assert.deepEqual(plan, {
    generatedAt: "2026-08-10T00:00:00.000Z",
    count: 30,
    recoveryCount: 2,
    analysisCount: 18,
    newCandidateCount: 292,
  })
  console.log("✅ 구독 에이전트 ops 계획 — CLI 출력을 시각화 계약으로 변환")
}

{
  const spec = buildSubscriptionAgentProcessSpec({
    count: 30,
    maxCycles: 3,
    concurrency: 2,
    maxCostUsd: 65,
  })
  assert.equal(spec.command, "pnpm")
  assert.deepEqual(spec.args, [
    "lab:agent",
    "--",
    "--count=30",
    "--max-cycles=3",
    "--concurrency=2",
    "--max-cost-usd=65",
    "--execute",
  ])
  assert.equal(spec.envOverrides.ANALYSIS_LAB_TRANSPORT, "claude-cli")
  assert.equal(spec.envOverrides.ANALYSIS_LAB_MODEL, "claude-opus-5")
  assert.equal(spec.envOverrides.ANTHROPIC_API_KEY, "")
  console.log("✅ 구독 에이전트 ops 실행 — 정확한 상한과 API 폴백 차단")
}

{
  assert.equal(inferSubscriptionAgentStage([
    "[subscription-agent] 딥분석·Kordoc 병렬 실행",
    "[subscription-agent] Fable 독립 검수",
    "[subscription-agent] Sonnet 블라인드 감사",
  ], "running"), "auditing")
  assert.equal(inferSubscriptionAgentStage([], "completed"), "finished")
  console.log("✅ 구독 에이전트 ops 단계 — 마지막 관측 명령을 현재 품질 단계로 판정")
}

{
  const report = summarizeSubscriptionAgentReport({
    agentId: "agent-test",
    status: "partial",
    startedAt: "2026-08-10T00:00:00.000Z",
    finishedAt: "2026-08-10T00:01:00.000Z",
    selectedNewTargets: ["g1"],
    analyzedTargets: ["g1", "g2"],
    resumedQualityTargets: ["g3"],
    commandLabels: ["딥분석·Kordoc 병렬 실행", "Kordoc 품질 재분석"],
    cycles: [{
      decision: {
        completed: ["g1"],
        eligibilityRepair: ["g2"],
        applicationRetry: ["g3"],
        deepRetry: [],
        blocked: [{ grantId: "g4", reasons: ["검수 보류"] }],
      },
    }],
    error: null,
  })
  assert.ok(report)
  assert.equal(report.durationMs, 60_000)
  assert.equal(report.analyzedCount, 2)
  assert.equal(report.completedCount, 1)
  assert.equal(report.applicationRetryCount, 1)
  assert.equal(report.blockedCount, 1)
  assert.deepEqual(report.blockers, [{ grantId: "g4", reasons: ["검수 보류"] }])
  console.log("✅ 구독 에이전트 ops 보고서 — 종결·보정·차단 지표 집계")
}

console.log("subscription agent ops tests: ok")
