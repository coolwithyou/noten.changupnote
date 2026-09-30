import assert from "node:assert/strict";
import type { ApplySheet } from "@cunote/contracts";
import { explainCondition } from "@cunote/core";
import type { GrantPreviewAvailability } from "@/lib/server/documents/documentPreview";
import {
  CONDITION_ROW_STATUS_LABEL,
  CONDITION_TRUST_LABEL,
  conditionRowEvidence,
  conditionRowSource,
  conditionRowStatus,
  conditionTrust,
  countHardConditions,
  describeFailedCondition,
  failedHardConditions,
  formatDday,
  formatEligibilitySummary,
  formatSupportAmount,
  grantOverviewCta,
  grantOverviewTraceAction,
  grantOverviewVerdict,
} from "./logic";

function sheetFixture(input: {
  status?: ApplySheet["grant"]["status"];
  applyMethod?: string | null;
  needsCheck?: ApplySheet["needsCheck"];
  documents?: ApplySheet["documents"];
  draftableDocuments?: ApplySheet["applicationPrep"]["draftableDocuments"];
  matchingEvidence?: ApplySheet["matchingEvidence"];
  recommendationTier?: ApplySheet["recommendationTier"];
  scoreDisplay?: ApplySheet["scoreDisplay"];
} = {}): ApplySheet {
  return {
    ...(input.matchingEvidence ? { matchingEvidence: input.matchingEvidence } : {}),
    ...(input.recommendationTier ? { recommendationTier: input.recommendationTier } : {}),
    ...(input.scoreDisplay ? { scoreDisplay: input.scoreDisplay } : {}),
    grant: { status: input.status ?? "open" },
    needsCheck: input.needsCheck ?? [],
    documents: input.documents ?? [],
    applicationPrep: { draftableDocuments: input.draftableDocuments ?? [] },
    applyMethod: input.applyMethod ?? null,
  } as ApplySheet;
}

function previewFixture(input: Partial<GrantPreviewAvailability> = {}): GrantPreviewAvailability {
  return {
    surfaceCount: 0,
    readySurfaceCount: 0,
    pendingSurfaceCount: 0,
    pageImageCount: 0,
    ...input,
  };
}

