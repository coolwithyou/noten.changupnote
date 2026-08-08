/**
 * 작성 도우미 workspace 서버 로더 (Apply Experience v2 · §4.3/§4.4/§6.3 · P2-5).
 *
 * 규범: docs/plans/2026-07-09-apply-experience-v2.md §4.3(IA)·§4.4(성능 저하 사다리)·§6.3(draft ensure).
 *
 * 선택된 문서(documentKey) 기준으로 사다리 (a)(b)(c) 판정 + draft ensure + 필드-문서 연결(surfaceId 우선)
 * + 프로필 시드(멱등) + label 충돌 감지 + fieldAnswers 해석 + lesson 팁을 한 번에 조립해 페이지에 반환한다.
 *
 * 사다리 판정은 DB 신호(`grant_application_surfaces.extractionStatus`)로 결정론적으로 계산한다.
 * fields_ready 인데 실제 연결 필드가 0건인 edge case 는 보수적으로 (b)로 낮춰 잡는다(§4.4 의도).
 */
import type {
  ApplicationPrep,
  ApplySheet,
  CompanyProfile,
  DocumentDraft,
  DraftableDocument,
  MissingFieldQuestion,
} from "@cunote/contracts";
import type { CompanyAccess } from "../auth/companyGuard";
import { matchFieldLessonTips, type FieldLessonTipsDto } from "../knowledge/lessonContext";
import {
  loadConnectedDocumentFields,
  resolveArchiveStorageKey,
  type ConnectedDocumentField,
} from "./documentFieldLink";
import { loadGrantDocumentPreview, type PreviewPage, type PreviewSurface } from "./documentPreview";
import { detectDuplicateNormalizedLabels, type DraftFieldAnswers } from "./fieldAnswers";
import { isLlmSuggestableLabel } from "./fieldSuggest";
import {
  createGrantDocumentDraft,
  linkGrantDocumentDraftSurface,
  listGrantDocumentDraftsForGrant,
  seedGrantDocumentDraftProfileAnswers,
} from "./grantDocumentDrafts";
import { getDraftRevisionHead } from "./documentRevisions";
import { seedProfileFieldAnswers, type SeedFieldInput } from "./seedProfileAnswers";
import { classifyApplicationFieldMap } from "./applicationFieldVersion";
import {
  loadSurfaceApplicationPrecomputeState,
  shouldRecoverApplicationPrecompute,
  type ApplicationPrecomputeStatus,
  type SurfaceApplicationPrecomputeState,
} from "./applicationPrecomputeState";

/** 성능 저하 사다리(§4.4): (a) 완전 경험 · (b) 프리뷰+필드 분석 중 · (c) 채팅 전면 폴백. */
export type WorkspaceLadder = "a" | "b" | "c";

export interface WorkspaceDocumentOption {
  documentKey: string;
  label: string;
  hwpxTemplateAvailable: boolean;
}

export interface WorkspaceGrantMeta {
  id: string;
  title: string;
  agency: string | null;
  status: string;
}

export type WorkspaceExecution =
  | { mode: "persistent" }
  | {
      mode: "virtual_preview";
      bizNo: string;
      companyName: string;
    };

