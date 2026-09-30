import assert from "node:assert/strict";
import { test } from "node:test";
import type { RuleTraceChip } from "@cunote/contracts";
import { buildWritingStatus, type WritingStatusDraftInput } from "./pipeline";

function chip(kind: RuleTraceChip["kind"], result: RuleTraceChip["result"]): RuleTraceChip {
  return {
    dimension: "region",
    kind,
    result,
    label: `${kind}:${result}`,
    checklistSection: result === "pass" ? "satisfied" : "needs_check",
  };
}

function draft(overrides: Partial<WritingStatusDraftInput> = {}): WritingStatusDraftInput {
  return {
    sourceAttachment: null,
    fieldAnswers: null,
    filledFieldCount: 0,
    missingFieldCount: 0,
    warningCount: 0,
    draftUpdatedAt: null,
    sectionsWritten: 0,
    sectionsUpdatedAt: null,
    savedCount: 0,
    lastSavedAt: null,
    ...overrides,
  };
}

const sixHardConditions = [
  chip("required", "pass"),
  chip("required", "pass"),
  chip("required", "pass"),
  chip("exclusion", "pass"),
  chip("required", "pass"),
  chip("required", "unknown"),
  // 우대·평가 항목은 자격 판정 분모에 들어가면 안 된다.
  chip("preferred", "unknown"),
  chip("preferred", "pass"),
];

test("빈 draft: 자격 집계만 있고 작성 기능·저장본은 비어 있다", () => {
  const status = buildWritingStatus({
    ruleTrace: sixHardConditions,
    drafts: [],
    dDay: 9,
    writeSupport: "ai_draft",
    sectionDraftingEnabled: true,
  });
  assert.deepEqual(status.eligibility, { confirmed: 5, total: 6, remaining: 1, mismatched: 0 });
  assert.equal(status.capability.originalEdit, false, "ai_draft만으로 원본 편집을 약속하지 않는다");
  assert.equal(status.capability.originalFormat, null);
  assert.equal(status.capability.autofill, null);
  assert.equal(status.capability.sectionDrafting, false, "초안이 없으면 문안 제안 대상 문서도 없다");
  assert.deepEqual(status.completion, {
    sectionsWritten: 0,
    sectionsTotal: null,
    factsToReview: 0,
    lastSavedAt: null,
    savedCount: 0,
    closed: false,
  });
});

test("hwpx 원본 draft: 원본 편집·자동 반영 근사치·문안·저장본을 집계한다", () => {
  const status = buildWritingStatus({
    ruleTrace: sixHardConditions,
    drafts: [draft({
      sourceAttachment: "2026 신청서 양식.HWPX",
      fieldAnswers: {
        "기업명": { status: "accepted", fieldId: "f-1" },
        "대표자": { status: "suggested", fieldId: "f-2" },
        "사업자등록번호": { status: "edited" },
        "무시된 항목": { status: "dismissed", fieldId: "f-9" },
      },
      filledFieldCount: 2,
      missingFieldCount: 1,
      warningCount: 1,
      draftUpdatedAt: "2026-09-20T01:00:00.000Z",
      sectionsWritten: 3,
      sectionsUpdatedAt: "2026-09-30T05:12:00.000Z",
      savedCount: 2,
      lastSavedAt: "2026-09-29T09:00:00.000Z",
    })],
    dDay: 12,
    writeSupport: "template_fill",
    sectionDraftingEnabled: true,
  });
  assert.equal(status.capability.originalEdit, true);
  assert.equal(status.capability.originalFormat, "hwpx", "확장자 대소문자와 공백을 무시하고 판정한다");
  assert.deepEqual(
    status.capability.autofill,
    { bound: 2, total: 4 },
    "dismissed 제외 답변 3 + 미입력 1 = 4, 그중 fieldId 결속 2",
  );
  assert.equal(status.capability.sectionDrafting, true);
  assert.equal(status.completion.sectionsWritten, 3);
  assert.equal(status.completion.sectionsTotal, null, "문항 완전성이 확인되기 전에는 분모를 만들지 않는다");
  assert.equal(status.completion.factsToReview, 2, "경고 1 + 미입력 1");
  assert.equal(status.completion.savedCount, 2);
  assert.equal(status.completion.lastSavedAt, "2026-09-30T05:12:00.000Z", "문안 저장이 스튜디오 저장본보다 늦으면 그 시각이 마지막 저장이다");
  assert.equal(status.completion.closed, false);
});

