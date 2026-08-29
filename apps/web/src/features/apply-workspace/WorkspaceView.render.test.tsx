import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AppRouterContext,
  type AppRouterInstance,
} from "next/dist/shared/lib/app-router-context.shared-runtime";
import type { WorkspaceData } from "@/lib/server/documents/workspaceData";

(globalThis as typeof globalThis & { React: typeof React }).React = React;

const { WorkspaceView } = await import("./WorkspaceView");

const DATABASE_GRANT_ID = "00000000-0000-4000-8000-000000000001";
const DRAFT_ID = "00000000-0000-4000-8000-000000000002";
const SURFACE_ID = "00000000-0000-4000-8000-000000000003";
const ARTIFACT_ID = "00000000-0000-4000-8000-000000000004";
const PAGE_KEY = "grant-convert/source/id/page-1.png";

const ATOMIC_FIELD = {
  fieldId: "field-name",
  fieldKey: "company_name",
  label: "상호명",
  anchorLabel: "업체명",
  guidance: "사업자등록증의 상호를 원문 기준으로 적습니다.",
  section: "기업 현황",
  fieldType: "text",
  required: true,
  sourceSpan: null,
  mappedCompanyField: "name",
  fillStrategy: "copy",
  position: { page: 1, bbox: [0.1, 0.1, 0.4, 0.15] },
  visualEvidence: null,
} satisfies WorkspaceData["connectedFields"][number];

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

const data: WorkspaceData = {
  execution: { mode: "persistent" },
  documentAgentAvailable: true,
  fieldEditorAgentAvailable: true,
  ladder: "a",
  activeDocumentKey: "application_form::신청서::::0",
  documents: [{
    documentKey: "application_form::신청서::::0",
    label: "신청서",
    hwpxTemplateAvailable: true,
  }],
  draftId: DRAFT_ID,
  headRevision: null,
  hwpxTemplateAvailable: true,
  connectedFields: [ATOMIC_FIELD],
  fieldAnswers: {},
  duplicateLabels: [],
  suggestableLabels: [],
  fieldLessonTips: null,
  pages: [{
    artifactId: ARTIFACT_ID,
    surfaceId: SURFACE_ID,
    page: 1,
    storageKey: PAGE_KEY,
    width: 1_000,
    height: 1_400,
    dpi: 220,
  }],
  grant: {
    id: DATABASE_GRANT_ID,
    title: "지원서 작성 도우미 테스트",
    agency: null,
    status: "open",
  },
  missingFields: [],
  prep: {
    autoSubmitSupported: false,
    profileCopyFields: [],
    planDraftPrompts: [],
    documentGroups: [],
    draftableDocuments: [],
    issuableDocuments: [],
    attachableDocuments: [],
    missingProfileFields: [],
    draftCoverage: {
      totalDocuments: 0,
      draftableCount: 0,
      issuableCount: 0,
      attachableCount: 0,
      otherCount: 0,
      withAttachmentContextCount: 0,
      missingFieldCount: 0,
    },
  },
  initialDrafts: [],
  pollConversion: false,
  honestNotice: null,
};

const html = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <WorkspaceView
      data={data}
      greeting={{ text: "지원서 작성을 도와드릴게요.", generalNotice: true }}
      institutionContact={null}
    />
  </AppRouterContext.Provider>,
);

const previewHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <WorkspaceView
      data={{ ...data, draftId: null, documentAgentAvailable: false, fieldEditorAgentAvailable: false }}
      greeting={{ text: "지원서 작성을 도와드릴게요.", generalNotice: true }}
      institutionContact={null}
    />
  </AppRouterContext.Provider>,
);
assert.equal(
  previewHtml.includes("page-image"),
  false,
  "RHWP 원본 연결이 끊긴 경우 폐기한 페이지 이미지 기반 작성 화면으로 돌아가면 안 됩니다.",
);
assert.ok(previewHtml.includes("RHWP 문서를 준비하지 못했습니다."));
assert.equal(previewHtml.includes("빠른 작성"), false);