assert.equal(grantOverviewVerdict(sheetFixture()), "open");
const discoverySheet = sheetFixture({
  matchingEvidence: {
    level: "discovery",
    sourceRevisionSha256: "a".repeat(64),
    reason: "unreviewed",
  },
  draftableDocuments: [{ sourceAttachment: "신청서.hwpx", hwpxTemplateAvailable: true }] as ApplySheet["applicationPrep"]["draftableDocuments"],
});
assert.equal(grantOverviewVerdict(discoverySheet), "check_source");
assert.equal(grantOverviewCta(discoverySheet, previewFixture({ readySurfaceCount: 1 })).mode, "manual_form");
assert.equal(grantOverviewVerdict(sheetFixture({
  status: "closed",
  matchingEvidence: discoverySheet.matchingEvidence,
})), "closed");
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "one_answer",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      status: "upcoming",
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "check_source",
);
assert.equal(grantOverviewVerdict(sheetFixture({ status: "upcoming" })), "check_source");
assert.equal(grantOverviewVerdict(sheetFixture({ status: "unknown" })), "check_source");
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "one_answer",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
        {
          dimension: "region",
          result: "unknown",
          action: { type: "progressive", target: "region", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
        {
          dimension: "region",
          result: "unknown",
          action: { type: "external_link", target: "source", label: "원문 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
      documents: [{ fromTextOnly: true }] as ApplySheet["documents"],
    }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({ needsCheck: [{ result: "unknown" }] as ApplySheet["needsCheck"] }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({ documents: [{ fromTextOnly: true }] as ApplySheet["documents"] }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({ needsCheck: [{ result: "fail" }] as ApplySheet["needsCheck"] }),
  ),
  "closed",
);
assert.equal(
  grantOverviewVerdict(
    sheetFixture({
      recommendationTier: "needs_core_review",
      scoreDisplay: "hidden",
      needsCheck: [
        {
          dimension: "industry",
          result: "unknown",
          action: { type: "progressive", target: "industry", label: "지금 확인" },
        },
      ] as ApplySheet["needsCheck"],
    }),
  ),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(sheetFixture({
    recommendationTier: "needs_core_review",
    scoreDisplay: "hidden",
    needsCheck: [{ result: "fail" }] as ApplySheet["needsCheck"],
  })),
  "closed",
);
assert.equal(
  grantOverviewVerdict(sheetFixture({ recommendationTier: "not_recommended", scoreDisplay: "hidden" })),
  "closed",
);
assert.equal(
  grantOverviewVerdict(sheetFixture({ recommendationTier: "recommendable", scoreDisplay: "numeric" })),
  "open",
);
assert.equal(
  grantOverviewVerdict(sheetFixture({ recommendationTier: "recommendable", scoreDisplay: "hidden" })),
  "check_source",
);
assert.equal(
  grantOverviewVerdict(sheetFixture({
    recommendationTier: "needs_profile_input",
    scoreDisplay: "numeric",
    needsCheck: [
      {
        dimension: "industry",
        result: "unknown",
        action: { type: "progressive", target: "industry", label: "지금 확인" },
      },
    ] as ApplySheet["needsCheck"],
  })),
  "one_answer",
);
assert.equal(
  grantOverviewVerdict(sheetFixture({ recommendationTier: "needs_profile_input", scoreDisplay: "numeric" })),
  "check_source",
);

const templateSheet = sheetFixture({
  draftableDocuments: [{ sourceAttachment: "신청서.hwpx", hwpxTemplateAvailable: true }] as ApplySheet["applicationPrep"]["draftableDocuments"],
});
assert.deepEqual(grantOverviewCta(templateSheet, previewFixture()), {
  mode: "manual_form",
  label: "지원서 작성 시작",
  caption: "원본 양식을 열고 작성해요. 자동 입력 가능한 항목은 작성 화면에서 확인해요",
  variant: "default",
});

assert.equal(
  grantOverviewCta(sheetFixture(), previewFixture({ pendingSurfaceCount: 2 })).mode,
  "preparation_needed",
);
assert.equal(
  grantOverviewCta(
    sheetFixture({
      draftableDocuments: [{ hwpxTemplateAvailable: false }] as ApplySheet["applicationPrep"]["draftableDocuments"],
    }),
    previewFixture(),
  ).mode,
  "ai_draft",
);
assert.equal(
  grantOverviewCta(sheetFixture({ applyMethod: "온라인 접수" }), previewFixture()).mode,
  "web_form_guide",
);
assert.equal(grantOverviewCta(sheetFixture(), previewFixture()).mode, "unknown");

assert.deepEqual(
  grantOverviewTraceAction(
    { type: "progressive", target: "industry", label: "지금 확인" },
    "https://example.com/grants/1",
  ),
  { href: "/settings?section=company", external: false },
);
assert.deepEqual(
  grantOverviewTraceAction(
    { type: "external_link", target: "https://other.example/grants/1", label: "원문 확인" },
    "https://example.com/grants/1",
  ),
  { href: "https://example.com/grants/1", external: true },
);
assert.deepEqual(
  grantOverviewTraceAction(
    { type: "prepare", target: "region", label: "준비 조건 보기" },
    "https://example.com/grants/1",
  ),
  { href: "https://example.com/grants/1", external: true },
);
assert.deepEqual(
  grantOverviewTraceAction(
    { type: "verify", target: "region", label: "확인 방법 보기" },
    "javascript:alert(1)",
  ),
  { href: "/settings?section=company", external: false },
);
assert.equal(
  grantOverviewTraceAction(
    { type: "external_link", target: "source", label: "원문 확인" },
    "/legacy-placeholder",
  ),
  null,
);

assert.equal(formatSupportAmount({ max: 30_000_000, unit: "KRW", per: "기업" }), "3,000만 원");
assert.equal(
  formatSupportAmount({ label: "최대 3,000만원", max: null, unit: "KRW", per: "기업" }),
  "최대 3,000만 원",
);
assert.equal(formatDday(21), "D-21");
// 집계 어휘(결정 D1): "확인된 조건 N/M · 남은 쟁점 K", 불일치가 있을 때만 " · 불일치 J".
assert.equal(formatEligibilitySummary(3, 2), "확인된 조건 3/5 · 남은 쟁점 2");
assert.equal(formatEligibilitySummary(1, 2, 1), "확인된 조건 1/4 · 남은 쟁점 2 · 불일치 1");
assert.equal(formatEligibilitySummary(4, 0), "확인된 조건 4/4 · 남은 쟁점 0");
assert.equal(formatEligibilitySummary(0, 0, 0), "매칭 확인 중");

// 필수·제외 조건만 센다. 우대 조건은 총수에도 남은 쟁점에도 들어가지 않는다.
const countedSheet = {
  satisfied: [
    { kind: "required", result: "pass", label: "부산 소재" },
    { kind: "preferred", result: "pass", label: "여성기업" },
  ],
  needsCheck: [
    { kind: "required", result: "fail", label: "대표자 만 39세 이하", companyValue: "1984년생" },
    { kind: "exclusion", result: "unknown", label: "국세·지방세 체납" },
    { kind: "required", result: "text_only", label: "중소기업" },
    { kind: "preferred", result: "unknown", label: "수출 실적" },
  ],
} as unknown as Pick<ApplySheet, "satisfied" | "needsCheck">;
assert.deepEqual(countHardConditions(countedSheet), { total: 4, passed: 1, failed: 1, unknown: 2 });
assert.deepEqual(failedHardConditions(countedSheet).map((trace) => trace.label), ["대표자 만 39세 이하"]);
assert.equal(
  describeFailedCondition(failedHardConditions(countedSheet)[0]!),
  "대표자 만 39세 이하 — 회사 정보(1984년생)와 맞지 않아요.",
);
assert.equal(
  describeFailedCondition({ kind: "required", result: "fail", label: "  ", sourceSpan: "창업 7년 이내" } as ApplySheet["needsCheck"][number]),
  "창업 7년 이내 — 현재 회사 정보와 맞지 않아요.",
);
assert.deepEqual(countHardConditions({ satisfied: [], needsCheck: [] }), { total: 0, passed: 0, failed: 0, unknown: 0 });

// 저장본이 있으면 작성 시작 모드(manual_form·ai_draft)만 "문서 열기"로 바뀐다(디자인 03 장면 F).
const resume = { savedCount: 3, lastSavedAt: new Date("2026-09-30T09:06:00Z") };
const resumeNow = new Date("2026-09-30T12:00:00Z");
assert.deepEqual(grantOverviewCta(templateSheet, previewFixture(), resume, { now: resumeNow }), {
  mode: "resume",
  label: "문서 열기",
  caption: "저장본 3 · 마지막 서버 저장 오늘 18:06 · 같은 문서와 작성 상태로 돌아가요",
  variant: "default",
});
assert.equal(
  grantOverviewCta(sheetFixture({
    draftableDocuments: [{ hwpxTemplateAvailable: false }] as ApplySheet["applicationPrep"]["draftableDocuments"],
  }), previewFixture(), resume).mode,
  "resume",
);
assert.equal(grantOverviewCta(templateSheet, previewFixture(), null).mode, "manual_form");
assert.equal(grantOverviewCta(templateSheet, previewFixture(), { savedCount: 0, lastSavedAt: resume.lastSavedAt }).mode, "manual_form");
assert.equal(grantOverviewCta(sheetFixture(), previewFixture({ pendingSurfaceCount: 2 }), resume).mode, "preparation_needed");
assert.equal(grantOverviewCta(sheetFixture({ applyMethod: "온라인 접수" }), previewFixture(), resume).mode, "web_form_guide");
assert.equal(grantOverviewCta(sheetFixture(), previewFixture(), resume).mode, "unknown");

// 자격 미확정/마감은 기존 원본 편집을 잠그지 않는다. 미리보기만으로 양식 채움을 약속하지 않는다.
for (const status of ["open", "closed"] as const) {
  const manual = sheetFixture({ status, matchingEvidence: discoverySheet.matchingEvidence,
    draftableDocuments: [{ sourceAttachment: "신청서.HWP", hwpxTemplateAvailable: false }] as ApplySheet["applicationPrep"]["draftableDocuments"],
  });
  assert.equal(grantOverviewCta(manual, null).mode, "manual_form");
  assert.equal(grantOverviewCta(manual, previewFixture({ pendingSurfaceCount: 1 })).mode, "manual_form");
}
assert.equal(grantOverviewCta(sheetFixture({ matchingEvidence: discoverySheet.matchingEvidence }), previewFixture({ readySurfaceCount: 1 })).mode, "unknown");
assert.equal(grantOverviewCta(sheetFixture({
  draftableDocuments: [{ sourceAttachment: "안내문.pdf", hwpxTemplateAvailable: false }] as ApplySheet["applicationPrep"]["draftableDocuments"],
}), previewFixture({ readySurfaceCount: 1 })).mode, "ai_draft");

// 조건 행 6상태(디자인 03): pass/fail 그대로, 미해소는 다음 행동 순, 나머지는 검토 준비 중.
const rowBase = {
  criterionId: "c",
  dimension: "region",
  kind: "required",
  label: "부산 소재",
  sourceSpan: "본점이 부산에 소재한 기업",
  checklistSection: "needs_check",
} as const satisfies Partial<ApplySheet["needsCheck"][number]>;
const rowTrace = (input: Partial<ApplySheet["needsCheck"][number]>) =>
  explainCondition({ ...rowBase, result: "unknown", ...input } as ApplySheet["needsCheck"][number]);

assert.equal(conditionRowStatus(rowTrace({ result: "pass", companyValue: "부산 해운대구 · 국세청" })), "met");
assert.equal(conditionRowStatus(rowTrace({ result: "fail", companyValue: "서울" })), "unmet");
assert.equal(
  conditionRowStatus(rowTrace({ unresolvedReason: "company_profile_missing", confirmationNextAction: "company_profile" })),
  "ask",
);
assert.equal(
  conditionRowStatus(rowTrace({ unresolvedReason: "criterion_text_only", confirmationNextAction: "user_confirmation" })),
  "per",
);
assert.equal(
  conditionRowStatus(rowTrace({ result: "text_only", unresolvedReason: "criterion_text_only", confirmationNextAction: "admin_source_review" })),
  "src",
);
assert.equal(
  conditionRowStatus(rowTrace({ unresolvedReason: "criterion_text_only", confirmationNextAction: "admin_source_review" })),
  "src",
);
assert.equal(
  conditionRowStatus(rowTrace({ unresolvedReason: "criterion_needs_review", confirmationNextAction: "admin_source_review" })),
  "wait",
);
assert.equal(conditionRowStatus(rowTrace({})), "wait");
// legacy trace(confirmationNextAction 없음)는 action 종류로 읽는다.
assert.equal(
  conditionRowStatus(rowTrace({ action: { type: "progressive", target: "region", label: "지금 확인" } })),
  "ask",
);
assert.equal(
  conditionRowStatus(rowTrace({ action: { type: "external_link", target: "source", label: "원문 확인" } })),
  "src",
);
// 명시된 admin_source_review는 legacy action보다 우선한다.
assert.equal(
  conditionRowStatus(rowTrace({
    unresolvedReason: "criterion_needs_review",
    confirmationNextAction: "admin_source_review",
    action: { type: "progressive", target: "region", label: "지금 확인" },
  })),
  "wait",
);
assert.deepEqual(Object.values(CONDITION_ROW_STATUS_LABEL), ["충족", "미충족", "내 답 필요", "공고별 확인", "원문 확인 필요", "검토 준비 중"]);

// 검수 칩: 조건 자체가 검수 대기면 시트 수준과 무관하게 AI가 읽음, 그 외에는 시트 수준, 수준 없으면 생략.
assert.equal(conditionTrust(rowTrace({ result: "pass" }), "verified"), "reviewed");
assert.equal(conditionTrust(rowTrace({ result: "pass" }), "discovery"), "ai");
assert.equal(conditionTrust(rowTrace({ result: "pass" }), null), null);
assert.equal(conditionTrust(rowTrace({ result: "pass" }), undefined), null);
assert.equal(conditionTrust(rowTrace({ unresolvedReason: "criterion_needs_review" }), "verified"), "ai");
assert.deepEqual(CONDITION_TRUST_LABEL, { reviewed: "검수됨", ai: "AI가 읽음" });

// 근거: 회사값 우선, 없으면 판정 이유. 공고별 확인은 금지 어휘 없는 행 어휘로.
assert.equal(conditionRowEvidence(rowTrace({ result: "pass", companyValue: " 부산 해운대구 · 국세청 " })), "부산 해운대구 · 국세청");
assert.equal(conditionRowEvidence(rowTrace({ result: "fail" })), "현재 회사 정보와 조건이 맞지 않아요.");
assert.equal(
  conditionRowEvidence(rowTrace({ unresolvedReason: "company_profile_missing", confirmationNextAction: "company_profile" })),
  "이 조건과 비교할 회사 정보가 더 필요해요.",
);
const perEvidence = conditionRowEvidence(
  rowTrace({ unresolvedReason: "criterion_text_only", confirmationNextAction: "user_confirmation" }),
);
assert.equal(perEvidence, "이 공고에서만 확인하는 질문이에요. 답하면 다시 판단해요.");
// 금지 어휘(core 이유 문장의 "지원·가능" 표현)가 행 어휘에 새지 않는다.
assert.ok(!/지원\s?가능/.test(perEvidence));
assert.equal(
  conditionRowEvidence(rowTrace({ unresolvedReason: "criterion_needs_review", confirmationNextAction: "admin_source_review" })),
  "창업노트에서 추출한 조건의 검수가 필요해요.",
);

// 출처 줄: "공고 원문"에 기준명(조건 문장과 다를 때만)과 검수 전 표시.
assert.equal(conditionRowSource(rowTrace({ result: "pass" }), "reviewed"), "공고 원문 · 부산 소재");
assert.equal(conditionRowSource(rowTrace({ result: "pass" }), null), "공고 원문 · 부산 소재");
assert.equal(conditionRowSource(rowTrace({ result: "pass" }), "ai"), "공고 원문 · 부산 소재 · 검수 전");
const { sourceSpan: _omittedSpan, ...rowBaseWithoutSpan } = rowBase;
void _omittedSpan;
assert.equal(
  conditionRowSource(explainCondition({ ...rowBaseWithoutSpan, result: "pass" } as ApplySheet["needsCheck"][number]), "reviewed"),
  "공고 원문",
);
assert.equal(conditionRowSource(rowTrace({ result: "pass", label: "본점이 부산에 소재한 기업" }), "reviewed"), "공고 원문");
console.log("grant overview condition rows: 6-state mapping, trust chip, evidence and source line passed");
