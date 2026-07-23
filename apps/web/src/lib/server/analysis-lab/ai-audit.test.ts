// AI 블라인드 감사(§9 완화 개정) 단위 테스트 (순수 함수 — DB·네트워크·API 미사용).
// 실행: pnpm lab:ai-audit:test
// 검증: ① 스키마 하위호환 — aiAudit 필드 없는 기존 감사 파일(27건 형태)의 로드·완료 판정
// ② isLabAuditComplete 새 규칙(사람 판정 or AI 감사 정확 일치 — unsure 는 일치여도 미완료)
// ③ applyAiAuditJudgments 의 humanVerdict 불가침·aiAudit 병합·모델 순환 가드
// ④ 판정 비교(compareAiAuditVerdicts — concur/불일치/unsure) ⑤ 응답 검증(대상 부분집합 강제).
import assert from "node:assert/strict";
import {
  compareAiAuditVerdicts,
  selectPendingAuditItems,
  validateAiAuditPayload,
} from "./ai-audit";
import { applyAiAuditJudgments, isLabAuditComplete } from "./audit-store";
import { isAiAuditConcur, type LabAudit, type LabAuditItem } from "@/features/dev/analysis-lab/contract";

function auditFixture(items: LabAuditItem[]): LabAudit {
  return {
    schema: "lab-audit-v1",
    grantId: "g1",
    runId: "run-1",
    model: "claude-fable-5",
    aiPromptVersion: "ai-review-v2",
    auditorEmail: null,
    createdAt: "2026-07-23T00:00:00.000Z",
    updatedAt: "2026-07-23T00:00:00.000Z",
    items,
    overallNote: null,
  };
}

const baseItems: LabAuditItem[] = [
  {
    kind: "criterion",
    criterionIndex: 1,
    reason: "ai_non_correct",
    aiVerdict: "needs_edit",
    aiNote: "AI 지적",
    humanVerdict: null,
    note: null,
  },
  {
    kind: "criterion",
    criterionIndex: 3,
    reason: "correct_sample",
    aiVerdict: "correct",
    aiNote: null,
    humanVerdict: null,
    note: null,
  },
  {
    kind: "axis",
    dimension: "revenue",
    reason: "missed_condition_flag",
    aiVerdict: "missed_condition",
    aiNote: "매출 요건 실재 주장",
    humanVerdict: null,
    note: null,
  },
];

// ── ① 스키마 하위호환 — 기존 27개 파일 형태(aiAudit 필드 없음)가 그대로 동작 ────────
{
  // 실파일과 같은 형태의 JSON 왕복 — optional 필드가 없어도 파싱·판정이 동작해야 한다.
  const legacy = JSON.parse(JSON.stringify(auditFixture(baseItems))) as LabAudit;
  assert.equal(legacy.items[0]!.aiAuditVerdict, undefined, "구 파일에는 aiAuditVerdict 자체가 없다");
  assert.equal(legacy.aiAuditModel, undefined, "구 파일에는 aiAuditModel 자체가 없다");
  assert.equal(isLabAuditComplete(legacy), false, "aiAudit 없이 전건 미판정 → 미완료(기존 동작 유지)");
  assert.equal(
    isLabAuditComplete(
      auditFixture(baseItems.map((item) => ({ ...item, humanVerdict: item.aiVerdict as never }))),
    ),
    true,
    "사람 전건 판정 → 완료(기존 동작 유지)",
  );
  assert.equal(isLabAuditComplete(auditFixture([])), true, "대상 0건 공허 완료(기존 동작 유지)");
  console.log("✅ 하위호환 — aiAudit 필드 없는 기존 감사 파일 형태 그대로 동작");
}