export interface WorkspaceData {
  /** 저장 경계를 명시한다. virtual_preview는 브라우저 메모리 외의 write를 허용하지 않는다. */
  execution: WorkspaceExecution;
  ladder: WorkspaceLadder;
  /** 선택된 문서(draftableDocument.documentKey). draftable 문서가 없으면 null. */
  activeDocumentKey: string | null;
  /** 문서 선택 드롭다운 목록(draftableDocuments). */
  documents: WorkspaceDocumentOption[];
  /** 선택 문서의 ensure 된 draft id. 비-draftable(활성 문서 없음)이면 null. */
  draftId: string | null;
  /** Studio가 서버에 저장한 최신 작업 revision과 빠른 작성 materialize 상태. */
  headRevision: {
    revisionId: string;
    savedAt: string;
    materializedAnswers: Record<string, string>;
  } | null;
  hwpxTemplateAvailable: boolean;
  connectedFields: ConnectedDocumentField[];
  /** 초기 필드 답변(프로필 시드 반영 후). 키는 정규화 label. */
  fieldAnswers: DraftFieldAnswers;
  /** 정규화 label 충돌 원문 label 집합(직렬화 위해 배열). "동일 항목명 — 수동 확인 필요" 근거. */
  duplicateLabels: string[];
  /**
   * LLM 제안('제안 받기') 대상 원문 label 집합(P4). 서버 단일 원천 판정:
   * mappedCompanyField 없음(결정론 프로필 시드 대상 아님) + manual류(서명·직인·동의·첨부…) 아님(마스터 8.7).
   */
  suggestableLabels: string[];
  fieldLessonTips: FieldLessonTipsDto | null;
  /** 매칭 surface 의 페이지 이미지들(프리뷰 캔버스용). */
  pages: PreviewPage[];
  grant: WorkspaceGrantMeta;
  /** (b) 상태 질문 카드용 draft.missingFields. */
  missingFields: MissingFieldQuestion[];
  /** (c) 폴백 DraftFallbackEditor 용 전체 prep. */
  prep: ApplicationPrep;
  /** (c) 폴백 DraftFallbackEditor 용 기존 초안들. */
  initialDrafts: DocumentDraft[];
  /** pending surface 가 있어 변환 폴링을 마운트할지. */
  pollConversion: boolean;
  /** 성능 저하 또는 부분 필드 커버리지를 정직하게 고지하는 문구. */
  honestNotice: string | null;
  /** 현재 원본 SHA·계약 버전에 결속된 Kordoc 선분석의 종결 상태. */
  applicationPrecomputeStatus: ApplicationPrecomputeStatus | null;
  /** 작업공간 진입 분석은 선분석이 없거나 stale·materialization 누락일 때만 복구용으로 실행한다. */
  fieldAnalysisRecoveryNeeded: boolean;
}

const HWP_FAMILY_FORMATS = new Set(["hwp", "hwpx"]);
const UNSUPPORTED_FORMAT_NOTICE =
  "원본 양식 채움은 이 공고에서 지원되지 않습니다. 대신 채팅과 초안 편집기로 작성을 도와드릴게요.";

