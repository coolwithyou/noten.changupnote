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

console.log("WorkspaceView grant UUID render regression passed");
