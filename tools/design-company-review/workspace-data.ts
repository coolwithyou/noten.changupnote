import type {WorkspaceData} from '../../apps/web/src/lib/server/documents/workspaceData';
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

export const workspaceData: WorkspaceData = {
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