export async function loadGrantWorkspaceData(input: {
  sheet: ApplySheet;
  access: CompanyAccess;
  requestedDocumentKey?: string | null;
}): Promise<WorkspaceData> {
  const { sheet, access } = input;
  const grant: WorkspaceGrantMeta = {
    id: sheet.grant.id,
    title: sheet.grant.title,
    agency: sheet.grant.agency,
    status: sheet.grant.status,
  };
  const draftable = sheet.applicationPrep.draftableDocuments;
  const documents = buildWorkspaceDocumentOptions(draftable);

  const initialDraftsPromise = listGrantDocumentDraftsForGrant({ grantId: grant.id, access });

  // draftable 문서가 하나도 없으면 (c) 폴백(채팅 전면 + 빈 초안 워크스페이스).
  if (draftable.length === 0) {
    const initialDrafts = await initialDraftsPromise;
    return {
      execution: { mode: "persistent" },
      ladder: "c",
      activeDocumentKey: null,
      documents,
      draftId: null,
      headRevision: null,
      hwpxTemplateAvailable: false,
      connectedFields: [],
      fieldAnswers: {},
      duplicateLabels: [],
      suggestableLabels: [],
      fieldLessonTips: null,
      pages: [],
      grant,
      missingFields: [],
      prep: sheet.applicationPrep,
      initialDrafts,
      pollConversion: false,
      honestNotice: "이 공고에는 아직 작성형 서류가 없습니다. 채팅으로 먼저 물어보세요.",
      applicationPrecomputeStatus: null,
      fieldAnalysisRecoveryNeeded: false,
    };
  }

  const [initialDrafts, documentContext] = await Promise.all([
    initialDraftsPromise,
    loadWorkspaceDocumentContext({
      sheet,
      ...(input.requestedDocumentKey !== undefined
        ? { requestedDocumentKey: input.requestedDocumentKey }
        : {}),
    }),
  ]);
  const {
    activeDocument,
    connectedFields,
    matchedSurface,
    pages,
    pollConversion,
    applicationPrecomputeState,
  } = documentContext;

  // draft ensure(§6.3): documentKey 별 1행. 없으면 기존 생성 경로 재사용(빈 draft 발명 금지).
  const existingDraft = initialDrafts.find((draft) => draft.documentKey === activeDocument.documentKey);
  let activeDraft: DocumentDraft;
  if (existingDraft) {
    activeDraft = existingDraft;
  } else {
    const created = await createGrantDocumentDraft({
      grantId: grant.id,
      access,
      request: { documentKey: activeDocument.documentKey },
    });
    activeDraft = created.draft;
  }
  const draftId = activeDraft.id;
  const surfaceLinkPromise = matchedSurface && activeDocument.sourceAttachment
    ? linkGrantDocumentDraftSurface({
      draftId,
      access,
      surfaceId: matchedSurface.id,
      sourceAttachment: activeDocument.sourceAttachment,
    })
    : Promise.resolve({ linked: false });

  // 프로필 시드(멱등). 시드 결과의 fieldAnswers 를 초기 상태로 쓴다(연결 필드 없으면 현재 답변 그대로).
  const seedFields: SeedFieldInput[] = connectedFields.map((field) => ({
    label: field.label,
    mappedCompanyField: field.mappedCompanyField,
    fieldId: field.fieldId,
  }));
  const { duplicateLabels } = detectDuplicateNormalizedLabels(connectedFields.map((field) => field.label));

  // '제안 받기' 노출 대상(P4): 서술형(프로필 미매핑) + manual류 아님. 서버 단일 원천(fieldSuggest) 판정.
  const suggestableLabels = connectedFields
    .filter((field) =>
      !field.mappedCompanyField
      && field.fillStrategy !== "manual"
      && isLlmSuggestableLabel(field.label)
    )
    .map((field) => field.label);

  // Gate-1 표준 fieldKey와 label을 함께 전달해 동의어 필드도 같은 lesson에 연결한다.
  const [, seedResult, fieldLessonTips, headRevisionRow] = await Promise.all([
    surfaceLinkPromise,
    seedGrantDocumentDraftProfileAnswers({ draftId, access, fields: seedFields }),
    connectedFields.length > 0
      ? loadFieldLessonTipsSafe({
          title: sheet.grant.title,
          agency: sheet.grant.agency,
          fields: connectedFields.map((field) => ({ label: field.label, fieldKey: field.fieldKey })),
        })
      : Promise.resolve(null),
    getDraftRevisionHead(draftId),
  ]);
  const headRevision = headRevisionRow
    ? {
        revisionId: headRevisionRow.revisionId,
        savedAt: headRevisionRow.savedAt.toISOString(),
        materializedAnswers: headRevisionRow.materializedAnswers,
      }
    : null;

  const { ladder, honestNotice } = classifyWorkspace({
    document: activeDocument,
    surface: matchedSurface,
    connectedFieldsCount: connectedFields.length,
    fieldMapNeedsRefresh: automatedFieldMapNeedsRefresh(connectedFields),
    applicationPrecomputeState,
  });
  const currentPrecomputeStatus = applicationPrecomputeState?.current
    ? applicationPrecomputeState.status
    : null;
  const fieldAnalysisRecoveryNeeded = ladder === "b"
    && shouldRecoverApplicationPrecompute(applicationPrecomputeState, connectedFields.length);

  return {
    execution: { mode: "persistent" },
    ladder,
    activeDocumentKey: activeDocument.documentKey,
    documents,
    draftId,
    headRevision,
    hwpxTemplateAvailable: activeDocument.hwpxTemplateAvailable,
    connectedFields,
    fieldAnswers: seedResult.fieldAnswers,
    duplicateLabels: [...duplicateLabels],
    suggestableLabels,
    fieldLessonTips,
    pages,
    grant,
    missingFields: activeDraft.missingFields ?? [],
    prep: sheet.applicationPrep,
    initialDrafts,
    pollConversion,
    honestNotice,
    applicationPrecomputeStatus: currentPrecomputeStatus,
    fieldAnalysisRecoveryNeeded,
  };
}

/**
 * 개발용 가상 기업 workspace read model.
 *
 * 실제 승격 공고의 문서·surface·필드를 그대로 읽지만 draft ensure, surface 연결, 프로필 시드 저장,
 * revision 조회를 전혀 수행하지 않는다. 반환된 답변은 브라우저 메모리에서만 수정할 수 있다.
 */