// ── ② isLabAuditComplete 새 규칙 + isAiAuditConcur ──────────────────────────────────
{
  // 일치(concur) — 사람 판정 없이 완료.
  const concur = auditFixture(
    baseItems.map((item) => ({ ...item, aiAuditVerdict: item.aiVerdict as never, aiAuditNote: null })),
  );
  assert.equal(isLabAuditComplete(concur), true, "AI 감사 전건 정확 일치 → 완료");

  // 불일치 — humanVerdict 가 채워져야 완료.
  const disagree = auditFixture([
    { ...baseItems[0]!, aiAuditVerdict: "correct", aiAuditNote: null }, // needs_edit vs correct
    { ...baseItems[1]!, aiAuditVerdict: "correct", aiAuditNote: null }, // 일치
    { ...baseItems[2]!, aiAuditVerdict: "confirmed_absent", aiAuditNote: null }, // 불일치
  ]);
  assert.equal(isLabAuditComplete(disagree), false, "불일치 항목 잔존 → 미완료");
  const disagreeThenHuman = auditFixture([
    { ...baseItems[0]!, aiAuditVerdict: "correct", aiAuditNote: null, humanVerdict: "correct", note: "사람 확인" },
    { ...baseItems[1]!, aiAuditVerdict: "correct", aiAuditNote: null },
    {
      ...baseItems[2]!,
      aiAuditVerdict: "confirmed_absent",
      aiAuditNote: null,
      humanVerdict: "confirmed_absent",
      note: "사람 확인 — 다른 축에서 포착",
    },
  ]);
  assert.equal(isLabAuditComplete(disagreeThenHuman), true, "불일치 항목에 사람 판정 → 완료");

  // unsure 는 정확 일치여도 자동 확정하지 않는다(보수 조항).
  const unsureBoth = auditFixture([
    {
      kind: "criterion",
      criterionIndex: 5,
      reason: "ai_non_correct",
      aiVerdict: "unsure",
      aiNote: "붙임 미포함",
      humanVerdict: null,
      note: null,
      aiAuditVerdict: "unsure",
      aiAuditNote: "동일하게 판단 불가",
    },
  ]);
  assert.equal(isAiAuditConcur(unsureBoth.items[0]!), false, "unsure == unsure 는 concur 아님");
  assert.equal(isLabAuditComplete(unsureBoth), false, "unsure 일치 → 여전히 사람 큐 잔류");
  console.log("✅ isLabAuditComplete 새 규칙 — 일치 자동 완료·불일치/unsure 는 사람 몫");
}

