import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import type {
  ApplicationPipelineItem,
  ApplicationPipelineResult,
  ApplicationWritingStatus,
} from "@/lib/server/applications/pipeline";
import { ApplicationPipelineView, orderPipelineItems } from "./ApplicationPipelineView";
import { needsFileSave, primaryAction } from "./ApplicationDocumentCard";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

// ConversionPollTrigger는 next/navigation useRouter를 쓰므로 SSR 렌더에 라우터 컨텍스트를 끼운다.
const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

// 2026-10-01 18:00 KST — "오늘 HH:mm" 판정 기준.
const GENERATED_AT = "2026-10-01T09:00:00.000Z";

function makeWriting(overrides: {
  eligibility?: Partial<ApplicationWritingStatus["eligibility"]>;
  capability?: Partial<ApplicationWritingStatus["capability"]>;
  completion?: Partial<ApplicationWritingStatus["completion"]>;
} = {}): ApplicationWritingStatus {
  return {
    eligibility: { confirmed: 4, total: 7, remaining: 3, mismatched: 0, ...overrides.eligibility },
    capability: {
      originalEdit: true,
      originalFormat: "hwpx",
      autofill: { bound: 12, total: 37 },
      sectionDrafting: true,
      ...overrides.capability,
    },
    completion: {
      sectionsWritten: 3,
      sectionsTotal: null,
      factsToReview: 2,
      lastSavedAt: "2026-10-01T09:06:00.000Z",
      savedCount: 2,
      closed: false,
      ...overrides.completion,
    },
  };
}

function makeItem(overrides: Partial<ApplicationPipelineItem> & Pick<ApplicationPipelineItem, "grantId" | "title">): ApplicationPipelineItem {
  return {
    agency: "부산경제진흥원",
    fitScore: null,
    eligibility: "conditional",
    dDay: 9,
    applyEnd: "2026-10-10T00:00:00.000Z",
    supportLabel: "금액 미확인",
    stage: "preparing",
    stageLabel: "준비",
    lastActionAt: null,
    draftCount: 1,
    reviewedDraftCount: 0,
    warningCount: 0,
    detailHref: `/grants/${overrides.grantId}`,
    nextAction: "",
    assigneeName: null,
    reminderAt: null,
    outcomeNote: null,
    ...overrides,
  };
}

const savedItem = makeItem({
  grantId: "g-saved",
  title: "부산 청년기업 스케일업",
  writing: makeWriting(),
});

const unsavedItem = makeItem({
  grantId: "g-unsaved",
  title: "창업도약패키지",
  agency: "창업진흥원",
  dDay: 12,
  stage: "saved",
  stageLabel: "저장",
  draftCount: 0,
  writing: makeWriting({
    eligibility: { confirmed: 5, total: 5, remaining: 0, mismatched: 0 },
    capability: { originalFormat: "hwp", autofill: null },
    completion: { sectionsWritten: 0, factsToReview: 0, lastSavedAt: null, savedCount: 0 },
  }),
});

const closedItem = makeItem({
  grantId: "g-closed",
  title: "2026 상반기 소상공인 스마트화",
  agency: null,
  dDay: -16,
  applyEnd: "2026-09-15T00:00:00.000Z",
  writing: makeWriting({
    completion: { sectionsWritten: 4, factsToReview: 0, lastSavedAt: "2026-09-10T03:00:00.000Z", savedCount: 3, closed: true },
  }),
});

const submittedItem = makeItem({
  grantId: "g-submitted",
  title: "스마트상점 기술보급",
  agency: "소상공인시장진흥공단",
  stage: "submitted",
  stageLabel: "제출",
  writing: makeWriting({ eligibility: { confirmed: 4, total: 6, remaining: 2 } }),
});

const legacyItem = makeItem({
  grantId: "g-legacy",
  title: "구 데이터 공고",
  stage: "recommended",
  stageLabel: "추천",
  draftCount: 0,
});

const needsSaveItem = makeItem({
  grantId: "g-needs-save",
  title: "문안만 저장한 공고",
  writing: makeWriting({
    completion: { sectionsWritten: 2, savedCount: 0, lastSavedAt: "2026-09-28T02:00:00.000Z" },
  }),
});