export async function loadVirtualGrantWorkspaceData(input: {
  sheet: ApplySheet;
  virtualCompany: {
    bizNo: string;
    name: string;
    profile: CompanyProfile;
  };
  requestedDocumentKey?: string | null;
}): Promise<WorkspaceData> {
  const { sheet, virtualCompany } = input;
  const grant: WorkspaceGrantMeta = {
    id: sheet.grant.id,
    title: sheet.grant.title,
    agency: sheet.grant.agency,
    status: sheet.grant.status,
  };
  const draftable = sheet.applicationPrep.draftableDocuments;
  const documents = buildWorkspaceDocumentOptions(draftable);
  const execution: WorkspaceExecution = {
    mode: "virtual_preview",
    bizNo: virtualCompany.bizNo,
    companyName: virtualCompany.name,
  };

  if (draftable.length === 0) {
    return {
      execution,
      ladder: "c",
      activeDocumentKey: null,
      documents,
      draftId: null,
      headRevision: null,
      hwpxTemplateAvailable: false,
      connectedFields: [],
      fieldAnswers: {},
      duplicateLabels: [],
      suggestableLabels: [],
      fieldLessonTips: null,
      pages: [],
      grant,
      missingFields: [],
      prep: sheet.applicationPrep,
      initialDrafts: [],
      pollConversion: false,
      honestNotice: "이 공고에는 아직 작성형 서류가 없습니다.",
      applicationPrecomputeStatus: null,
      fieldAnalysisRecoveryNeeded: false,
    };
  }

  const {
    activeDocument,
    connectedFields,
    matchedSurface,
    pages,
    applicationPrecomputeState,
  } = await loadWorkspaceDocumentContext({
    sheet,
    ...(input.requestedDocumentKey !== undefined
      ? { requestedDocumentKey: input.requestedDocumentKey }
      : {}),
  });
  const seedFields: SeedFieldInput[] = connectedFields.map((field) => ({
    label: field.label,
    mappedCompanyField: field.mappedCompanyField,
    fieldId: field.fieldId,
  }));
  const fieldAnswers = seedProfileFieldAnswers({
    fields: seedFields,
    profile: virtualCompany.profile,
    current: {},
  });
  const { duplicateLabels } = detectDuplicateNormalizedLabels(connectedFields.map((field) => field.label));
  const fieldLessonTips = connectedFields.length > 0
    ? await loadFieldLessonTipsSafe({
        title: sheet.grant.title,
        agency: sheet.grant.agency,
        fields: connectedFields.map((field) => ({ label: field.label, fieldKey: field.fieldKey })),
      })
    : null;
  const { ladder, honestNotice } = classifyWorkspace({
    document: activeDocument,
    surface: matchedSurface,
    connectedFieldsCount: connectedFields.length,
    fieldMapNeedsRefresh: automatedFieldMapNeedsRefresh(connectedFields),
    applicationPrecomputeState,
  });
  const currentPrecomputeStatus = applicationPrecomputeState?.current
    ? applicationPrecomputeState.status
    : null;

  return {
    execution,
    ladder,
    activeDocumentKey: activeDocument.documentKey,
    documents,
    draftId: null,
    headRevision: null,
    hwpxTemplateAvailable: activeDocument.hwpxTemplateAvailable,
    connectedFields,
    fieldAnswers,
    duplicateLabels: [...duplicateLabels],
    // 가상 미리보기에서는 유료 AI 제안 접점을 열지 않는다.
    suggestableLabels: [],
    fieldLessonTips,
    pages,
    grant,
    missingFields: [],
    prep: sheet.applicationPrep,
    initialDrafts: [],
    // 변환 poll은 서버 write를 일으킬 수 있으므로 가상 미리보기에서 마운트하지 않는다.
    pollConversion: false,
    honestNotice,
    applicationPrecomputeStatus: currentPrecomputeStatus,
    fieldAnalysisRecoveryNeeded: false,
  };
}

interface WorkspaceDocumentContext {
  activeDocument: DraftableDocument;
  connectedFields: ConnectedDocumentField[];
  matchedSurface: PreviewSurface | null;
  pages: PreviewPage[];
  pollConversion: boolean;
  applicationPrecomputeState: SurfaceApplicationPrecomputeState | null;
}

function buildWorkspaceDocumentOptions(draftable: readonly DraftableDocument[]): WorkspaceDocumentOption[] {
  return draftable.map((doc) => ({
    documentKey: doc.documentKey,
    label: doc.canonicalName || doc.name,
    hwpxTemplateAvailable: doc.hwpxTemplateAvailable,
  }));
}

