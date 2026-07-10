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
import type { ApplicationPrep, ApplySheet, DocumentDraft, DraftableDocument, MissingFieldQuestion } from "@cunote/contracts";
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
  listGrantDocumentDraftsForGrant,
  seedGrantDocumentDraftProfileAnswers,
} from "./grantDocumentDrafts";
import type { SeedFieldInput } from "./seedProfileAnswers";

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

export interface WorkspaceData {
  ladder: WorkspaceLadder;
  /** 선택된 문서(draftableDocument.documentKey). draftable 문서가 없으면 null. */
  activeDocumentKey: string | null;
  /** 문서 선택 드롭다운 목록(draftableDocuments). */
  documents: WorkspaceDocumentOption[];
  /** 선택 문서의 ensure 된 draft id. 비-draftable(활성 문서 없음)이면 null. */
  draftId: string | null;
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
  /** (c) 상태 정직 고지 문구. (a)(b)는 null. */
  honestNotice: string | null;
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
  const documents: WorkspaceDocumentOption[] = draftable.map((doc) => ({
    documentKey: doc.documentKey,
    label: doc.canonicalName || doc.name,
    hwpxTemplateAvailable: doc.hwpxTemplateAvailable,
  }));

  const initialDrafts = await listGrantDocumentDraftsForGrant({ grantId: grant.id, access });

  // draftable 문서가 하나도 없으면 (c) 폴백(채팅 전면 + 빈 초안 워크스페이스).
  if (draftable.length === 0) {
    return {
      ladder: "c",
      activeDocumentKey: null,
      documents,
      draftId: null,
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
    };
  }

  const preview = await loadGrantDocumentPreview({ grantId: grant.id });
  const surfaces = preview?.surfaces ?? [];
  const pollConversion = surfaces.some((surface) => surface.extractionStatus === "pending");

  // sourceAttachment 표현 차이 해소(documentFieldLink 계약 참조): draftable 문서는 원본 **파일명**,
  // surface·grant_document_fields 는 **R2 스토리지 키**를 갖는다. grant_attachment_archives 단일
  // 원천(공유 resolveArchiveStorageKey)으로 파일명→키를 해석해 매칭한다. 해석 실패는 페이지를
  // 깨뜨리지 않고 매칭 불가(→ 사다리 (c))로만 이어진다.
  const storageKeyByDocumentKey = new Map<string, string | null>();
  await Promise.all(
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
  );

  const matchSurfaceFor = (doc: DraftableDocument) =>
    matchDocumentSurface({
      document: doc,
      storageKey: storageKeyByDocumentKey.get(doc.documentKey) ?? null,
      surfaces,
    });

  // 활성 문서: ?document= 유효값 우선. 기본 선택은 "매칭 surface 가 있고 페이지 이미지가 있는 문서"
  // 우선(§4.3 — 첫 문서가 surface 없는 문서라 실경험 (a)(b)가 가려지는 것을 방지), 없으면 첫 문서.
  const requestedDocument = input.requestedDocumentKey
    ? draftable.find((doc) => doc.documentKey === input.requestedDocumentKey)
    : undefined;
  const activeDocument =
    requestedDocument
      ?? draftable.find((doc) => (matchSurfaceFor(doc)?.pageCount ?? 0) > 0)
      ?? draftable[0]!;

  const matchedSurface = matchSurfaceFor(activeDocument);
  const activeStorageKey = storageKeyByDocumentKey.get(activeDocument.documentKey) ?? null;

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

  // 연결 필드: surfaceId 우선, 없으면 sourceAttachment 폴백(documentFieldLink 단일 원천).
  // 폴백 키는 해석된 스토리지 키다 — grant_document_fields.sourceAttachment 는 surface 값(키)의
  // 사본이라 원본 파일명으로는 매칭되지 않는다(documentFieldLink 계약).
  const connectedFields = await loadConnectedDocumentFields({
    source: sheet.grant.source,
    sourceId: sheet.grant.sourceId,
    surfaceId: matchedSurface?.id ?? null,
    sourceAttachment: activeStorageKey,
  });

  // 프로필 시드(멱등). 시드 결과의 fieldAnswers 를 초기 상태로 쓴다(연결 필드 없으면 현재 답변 그대로).
  const seedFields: SeedFieldInput[] = connectedFields.map((field) => ({
    label: field.label,
    mappedCompanyField: field.mappedCompanyField,
    fieldId: field.fieldId,
  }));
  const seedResult = await seedGrantDocumentDraftProfileAnswers({ draftId, access, fields: seedFields });

  const { duplicateLabels } = detectDuplicateNormalizedLabels(connectedFields.map((field) => field.label));

  // '제안 받기' 노출 대상(P4): 서술형(프로필 미매핑) + manual류 아님. 서버 단일 원천(fieldSuggest) 판정.
  const suggestableLabels = connectedFields
    .filter((field) => !field.mappedCompanyField && isLlmSuggestableLabel(field.label))
    .map((field) => field.label);

  // ConnectedDocumentField 에는 Gate-1 표준 fieldKey 가 없다(fieldId 는 grant_document_fields.id UUID).
  // fieldKey 동등성 오탐을 피하려 label 만 전달한다(fieldPattern 문자열 폴백 매칭 — grant page 의
  // missingProfileFields 전달 관례와 동일).
  const fieldLessonTips = connectedFields.length > 0
    ? await loadFieldLessonTipsSafe({
        title: sheet.grant.title,
        agency: sheet.grant.agency,
        fields: connectedFields.map((field) => ({ label: field.label })),
      })
    : null;

  const pages = matchedSurface
    ? (preview?.pages ?? []).filter((page) => page.surfaceId === matchedSurface.id)
    : [];

  const { ladder, honestNotice } = classifyWorkspace({
    document: activeDocument,
    surface: matchedSurface,
    connectedFieldsCount: connectedFields.length,
  });

  return {
    ladder,
    activeDocumentKey: activeDocument.documentKey,
    documents,
    draftId,
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
  surface: Pick<PreviewSurface, "type" | "format" | "extractionStatus" | "pageCount"> | null;
  connectedFieldsCount: number;
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

  if (surface.extractionStatus === "fields_ready" && input.connectedFieldsCount >= 1) {
    return { ladder: "a", honestNotice: null };
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