const dismissedItem = makeItem({
  grantId: "g-dismissed",
  title: "보류한 공고",
  stage: "dismissed",
  stageLabel: "보류",
  writing: makeWriting(),
});

function render(items: ApplicationPipelineItem[]): string {
  const pipeline: ApplicationPipelineResult = {
    generatedAt: GENERATED_AT,
    stats: { recommended: 0, saved: 0, preparing: 0, submitted: 0, selected: 0, rejected: 0, blocked: 0, dismissed: 0 },
    items,
  };
  return renderToStaticMarkup(
    <AppRouterContext.Provider value={router}>
      <ApplicationPipelineView pipeline={pipeline} />
    </AppRouterContext.Provider>,
  );
}

function countOf(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

// ── 기본 장면 A: 카드 목록 ──────────────────────────────────────────────
// 보류 항목을 맨 앞에 두어 그룹 순서(진행 중 → 결과 대기 → 종료)로 재정렬되는지도 함께 본다.
const html = render([dismissedItem, savedItem, unsavedItem, closedItem, submittedItem, legacyItem, needsSaveItem]);

// 헤더
assert.ok(html.includes("<h1"), "h1이 있어야 한다");
assert.ok(html.includes(">신청 관리</h1>"));
assert.ok(html.includes("작성 중인 문서로 돌아가는 곳이에요 · 후보 순위가 바뀌어도 여기 목록은 유지돼요"));
assert.ok(html.includes("캘린더로 보기"));

// 그룹 헤더 없음 — 세로 스택 하나
assert.ok(!html.includes("<h2"), "그룹 헤더(h2)가 없어야 한다");
assert.ok(!html.includes("application-group-"));
assert.ok(!html.includes("진행 중 ("));
assert.ok(!html.includes("결과 대기 ("));
assert.ok(!html.includes("종료 ("));
assert.ok(!html.includes("인 신청이 없습니다"));

// 카드마다 3열 라벨
assert.equal(countOf(html, ">자격 확인</dt>"), 7);
assert.equal(countOf(html, ">작성 기능</dt>"), 7);
assert.equal(countOf(html, ">문서 완성</dt>"), 7);

// 저장본 있음 → 문서 열기
assert.ok(html.includes("확인된 조건 4/7 · 남은 쟁점 3"));
assert.ok(html.includes("항목 자동 반영 12/37 위치 확인"));
assert.ok(html.includes("문안 제안"));
assert.ok(html.includes("작성한 문항 3 · 검토할 사실 2"));
assert.ok(html.includes("마지막 서버 저장 오늘 18:06"));
assert.ok(html.includes("원본 HWPX"));
assert.ok(html.includes(">D-9</span>"));
assert.ok(html.includes('href="/grants/g-saved/workspace"'));
assert.ok(html.includes(">문서 열기</a>"));

// 저장본 없음 → 작성 시작(민트) + 양식 준비 대기 + 대기 양식 준비 요청(ConversionPollTrigger)
assert.ok(html.includes("확인된 조건 5/5 · 남은 쟁점 0"));
assert.ok(html.includes("필수 조건 확인 완료"));
assert.ok(html.includes("항목 자동 반영 미연결(양식 준비 대기)"));
assert.ok(html.includes("저장본 없음"));
assert.ok(html.includes("원본 HWP<"));
assert.ok(html.includes(">작성 시작</a>"));
assert.ok(html.includes("bg-brand-mint-ink"), "작성 시작 버튼은 민트 토큰을 쓴다");
assert.equal(countOf(html, "대기 양식 준비 요청"), 1, "저장본 없고 자동 반영 미연결인 카드에만 준비 요청이 붙는다");

// 마감 + 저장본 → 저장본 열기(outline) + 마감 뱃지 + 캡션
assert.ok(html.includes("마감 9/15"));
assert.ok(html.includes("마감 공고 · 새 후보에서 제외"));
assert.ok(html.includes("내보내기"));
assert.ok(html.includes("작성한 문항 4 · 저장 9월 10일"));
assert.ok(html.includes(">저장본 열기</a>"));
assert.equal(countOf(html, "마감된 공고의 저장본은 열고 내보낼 수 있어요"), 1);
assert.ok(html.includes("opacity-60"), "마감 카드는 card-dim 처리");

// 결과 대기 항목: 메타 줄에 상태 문구, 주 버튼은 결과 입력(대화상자)
assert.ok(html.includes("제출 완료 · 결과 대기"));
assert.ok(html.includes(">결과 입력</button>"));

// 종료(보류) 항목: 상태 문구 + 상세 보기
assert.ok(html.includes(">보류</span>"));
assert.ok(html.includes(">상세 보기</a>"));

// 진행 중 항목에는 예전 "서류 N/M 확인"·"저장됨" 상태 문구를 붙이지 않는다
assert.ok(!html.includes("서류 0/1 확인"));
assert.ok(!html.includes(">저장됨<"));

// writing 없는 구 데이터 → 정보 없음 ×3
assert.equal(countOf(html, ">정보 없음</span>"), 3);

// 문안만 저장(파일 저장본 없음) → 파일 미반영 뱃지
assert.equal(countOf(html, ">파일 미반영</span>"), 1);
assert.ok(html.includes("text-warning-strong"));

// 하단 고지 + 링크, 기존 푸터 링크 유지
assert.ok(html.includes("문항 완전성이 확인되지 않은 문서에는 완료율을 표시하지 않아요. 다운로드는 제출 완료가 아닙니다."));
assert.ok(html.includes("기회 맵에서 공고 더 보기 →"));
assert.ok(html.includes("리포트 내려받기"));

// 금지 어휘·백분율 없음
for (const banned of ["지원 가능", "매칭률", "선정 확률", "100% 완료", "자동으로 완성", "%"]) {
  assert.ok(!html.includes(banned), `금지 어휘 ${banned}`);
}

// 정렬: 보류(종료)는 진행 중·결과 대기 뒤로
assert.ok(html.indexOf("부산 청년기업 스케일업") < html.indexOf("스마트상점 기술보급"));
assert.ok(html.indexOf("스마트상점 기술보급") < html.indexOf("보류한 공고"));
assert.deepEqual(
  orderPipelineItems([dismissedItem, submittedItem, savedItem, unsavedItem]).map((item) => item.grantId),
  ["g-saved", "g-unsaved", "g-submitted", "g-dismissed"],
);

// ── 장면 B: 빈 상태 ─────────────────────────────────────────────────────
const emptyHtml = render([]);
assert.ok(emptyHtml.includes("아직 작성 중인 문서가 없어요"));
assert.ok(emptyHtml.includes("기회 맵에서 공고를 고르거나 공고 링크로 시작하세요"));
assert.ok(emptyHtml.includes(">기회 맵으로</a>"));
assert.ok(!emptyHtml.includes("자격 확인"));
assert.ok(!emptyHtml.includes("완료율을 표시하지 않아요"), "빈 상태에는 하단 고지를 두지 않는다");

// ── 순수 함수 ───────────────────────────────────────────────────────────
assert.deepEqual(primaryAction(savedItem), { kind: "link", href: "/grants/g-saved/workspace", label: "문서 열기", tone: "primary" });
assert.deepEqual(primaryAction(unsavedItem), { kind: "link", href: "/grants/g-unsaved/workspace", label: "작성 시작", tone: "mint" });
assert.deepEqual(primaryAction(closedItem), { kind: "link", href: "/grants/g-closed/workspace", label: "저장본 열기", tone: "outline" });
assert.deepEqual(primaryAction(submittedItem), { kind: "dialog", label: "결과 입력", tone: "outline" });
assert.equal(needsFileSave(makeWriting()), false);
assert.equal(needsFileSave(makeWriting({ completion: { savedCount: 0 } })), true);
assert.equal(needsFileSave(makeWriting({ capability: { originalEdit: false }, completion: { savedCount: 0 } })), false);

console.log("application pipeline view: design-02 document cards, CTA branches, closed caption, empty state, no group headers passed");