/** 문서 선택·surface·필드·페이지 조회를 persistent/virtual 두 실행 모드가 공유하는 read seam. */
async function loadWorkspaceDocumentContext(input: {
  sheet: ApplySheet;
  requestedDocumentKey?: string | null;
}): Promise<WorkspaceDocumentContext> {
  const { sheet } = input;
  const draftable = sheet.applicationPrep.draftableDocuments;
  if (draftable.length === 0) throw new Error("작성형 문서가 없는 공고의 workspace context를 요청했습니다.");

  const storageKeyByDocumentKey = new Map<string, string | null>();
  const [preview] = await Promise.all([
    loadGrantDocumentPreview({ grantId: sheet.grant.id, includeFields: false }),
    Promise.all(
      draftable.map(async (doc) => {
        if (!doc.sourceAttachment) {
          storageKeyByDocumentKey.set(doc.documentKey, null);
          return;
        }
        try {
          const archive = await resolveArchiveStorageKey({
            source: sheet.grant.source,
            sourceId: sheet.grant.sourceId,
            filename: doc.sourceAttachment,
          });
          storageKeyByDocumentKey.set(doc.documentKey, archive?.storageKey ?? null);
        } catch (error) {
          console.warn(
            `Workspace 첨부 스토리지 키 해석 실패(매칭 생략): ${error instanceof Error ? error.message : String(error)}`,
          );
          storageKeyByDocumentKey.set(doc.documentKey, null);
        }
      }),
    ),
  ]);
  const surfaces = preview?.surfaces ?? [];

  const matchSurfaceFor = (doc: DraftableDocument) => matchDocumentSurface({
    document: doc,
    storageKey: storageKeyByDocumentKey.get(doc.documentKey) ?? null,
    surfaces,
  });
  const requestedDocument = input.requestedDocumentKey
    ? draftable.find((doc) => doc.documentKey === input.requestedDocumentKey)
    : undefined;
  const activeDocument = requestedDocument
    ?? draftable.find((doc) => (matchSurfaceFor(doc)?.pageCount ?? 0) > 0)
    ?? draftable[0]!;
  const matchedSurface = matchSurfaceFor(activeDocument);
  const activeStorageKey = storageKeyByDocumentKey.get(activeDocument.documentKey) ?? null;
  const [connectedFields, applicationPrecomputeState] = await Promise.all([
    loadConnectedDocumentFields({
      source: sheet.grant.source,
      sourceId: sheet.grant.sourceId,
      surfaceId: matchedSurface?.id ?? null,
      sourceAttachment: activeStorageKey,
    }),
    matchedSurface
      ? loadSurfaceApplicationPrecomputeState({ surfaceId: matchedSurface.id })
      : Promise.resolve(null),
  ]);
  const pages = matchedSurface
    ? (preview?.pages ?? []).filter((page) => page.surfaceId === matchedSurface.id)
    : [];

  return {
    activeDocument,
    connectedFields,
    matchedSurface,
    pages,
    pollConversion: surfaces.some((surface) => surface.extractionStatus === "pending"),
    applicationPrecomputeState,
  };
}

/**
 * 문서 ↔ surface 매칭. surface.sourceAttachment 는 R2 스토리지 키이므로 해석된 storageKey 로
 * 대조하되, 이미 키가 들어온 경우(또는 관례가 다른 소스)를 위해 원본 파일명 직접 동등 비교도
 * 후보로 유지한다(방어). 후보가 여럿이면 pageCount>0 우선(/preview 선택 규칙과 동형).
 */
function matchDocumentSurface(input: {
  document: Pick<DraftableDocument, "sourceAttachment">;
  storageKey: string | null;
  surfaces: PreviewSurface[];
}): PreviewSurface | null {
  const { document, storageKey, surfaces } = input;
  if (!document.sourceAttachment) return null;
  const candidates = surfaces.filter(
    (surface) =>
      surface.sourceAttachment !== null
      && (surface.sourceAttachment === document.sourceAttachment
        || (storageKey !== null && surface.sourceAttachment === storageKey)),
  );
  return candidates.find((surface) => surface.pageCount > 0) ?? candidates[0] ?? null;
}

/**
 * 사다리 판정 (§4.4). DB 신호로 결정론적으로 계산한다.
 * (c) 하드 트리거를 먼저 걸러 채움/프리뷰 경험 자체가 불가능한 경우를 정직 고지로 보낸다.
 * fields_ready 인데 연결 필드 0건이면 보수적으로 (b)로 낮춘다.
 */