// ── ③ applyAiAuditJudgments — humanVerdict 불가침·병합·가드 ─────────────────────────
{
  const humanJudged: LabAuditItem = {
    kind: "criterion",
    criterionIndex: 7,
    reason: "ai_non_correct",
    aiVerdict: "wrong",
    aiNote: "AI 오류 지적",
    humanVerdict: "correct",
    note: "사람이 이미 뒤집음",
  };
  const stored = auditFixture([...baseItems, humanJudged]);
  const outcome = applyAiAuditJudgments(stored, {
    aiAuditModel: "claude-sonnet-5",
    aiAuditPromptVersion: "ai-audit-v1",
    now: "2026-07-23T10:00:00.000Z",
    judgments: [
      { kind: "criterion", criterionIndex: 1, aiAuditVerdict: "needs_edit", aiAuditNote: "  독립 재판정 사유  " },
      { kind: "criterion", criterionIndex: 3, aiAuditVerdict: "wrong", aiAuditNote: "원문에 없음" },
      { kind: "axis", dimension: "revenue", aiAuditVerdict: "confirmed_absent", aiAuditNote: null },
      // 사람 판정 보유 항목 — 스킵돼야 한다.
      { kind: "criterion", criterionIndex: 7, aiAuditVerdict: "wrong", aiAuditNote: "덮어쓰기 시도" },
    ],
  });
  assert.equal(outcome.status, "ok");
  if (outcome.status !== "ok") throw new Error("unreachable");
  assert.equal(outcome.applied, 3);
  assert.equal(outcome.skippedHuman, 1);

  const byKey = new Map(
    outcome.audit.items.map((item) => [
      item.kind === "criterion" ? `c:${item.criterionIndex}` : `a:${item.dimension}`,
      item,
    ]),
  );
  // 병합: aiAudit 필드만 기록되고 note 는 trim.
  assert.equal(byKey.get("c:1")!.aiAuditVerdict, "needs_edit");
  assert.equal(byKey.get("c:1")!.aiAuditNote, "독립 재판정 사유");
  assert.equal(byKey.get("c:3")!.aiAuditVerdict, "wrong");
  assert.equal(byKey.get("a:revenue")!.aiAuditVerdict, "confirmed_absent");
  // humanVerdict/note 불가침 — 스킵 항목은 aiAudit 도 기록되지 않는다.
  const human = byKey.get("c:7")!;
  assert.equal(human.humanVerdict, "correct");
  assert.equal(human.note, "사람이 이미 뒤집음");
  assert.equal(human.aiAuditVerdict, undefined, "사람 판정 항목은 AI 감사 기록 자체를 남기지 않음");
  // 원본 불변(순수 함수) + 미판정 필드 보존.
  assert.equal(stored.items[0]!.aiAuditVerdict, undefined, "입력 객체는 변형되지 않는다");
  assert.equal(byKey.get("c:1")!.humanVerdict, null);
  // 메타 병기.
  assert.equal(outcome.audit.aiAuditModel, "claude-sonnet-5");
  assert.equal(outcome.audit.aiAuditPromptVersion, "ai-audit-v1");
  assert.equal(outcome.audit.aiAuditedAt, "2026-07-23T10:00:00.000Z");
  assert.equal(outcome.audit.updatedAt, "2026-07-23T10:00:00.000Z");
  assert.equal(outcome.audit.createdAt, stored.createdAt, "createdAt 보존");
  assert.equal(outcome.audit.auditorEmail, null, "auditorEmail 은 건드리지 않는다");

  // 가드: 감사 모델 === 검수 모델(자기 확인 순환).
  const circular = applyAiAuditJudgments(stored, {
    aiAuditModel: "claude-fable-5",
    aiAuditPromptVersion: "ai-audit-v1",
    judgments: [],
  });
  assert.equal(circular.status, "invalid");
  // 가드: 대상 목록 밖 항목·중복·어휘.
  assert.equal(
    applyAiAuditJudgments(stored, {
      aiAuditModel: "claude-sonnet-5",
      aiAuditPromptVersion: "ai-audit-v1",
      judgments: [{ kind: "criterion", criterionIndex: 99, aiAuditVerdict: "correct", aiAuditNote: null }],
    }).status,
    "invalid",
    "동결된 대상 목록에 없는 항목 거부",
  );
  assert.equal(
    applyAiAuditJudgments(stored, {
      aiAuditModel: "claude-sonnet-5",
      aiAuditPromptVersion: "ai-audit-v1",
      judgments: [
        { kind: "criterion", criterionIndex: 1, aiAuditVerdict: "correct", aiAuditNote: null },
        { kind: "criterion", criterionIndex: 1, aiAuditVerdict: "wrong", aiAuditNote: "dup" },
      ],
    }).status,
    "invalid",
    "중복 판정 거부",
  );
  assert.equal(
    applyAiAuditJudgments(stored, {
      aiAuditModel: "claude-sonnet-5",
      aiAuditPromptVersion: "ai-audit-v1",
      judgments: [{ kind: "axis", dimension: "revenue", aiAuditVerdict: "correct" as never, aiAuditNote: null }],
    }).status,
    "invalid",
    "빈 축 항목에 criterion 어휘 거부",
  );
  console.log("✅ applyAiAuditJudgments — humanVerdict 불가침·aiAudit 병합·순환/동결 가드");
}