// 재정의(2026-07-15): 내부 사다리 어휘 뱃지(LADDER_BADGE)는 화면에 노출하지 않는다.
for (const ladderWord of ["원본 양식 채움", "필드 분석 중", "채팅으로 안내"]) {
  assert.equal(html.includes(ladderWord), false, `사다리 어휘 "${ladderWord}"가 화면에 노출되면 안 됩니다.`);
}
// 상시 하단 바(WorkspaceFooter)는 제거됐다 — 기본 다운로드 버튼 라벨이 화면에 있으면 안 된다.
assert.equal(html.includes("HWPX 다운로드"), false, "상시 하단 다운로드 바가 제거돼야 합니다.");
// 상단 바 back 링크는 "공고 요약"으로 노출된다.
assert.ok(html.includes("공고 요약"), "상단 바에 '공고 요약' 링크가 있어야 합니다.");
assert.ok(
  html.includes("문서 직접 편집기") && html.includes("AI 작성 가이드"),
  "지원 가능한 persistent draft는 RHWP 편집기와 AI 작성 가이드를 동시에 보여야 합니다.",
);
assert.ok(html.includes("data-field-aware-editor"), "통합 편집 세션 식별자가 있어야 합니다.");
assert.ok(html.includes("AI 작성 가이드"), "작은 화면에서 작성 가이드를 여는 고정 진입점이 있어야 합니다.");
assert.ok(
  html.includes("작성 도우미") && html.includes("필드 목록"),
  "필드 인덱스는 작성 도우미와 분리된 메뉴로 제공해야 합니다.",
);
assert.ok(
  html.includes("지금 저장") && html.includes("편집본 다운로드"),
  "통합 편집 화면의 문서 저장 동작은 AI 사이드바에서 제공해야 합니다.",
);
assert.ok(
  html.includes("등록정보로 일괄 채우기"),
  "persistent 문서 사이드바에서 등록정보 일괄 입력 진입점을 제공해야 합니다.",
);
assert.ok(
  html.includes("일정표 자동 구성"),
  "persistent 문서 사이드바에서 승인형 일정표 자동 구성 진입점을 제공해야 합니다.",
);
assert.equal(html.includes("max-h-48"), false, "필드 인덱스가 작성 도우미 공간을 상시 차지하면 안 됩니다.");
assert.ok(
  html.includes("flex h-full min-h-0 max-h-full flex-col overflow-hidden"),
  "AI 필드 레일은 부모 높이를 넘지 않고 내부 스크롤 영역을 유지해야 합니다.",
);
assert.ok(
  html.includes("h-full min-h-0 overscroll-contain"),
  "긴 AI 제안은 레일 내부 ScrollArea에서 독립적으로 스크롤돼야 합니다.",
);
assert.ok(
  html.includes('data-variant="workspace"'),
  "AI 필드 레일은 작업공간 전용 카드 경계를 사용해야 합니다.",
);
assert.ok(
  html.includes("data-[variant=workspace]:border data-[variant=workspace]:border-border")
    && html.includes("data-[variant=workspace]:shadow-none"),
  "AI 필드 레일은 배경이 비치거나 두꺼워 보이지 않는 단일 테두리를 사용해야 합니다.",
);
assert.ok(
  html.includes("border-[1.5px] border-input"),
  "문서 편집기는 작업공간 카드와 같은 명확한 경계를 사용해야 합니다.",
);
assert.equal(html.includes('aria-label="문서 작성 방식"'), false, "통합 편집 화면에 quick/studio 주 모드 토글이 있으면 안 됩니다.");
assert.equal(html.includes("AI 작성 제안"), false, "일반 본문 문단 에이전트가 필드 에이전트 주 CTA로 노출되면 안 됩니다.");

const integratedNoticeHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <WorkspaceView
      data={{
        ...data,
        honestNotice: "빠른 작성에는 위치를 안전하게 확정한 항목만 표시합니다.",
      }}
      greeting={{ text: "지원서 작성을 도와드릴게요.", generalNotice: true }}
      institutionContact={null}
    />
  </AppRouterContext.Provider>,
);
assert.equal(
  integratedNoticeHtml.includes("빠른 작성에는 위치를 안전하게 확정한 항목만 표시합니다."),
  false,
  "통합 문서 편집 화면에는 폐기한 빠른 작성 안내를 노출하면 안 됩니다.",
);

