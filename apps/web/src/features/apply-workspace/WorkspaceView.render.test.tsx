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

const router: AppRouterInstance = {
  back() {},
  forward() {},
  refresh() {},
  push() {},
  replace() {},
  prefetch() {},
};

const data: WorkspaceData = {
  ladder: "a",
  activeDocumentKey: "application_form::신청서::::0",
  documents: [{
    documentKey: "application_form::신청서::::0",
    label: "신청서",
    hwpxTemplateAvailable: true,
  }],
  draftId: DRAFT_ID,
  hwpxTemplateAvailable: true,
  connectedFields: [],
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

const expectedImageUrl = `/api/web/grants/${DATABASE_GRANT_ID}/page-image/${PAGE_KEY}`;
assert.ok(
  html.includes(expectedImageUrl),
  `페이지 이미지는 DB grant UUID를 사용해야 합니다.\n${html.match(/src="[^"]*page-image[^"]*"/)?.[0] ?? "image missing"}`,
);
assert.equal(
  html.includes("bizinfo%253APBLN_TEST/page-image"),
  false,
  "인코딩된 공개 공고 ID를 다시 인코딩하면 안 됩니다.",
);

// 재정의(2026-07-15): 내부 사다리 어휘 뱃지(LADDER_BADGE)는 화면에 노출하지 않는다.
for (const ladderWord of ["원본 양식 채움", "필드 분석 중", "채팅으로 안내"]) {
  assert.equal(html.includes(ladderWord), false, `사다리 어휘 "${ladderWord}"가 화면에 노출되면 안 됩니다.`);
}
// 상시 하단 바(WorkspaceFooter)는 제거됐다 — 기본 다운로드 버튼 라벨이 화면에 있으면 안 된다.
assert.equal(html.includes("HWPX 다운로드"), false, "상시 하단 다운로드 바가 제거돼야 합니다.");
// 상단 바 back 링크는 "공고 요약"으로 노출된다.
assert.ok(html.includes("공고 요약"), "상단 바에 '공고 요약' 링크가 있어야 합니다.");

// 승인된 값은 프리뷰 오버레이 안에 실제 기입처럼 렌더돼야 한다.
const confirmedValue = "주식회사 창업노트";
const confirmedHtml = renderToStaticMarkup(
  <AppRouterContext.Provider value={router}>
    <WorkspaceView
      data={{
        ...data,
        // rhwp 모드는 클라이언트가 구조 앵커를 계산한 뒤 값을 얹는다. SSR에서 오버레이 값 계약을
        // 검증하는 이 케이스는 서버 이미지 폴백 경로를 사용한다.
        draftId: null,
        connectedFields: [{
          fieldId: "field-name",
          fieldKey: "company_name",
          label: "상호명",
          section: "기업 현황",
          fieldType: "text",
          required: true,
          sourceSpan: null,
          mappedCompanyField: "name",
          fillStrategy: "copy",
          position: { page: 1, bbox: [0.1, 0.1, 0.4, 0.15] },
          visualEvidence: null,
        }],
        fieldAnswers: {
          상호명: {
            value: confirmedValue,
            status: "accepted",
            source: "profile",
            updatedAt: "2026-07-15T00:00:00.000Z",
          },
        },
      }}
      greeting={{ text: "지원서 작성을 도와드릴게요.", generalNotice: true }}
      institutionContact={null}
    />
  </AppRouterContext.Provider>,
);
assert.ok(confirmedHtml.includes(confirmedValue), "승인된 값이 프리뷰 셀 오버레이에 보여야 합니다.");

console.log("WorkspaceView grant UUID render regression passed");