// ── ④ selectPendingAuditItems + compareAiAuditVerdicts ──────────────────────────────
{
  const mixed = auditFixture([
    { ...baseItems[0]! }, // 미판정 — 대상
    { ...baseItems[1]!, aiAuditVerdict: "correct", aiAuditNote: null }, // 기록 완료 — force 만 대상
    { ...baseItems[2]!, humanVerdict: "confirmed_absent", note: "사람 판정" }, // 사람 — 제외
  ]);
  assert.deepEqual(
    selectPendingAuditItems(mixed).map((item) => item.criterionIndex ?? item.dimension),
    [1],
    "기본: humanVerdict·aiAudit 기록 항목 제외",
  );
  assert.deepEqual(
    selectPendingAuditItems(mixed, true).map((item) => item.criterionIndex ?? item.dimension),
    [1, 3],
    "--force: aiAudit 기록 항목 재판정(사람 판정 항목은 여전히 제외)",
  );

  const comparison = compareAiAuditVerdicts(
    baseItems,
    [
      { criterionIndex: 1, verdict: "needs_edit", note: "같은 지적" }, // 일치
      { criterionIndex: 3, verdict: "unsure", note: "붙임 판단 불가" }, // unsure
    ],
    [{ dimension: "revenue", verdict: "confirmed_absent", note: null }], // 불일치
  );
  assert.equal(comparison.concurCount, 1);
  assert.equal(comparison.unsureCount, 1);
  assert.equal(comparison.disagreeCount, 1);
  assert.deepEqual(
    comparison.judgments.map((judgment) => [
      judgment.criterionIndex ?? judgment.dimension,
      judgment.aiAuditVerdict,
    ]),
    [
      [1, "needs_edit"],
      [3, "unsure"],
      ["revenue", "confirmed_absent"],
    ],
    "판정은 일치 여부와 무관하게 전건 기록",
  );
  assert.throws(
    () => compareAiAuditVerdicts(baseItems, [], []),
    /감사 판정 누락/,
    "커버리지 누락은 정직하게 실패",
  );
  console.log("✅ selectPendingAuditItems·compareAiAuditVerdicts — 대상 선정·비교 집계");
}

// ── ⑤ validateAiAuditPayload — 대상 부분집합 강제 ────────────────────────────────────
{
  const good = validateAiAuditPayload(
    {
      criterion_reviews: [
        { criterion_index: 3, verdict: "correct" },
        { criterion_index: 1, verdict: "needs_edit", note: "수정 사유" },
      ],
      axis_reviews: [{ dimension: "revenue", verdict: "missed_condition", note: "원문 인용" }],
    },
    [1, 3],
    ["revenue"],
  );
  assert.equal(good.ok, true);
  if (!good.ok) throw new Error("unreachable");
  assert.deepEqual(
    good.criterionReviews.map((review) => review.criterionIndex),
    [1, 3],
    "인덱스 정렬",
  );

  assert.equal(
    validateAiAuditPayload(
      { criterion_reviews: [{ criterion_index: 2, verdict: "correct" }], axis_reviews: [] },
      [1],
      [],
    ).ok,
    false,
    "판정 대상 밖 인덱스 거부",
  );
  assert.equal(
    validateAiAuditPayload(
      { criterion_reviews: [{ criterion_index: 1, verdict: "needs_edit" }], axis_reviews: [] },
      [1],
      [],
    ).ok,
    false,
    "비-correct 판정 note 필수",
  );
  assert.equal(
    validateAiAuditPayload(
      { criterion_reviews: [{ criterion_index: 1, verdict: "correct" }], axis_reviews: [] },
      [1, 3],
      [],
    ).ok,
    false,
    "커버리지 미달 거부",
  );
  assert.equal(
    validateAiAuditPayload(
      {
        criterion_reviews: [{ criterion_index: 1, verdict: "correct" }],
        axis_reviews: [{ dimension: "ip", verdict: "confirmed_absent" }],
      },
      [1],
      ["revenue"],
    ).ok,
    false,
    "판정 대상 밖 축 거부",
  );
  console.log("✅ validateAiAuditPayload — 대상 부분집합·note·커버리지 강제");
}

console.log("\nai-audit 테스트 전부 통과");