// 필드 연결이 없어도 선분석을 기다리지 않고 RHWP 직접 편집으로 이어져야 한다.
const directRhwpHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <WorkspaceView
      data={{
        ...data,
        ladder: "b",
        connectedFields: [],
        honestNotice: null,
      }}
      greeting={{ text: "지원서 작성을 도와드릴게요.", generalNotice: true }}
      institutionContact={null}
    />
  </AppRouterContext.Provider>,
);
assert.equal(directRhwpHtml.includes("작성 항목을 분석하고 있습니다"), false);
assert.ok(directRhwpHtml.includes("data-document-guided-editor"));
assert.ok(directRhwpHtml.includes("문서 직접 편집기"));
assert.ok(directRhwpHtml.includes("AI 작성 가이드"));
assert.equal(directRhwpHtml.includes('aria-label="문서 작성 방식"'), false);
assert.equal(directRhwpHtml.includes("빠른 작성"), false);

// 반복 표는 textarea로 축약하지 않고 통합 Studio의 수동 편집 과제로 유지한다.
const studioHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <WorkspaceView
      data={{
        ...data,
        connectedFields: [{
          fieldId: "field-career",
          fieldKey: "applicant.career_rows",
          label: "경력사항",
          section: "신청자",
          fieldType: "table",
          required: false,
          sourceSpan: "입사연월 | 퇴사연월 | 근무처 | 업무분야",
          mappedCompanyField: null,
          fillStrategy: "ask_user",
          position: { page: 1, bbox: [0.1, 0.3, 0.8, 0.5] },
          visualEvidence: null,
        }],
      }}
      greeting={{ text: "지원서 작성을 도와드릴게요.", generalNotice: true }}
      institutionContact={null}
    />
  </AppRouterContext.Provider>,
);
assert.ok(studioHtml.includes("직접 편집 대상으로 유지"), "반복 표는 Studio 직접 편집 대상으로 안내해야 합니다.");
assert.ok(studioHtml.includes("AI 작성 가이드"), "반복 표도 통합 작성 가이드 레일에서 상태를 보여야 합니다.");
assert.equal(studioHtml.includes('aria-label="문서 작성 방식"'), false, "반복 표도 quick/studio 주 모드 토글로 돌아가면 안 됩니다.");
assert.equal(studioHtml.includes("<textarea"), false, "반복 표를 textarea로 축약하면 안 됩니다.");

const virtualHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <WorkspaceView
      data={{
        ...data,
        execution: {
          mode: "virtual_preview",
          bizNo: "0000000001",
          companyName: "창업노트 가상기업 — 충남 장애인기업",
        },
        draftId: null,
        connectedFields: [ATOMIC_FIELD],
      }}
      greeting={{ text: "지원서 작성을 도와드릴게요.", generalNotice: true }}
      institutionContact={null}
    />
  </AppRouterContext.Provider>,
);
assert.ok(virtualHtml.includes("가상 기업 RHWP 작성 미리보기"), "가상 기업 workspace임을 명확히 안내해야 합니다.");
assert.ok(virtualHtml.includes("실제 회사·초안에는 저장되지 않습니다"), "비영속 저장 경계를 안내해야 합니다.");
assert.ok(virtualHtml.includes("biz=0000000001"), "페이지 이미지와 돌아가기 링크에 가상 기업 범위를 유지해야 합니다.");
assert.ok(virtualHtml.includes("문서 직접 편집기"), "가상 기업 목표 공고의 RHWP 편집기를 바로 보여야 합니다.");
assert.ok(virtualHtml.includes("AI 작성 가이드"), "가상 기업 미리보기도 목표 구조의 우측 레일을 보여야 합니다.");
assert.ok(virtualHtml.includes("data-field-aware-editor"), "가상 기업 미리보기도 선분석 필드의 RHWP 위치 인식을 사용해야 합니다.");
assert.ok(virtualHtml.includes("이 탭에 반영"), "비영속 미리보기 저장 동작을 서버 저장처럼 표시하면 안 됩니다.");
assert.equal(virtualHtml.includes("지금 저장"), false, "비영속 미리보기에는 영속 저장 라벨이 없어야 합니다.");
assert.equal(virtualHtml.includes("빠른 작성"), false, "가상 기업 미리보기에 폐기한 빠른 작성 모드가 있으면 안 됩니다.");

const adminPreviewHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <WorkspaceView
      data={{
        ...data,
        execution: {
          mode: "admin_preview",
          companyName: "관리자 지원서 시뮬레이션 기업",
          reviewerEmail: "admin@noten.im",
        },
        draftId: null,
        connectedFields: [ATOMIC_FIELD],
      }}
      greeting={{ text: "지원서 작성을 도와드릴게요.", generalNotice: true }}
      institutionContact={null}
    />
  </AppRouterContext.Provider>,
);
assert.ok(adminPreviewHtml.includes("관리자 RHWP 작성 시뮬레이션"), "관리자 시뮬레이션 경계를 안내해야 합니다.");
assert.ok(adminPreviewHtml.includes("실제 회사·초안에는 저장되지 않습니다"), "관리자 시뮬레이션의 비영속 경계를 안내해야 합니다.");
assert.ok(adminPreviewHtml.includes("adminPreview=1"), "페이지 이미지와 돌아가기 링크에 관리자 시뮬레이션 범위를 유지해야 합니다.");
assert.equal(adminPreviewHtml.includes("가상 기업 미리보기 완료"), false, "관리자 시뮬레이션을 가상 기업으로 표시하면 안 됩니다.");
assert.ok(adminPreviewHtml.includes("문서 직접 편집기") && adminPreviewHtml.includes("AI 작성 가이드"));
assert.ok(adminPreviewHtml.includes("data-field-aware-editor"), "관리자 시뮬레이션도 선분석 필드의 RHWP 위치 인식을 사용해야 합니다.");
assert.ok(adminPreviewHtml.includes("상호명"), "관리자 시뮬레이션 사이드바에 인식된 필드가 보여야 합니다.");
assert.ok(
  adminPreviewHtml.includes("작성 기준")
    && adminPreviewHtml.includes("사업자등록증의 상호를 원문 기준으로 적습니다."),
  "LLM 실행이 꺼진 관리자 시뮬레이션에서도 선분석 작성 가이드를 보여야 합니다.",
);
assert.ok(adminPreviewHtml.includes("읽기 전용 시뮬레이션에서는 LLM 제안을 실행하지 않습니다"));
assert.ok(adminPreviewHtml.includes("이 탭에 반영"), "관리자 시뮬레이션의 저장 범위를 현재 탭으로 표시해야 합니다.");
assert.equal(adminPreviewHtml.includes("지금 저장"), false, "관리자 시뮬레이션에는 영속 저장 라벨이 없어야 합니다.");
assert.equal(adminPreviewHtml.includes("빠른 작성"), false, "관리자 시뮬레이션에 폐기한 빠른 작성 모드가 있으면 안 됩니다.");

const adminPendingHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <WorkspaceView
      data={{
        ...data,
        execution: {
          mode: "admin_preview",
          companyName: "관리자 지원서 시뮬레이션 기업",
          reviewerEmail: "admin@noten.im",
        },
        ladder: "b",
        connectedFields: [],
      }}
      greeting={{ text: "지원서 작성을 도와드릴게요.", generalNotice: true }}
      institutionContact={null}
    />
  </AppRouterContext.Provider>,
);
assert.equal(
  adminPendingHtml.includes("작성 항목을 분석하고 있습니다"),
  false,
  "읽기 전용 관리 화면은 실행 중인 분석이 없는데 무한 분석 중으로 표시하면 안 됩니다.",
);
assert.ok(adminPendingHtml.includes("data-document-guided-editor"));
assert.ok(adminPendingHtml.includes("문서 직접 편집기"));
assert.ok(adminPendingHtml.includes("AI 작성 가이드"));
assert.equal(adminPendingHtml.includes("빠른 작성"), false);

console.log("WorkspaceView grant UUID render regression passed");