function classifyWorkspace(input: {
  document: { sourceAttachment: string | null; hwpxTemplateAvailable: boolean };
  surface: Pick<
    PreviewSurface,
    "type" | "format" | "extractionStatus" | "extractionVersion" | "confidence" | "pageCount"
  > | null;
  connectedFieldsCount: number;
  fieldMapNeedsRefresh: boolean;
  applicationPrecomputeState: SurfaceApplicationPrecomputeState | null;
}): { ladder: WorkspaceLadder; honestNotice: string | null } {
  const { document, surface } = input;

  if (!document.sourceAttachment) {
    return {
      ladder: "c",
      honestNotice:
        "이 서류는 별도 원본 양식이 없어 원본 채움을 지원하지 않습니다. 채팅과 초안 편집기로 도와드릴게요.",
    };
  }
  if (!surface) {
    return {
      ladder: "c",
      honestNotice: "원본 양식을 아직 불러오지 못했습니다. 준비되면 자동으로 채움 화면으로 전환됩니다.",
    };
  }
  if (surface.type === "web_form") {
    return {
      ladder: "c",
      honestNotice:
        "이 공고는 웹 양식으로 접수해 원본 파일 채움을 지원하지 않습니다. 채팅과 초안 편집기로 도와드릴게요.",
    };
  }
  if (surface.extractionStatus === "pending") {
    return { ladder: "c", honestNotice: "서류를 준비 중입니다. 변환이 끝나면 자동으로 채움 화면으로 전환됩니다." };
  }
  if (surface.extractionStatus === "failed") {
    return { ladder: "c", honestNotice: "원본 양식 변환에 실패했습니다. 채팅과 초안 편집기로 작성을 도와드릴게요." };
  }

  const fillableFormat =
    HWP_FAMILY_FORMATS.has(surface.format.toLowerCase()) || document.hwpxTemplateAvailable;
  if (!fillableFormat) {
    return { ladder: "c", honestNotice: UNSUPPORTED_FORMAT_NOTICE };
  }

  if (input.applicationPrecomputeState?.current) {
    if (input.applicationPrecomputeState.status === "review_required") {
      return {
        ladder: "b",
        honestNotice: "자동으로 위치를 확정하기 어려운 항목이 있어 원본 문서에서 직접 확인해야 합니다.",
      };
    }
    if (input.applicationPrecomputeState.status === "not_applicable") {
      return {
        ladder: "b",
        honestNotice: "이 문서에서는 빠른 작성 대상으로 안전하게 확정할 항목을 찾지 못했습니다.",
      };
    }
    if (input.applicationPrecomputeState.status === "failed") {
      return {
        ladder: "b",
        honestNotice: "작성 항목 자동 분석을 완료하지 못했습니다. 원본 문서에서 직접 작성할 수 있습니다.",
      };
    }
  }

  if (surface.extractionStatus === "fields_ready" && input.connectedFieldsCount >= 1 && !input.fieldMapNeedsRefresh) {
    const partialCoverage = surface.confidence !== null
      && surface.confidence < 0.99;
    return {
      ladder: "a",
      honestNotice: partialCoverage
        ? "빠른 작성에는 위치를 안전하게 확정한 항목만 표시합니다. 구조가 합쳐진 구간은 문서 직접 편집에서 함께 확인해 주세요."
        : null,
    };
  }
  if (surface.pageCount > 0) {
    // preview_ready, 또는 fields_ready·0필드 → 프리뷰는 있으나 필드 미완.
    return { ladder: "b", honestNotice: null };
  }
  return {
    ladder: "c",
    honestNotice: "원본 양식을 아직 불러오지 못했습니다. 준비되면 자동으로 채움 화면으로 전환됩니다.",
  };
}

function automatedFieldMapNeedsRefresh(fields: ConnectedDocumentField[]): boolean {
  return classifyApplicationFieldMap(fields.map((field) => field.parserVersion ?? "")) === "stale_automated";
}

async function loadFieldLessonTipsSafe(input: {
  title: string;
  agency: string | null;
  fields: Array<{ label: string; fieldKey?: string | null }>;
}): Promise<FieldLessonTipsDto | null> {
  try {
    return await matchFieldLessonTips(input);
  } catch (error) {
    console.warn(
      `Workspace field lesson tips match failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}