test("마감 공고: closed 플래그와 명백한 불일치 수를 함께 싣는다", () => {
  const status = buildWritingStatus({
    ruleTrace: [chip("required", "pass"), chip("exclusion", "fail"), chip("required", "text_only")],
    drafts: [draft({
      sourceAttachment: "참여신청서.hwp",
      fieldAnswers: {},
      draftUpdatedAt: "2026-09-10T02:00:00.000Z",
      sectionsWritten: 4,
      sectionsUpdatedAt: "2026-09-10T02:30:00.000Z",
      savedCount: 1,
      lastSavedAt: "2026-09-10T02:20:00.000Z",
    })],
    dDay: -15,
    writeSupport: null,
    sectionDraftingEnabled: false,
  });
  assert.equal(status.completion.closed, true);
  assert.deepEqual(status.eligibility, { confirmed: 1, total: 3, remaining: 1, mismatched: 1 });
  assert.equal(status.capability.originalEdit, true);
  assert.equal(status.capability.originalFormat, "hwp");
  assert.equal(status.capability.autofill, null, "답변·미입력이 없으면 자동 반영 비율을 만들지 않는다");
  assert.equal(status.capability.sectionDrafting, false, "플래그가 꺼져 있으면 문안 제안을 표기하지 않는다");
  assert.equal(status.completion.lastSavedAt, "2026-09-10T02:30:00.000Z");
});

test("저장본 없음: 미백필 draft는 filledFields 수로 폴백하고 저장본 수는 0이다", () => {
  const status = buildWritingStatus({
    ruleTrace: [],
    drafts: [draft({
      sourceAttachment: "사업계획서.hwpx",
      fieldAnswers: null,
      filledFieldCount: 5,
      missingFieldCount: 3,
      warningCount: 2,
      draftUpdatedAt: "2026-09-28T00:00:00.000Z",
    })],
    dDay: 45,
    writeSupport: "manual_form",
    sectionDraftingEnabled: true,
  });
  assert.deepEqual(status.eligibility, { confirmed: 0, total: 0, remaining: 0, mismatched: 0 });
  assert.deepEqual(status.capability.autofill, { bound: 0, total: 8 }, "fieldAnswers 미백필이면 결속 수는 0으로 둔다");
  assert.equal(status.completion.savedCount, 0);
  assert.equal(status.completion.sectionsWritten, 0);
  assert.equal(status.completion.factsToReview, 5);
  assert.equal(status.completion.lastSavedAt, "2026-09-28T00:00:00.000Z", "초안 행 갱신도 서버 저장 시각이다");
});

test("초안 없는 매칭: writeSupport가 원본 서식을 보장할 때만 원본 편집을 켠다", () => {
  const manual = buildWritingStatus({ ruleTrace: null, drafts: [], dDay: null, writeSupport: "manual_form", sectionDraftingEnabled: true });
  assert.equal(manual.capability.originalEdit, true);
  assert.equal(manual.capability.originalFormat, "hwpx");
  assert.equal(manual.capability.autofill, null, "서식은 있으나 항목 결속 정보가 없으면 양식 준비 대기로 둔다");
  assert.equal(manual.completion.closed, false, "마감일을 모르면 마감으로 취급하지 않는다");

  const webForm = buildWritingStatus({ ruleTrace: null, drafts: [], dDay: 3, writeSupport: "web_form_guide", sectionDraftingEnabled: true });
  assert.equal(webForm.capability.originalEdit, false);
  assert.equal(webForm.capability.originalFormat, null);
});

test("여러 초안: 저장본·문안·검토 사실은 합산하고 pdf 초안은 자동 반영 분모에서 제외한다", () => {
  const status = buildWritingStatus({
    ruleTrace: [chip("required", "pass")],
    drafts: [
      draft({
        sourceAttachment: "신청서.hwpx",
        fieldAnswers: { "기업명": { status: "accepted", fieldId: "f-1" } },
        missingFieldCount: 1,
        sectionsWritten: 2,
        savedCount: 1,
        lastSavedAt: "2026-09-01T00:00:00.000Z",
      }),
      draft({
        sourceAttachment: "증빙.pdf",
        fieldAnswers: { "첨부": { status: "accepted", fieldId: "f-7" } },
        missingFieldCount: 4,
        warningCount: 1,
        sectionsWritten: 1,
        savedCount: 3,
        lastSavedAt: "2026-09-05T00:00:00.000Z",
      }),
    ],
    dDay: 0,
    writeSupport: "ai_draft",
    sectionDraftingEnabled: true,
  });
  assert.deepEqual(status.capability.autofill, { bound: 1, total: 2 });
  assert.equal(status.completion.sectionsWritten, 3);
  assert.equal(status.completion.savedCount, 4);
  assert.equal(status.completion.factsToReview, 6);
  assert.equal(status.completion.lastSavedAt, "2026-09-05T00:00:00.000Z");
  assert.equal(status.completion.closed, false, "D-Day 당일은 마감이 아니다");
});
