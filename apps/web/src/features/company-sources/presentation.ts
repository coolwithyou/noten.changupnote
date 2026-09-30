import type { CompanyWritingSourceRow } from "@/lib/server/documents/companyWritingSources";
import { withCompanyContext } from "@/lib/navigation/companyContext";

/** 디자인 `04 회사 자료.dc.html` renderVals 문구. 화면·테스트가 같은 문자열을 참조한다. */
export const COMPANY_SOURCES_COPY = {
  title: "회사 자료",
  caption: "다른 공고에서도 재사용하는 회사 공통 자료예요 · 이번 신청 전용 자료는 각 문서의 작성 화면에서 관리해요",
  addAction: "자료 추가",
  calloutTitle: "자료는 확인 전 회사 사실로 확정하지 않아요",
  calloutBody: "자료의 연도·수치를 현재 실적으로 자동 채택하지 않고, 문안 초안에서 인용 근거로만 써요. 사용 중단하면 이후 초안 생성에 전달되지 않지만 이미 저장한 문서 내용은 유지됩니다.",
  listTitle: "자료 목록",
  scopeCompany: "회사 공통 자료",
  scopeApplication: "이번 신청 전용",
  statusAvailable: "사용 가능",
  statusAvailableCaption: "읽을 수 있다는 뜻이며 사실을 인증한 상태가 아니에요",
  statusWithdrawn: "사용 중단됨",
  fromDocument: "기존 회사 문서에서 가져온 내용이에요",
  applicationCaption: "이번 신청 전용 자료는 해당 문서의 작성 화면에서 관리해요",
  openWorkspace: "작성 화면 열기",
  viewContent: "내용 보기",
  closeContent: "내용 닫기",
  pdfOriginal: "PDF 원본",
  stopUsing: "자료 사용 중단",
  emptyTitle: "저장한 자료가 없어요.",
  emptyBody: "아래에서 첫 자료를 추가해 주세요.",
  addTitle: "자료 추가",
  addCaption: "PDF 파일과 자료 내용 중 하나만 채워요 · 한쪽을 채우면 다른 쪽은 잠겨요",
  fieldTitle: "자료 이름",
  fieldTitlePlaceholder: "예: 회사소개서_2026",
  fieldPdf: "PDF 파일 · 선택",
  fieldPdfHint: "최대 4MB·30쪽·추출 텍스트 30,000자. 스캔·암호 PDF는 지원하지 않아요.",
  fieldContent: "자료 내용",
  fieldContentPlaceholder: "PDF 대신 내용을 직접 붙여 넣을 수 있어요 · 최대 30,000자",
  fieldContentHint: "사실과 목표를 구분하고 과거 실적에는 연도를 적어 주세요.",
  fieldDate: "자료 기준일 · 선택",
  checkFromDocument: "기존 회사 문서에서 가져온 내용이에요",
  checkReusable: "다른 공고에서도 사용할 회사 공통 자료로 저장",
  checkReusableHint: "이 화면에서는 회사 공통 자료만 저장해요 · 이번 신청 전용 자료는 문서의 작성 화면에서 추가해요",
  saveText: "자료 저장",
  savePdf: "PDF 추출·보관",
  saveHint: "추출 후 표와 숫자의 읽기 순서를 확인하고 자료로 선택해 주세요.",
  pdfUnavailable: "PDF 업로드는 현재 사용할 수 없어요. 필요한 내용을 아래에 붙여 넣을 수 있어요.",
  pdfSaved: "PDF를 보관했어요.",
  pdfSavedBody: "내용 보기에서 추출한 내용을 확인한 뒤 자료를 선택해 주세요.",
  textSaved: "자료를 저장했어요. 각 문서의 작성 화면에서 이 자료를 선택하면 초안 근거로 써요.",
  toastStopped: "자료 사용을 중단했어요 · 이미 저장한 문서 내용은 유지됩니다",
  confirmStopTitle: "자료 사용을 중단할까요?",
  confirmStopBody: "이후 초안 생성에 전달되지 않지만 이미 저장한 문서 내용은 유지됩니다. 중단한 자료는 되돌릴 수 없고, 필요하면 새 자료로 다시 등록해요.",
  confirmCancel: "취소",
  footer: "저장된 회사 사실(상호·소재지·업종·업력)은 기존 회사 프로필에서 관리해요. 자료의 내용이 회사 사실과 다르면 자료를 고치지 말고 프로필에서 정정하세요.",
  truncated: "최근 자료 200개를 표시합니다.",
} as const;

const formatCount = (value: number) => value.toLocaleString("ko-KR");

/** 메타 줄: `2026-06-30 기준 · PDF 12쪽 · 사용 중인 문서 2건` (범위는 뱃지로 분리해 표시한다). */
export function sourceMetaLine(row: Pick<CompanyWritingSourceRow, "scope" | "observedDate" | "originalPdf" | "characters" | "usedByDrafts" | "application">): string {
  const parts: string[] = [];
  if (row.scope === "application") parts.push(row.application?.grantTitle?.trim() || row.application?.documentName || "작성 중인 문서");
  parts.push(row.observedDate ? `${row.observedDate} 기준` : "기준일 미입력");
  parts.push(row.originalPdf ? `PDF ${formatCount(row.originalPdf.pages)}쪽` : `텍스트 ${formatCount(row.characters)}자`);
  if (row.scope === "company") parts.push(`사용 중인 문서 ${formatCount(row.usedByDrafts)}건`);
  return parts.join(" · ");
}

export function sourceScopeLabel(scope: CompanyWritingSourceRow["scope"]): string {
  return scope === "company" ? COMPANY_SOURCES_COPY.scopeCompany : COMPANY_SOURCES_COPY.scopeApplication;
}

/** 목록 헤더 집계: `회사 공통 자료 3 · 이번 신청 전용 1` */
export function sourceCountLabel(rows: ReadonlyArray<Pick<CompanyWritingSourceRow, "scope">>): string {
  const company = rows.filter((row) => row.scope === "company").length;
  return `${COMPANY_SOURCES_COPY.scopeCompany} ${company} · ${COMPANY_SOURCES_COPY.scopeApplication} ${rows.length - company}`;
}

/** 이번 신청 전용 자료의 관리 위치. 작성 화면은 회사 문맥(companyId)을 요구한다. */
export function workspaceHrefFor(application: NonNullable<CompanyWritingSourceRow["application"]>, companyId: string): string {
  const query = new URLSearchParams({ document: application.documentKey });
  return withCompanyContext(`/grants/${encodeURIComponent(application.grantId)}/workspace?${query}`, companyId);
}
