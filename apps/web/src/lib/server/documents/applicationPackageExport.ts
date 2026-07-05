import type {
  ApplySheet,
  DocumentDraft,
  RequiredDocument,
  RuleTraceChip,
  SourceAttachment,
  SupportAmount,
} from "@cunote/contracts";
import type { CompanyAccess } from "../auth/companyGuard";
import { loadServiceApplySheet } from "../serviceData";
import { listGrantDocumentDraftsForGrant } from "./grantDocumentDrafts";
import { listGrantDocumentFormFields, type GrantDocumentFormField } from "./grantDocumentFields";
import { sanitizeDownloadFilename } from "./downloadHeaders";

export class ApplicationPackageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "ApplicationPackageError";
  }
}

export interface GrantApplicationPackage {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export interface GrantAttachmentBundle {
  filename: string;
  fallbackFilename: string;
  markdown: string;
}

export async function buildGrantApplicationPackage(input: {
  grantId: string;
  access: CompanyAccess;
  asOf?: Date;
}): Promise<GrantApplicationPackage> {
  const generatedAt = input.asOf ?? new Date();
  const sheet = await loadServiceApplySheet(input.grantId, {
    companyId: input.access.companyId,
    userId: input.access.userId,
    asOf: generatedAt,
  });
  if (!sheet) {
    throw new ApplicationPackageError("grant_not_found", "공고를 찾지 못했습니다.", 404, "grantId");
  }

  const { drafts, warning } = await loadDraftsForPackage({
    grantId: sheet.grant.id,
    access: input.access,
  });
  const formFields = await listGrantDocumentFormFields({
    grantId: sheet.grant.id,
    access: input.access,
  });
  const filenameBase = sanitizeDownloadFilename(sheet.grant.title, "지원사업-신청패키지");
  return {
    filename: `창업노트-${filenameBase}-신청패키지.md`,
    fallbackFilename: `cunote-application-package-${stableId(sheet.grant.id)}.md`,
    markdown: renderApplicationPackageMarkdown({ sheet, drafts, formFields, generatedAt, warning }),
  };
}

export async function buildGrantAttachmentBundle(input: {
  grantId: string;
  access: CompanyAccess;
  asOf?: Date;
}): Promise<GrantAttachmentBundle> {
  const generatedAt = input.asOf ?? new Date();
  const sheet = await loadServiceApplySheet(input.grantId, {
    companyId: input.access.companyId,
    userId: input.access.userId,
    asOf: generatedAt,
  });
  if (!sheet) {
    throw new ApplicationPackageError("grant_not_found", "공고를 찾지 못했습니다.", 404, "grantId");
  }

  const formFields = await listGrantDocumentFormFields({
    grantId: sheet.grant.id,
    access: input.access,
  });
  const filenameBase = sanitizeDownloadFilename(sheet.grant.title, "지원사업-첨부묶음");
  return {
    filename: `창업노트-${filenameBase}-첨부묶음.md`,
    fallbackFilename: `cunote-attachment-bundle-${stableId(sheet.grant.id)}.md`,
    markdown: renderAttachmentBundleMarkdown({ sheet, formFields, generatedAt }),
  };
}

async function loadDraftsForPackage(input: {
  grantId: string;
  access: CompanyAccess;
}): Promise<{ drafts: DocumentDraft[]; warning: string | null }> {
  if (!isUuid(input.grantId)) {
    return {
      drafts: [],
      warning: "저장 DB의 UUID 공고가 아니어서 저장된 초안 목록은 포함하지 않았습니다.",
    };
  }

  try {
    return {
      drafts: await listGrantDocumentDraftsForGrant(input),
      warning: null,
    };
  } catch (error) {
    console.warn(`Grant package draft lookup failed: ${errorMessage(error)}`);
    return {
      drafts: [],
      warning: "저장된 초안 목록을 불러오지 못했습니다. 공고/서류/첨부 정보만 포함했습니다.",
    };
  }
}

function renderApplicationPackageMarkdown(input: {
  sheet: ApplySheet;
  drafts: DocumentDraft[];
  formFields: GrantDocumentFormField[];
  generatedAt: Date;
  warning: string | null;
}): string {
  const { sheet, drafts, formFields, generatedAt, warning } = input;
  const lines: string[] = [
    `# ${sheet.grant.title} 신청 패키지`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    "",
    "> 창업노트가 정규화한 공고, 제출서류 taxonomy, 보관 첨부 링크, 저장된 AI 초안을 한 파일로 묶은 작업용 패키지입니다. 실제 제출은 공식 포털과 원문 양식을 기준으로 최종 확인하세요.",
    "",
    "## 공고 요약",
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["운영기관", sheet.grant.agency ?? "확인 필요"],
        ["상태", grantStatusLabel(sheet.grant.status)],
        ["접수 기간", formatDateRange(sheet.schedule.applyStart, sheet.schedule.applyEnd)],
        ["마감", formatDday(sheet.schedule.dDay)],
        ["지원금", formatSupportAmount(sheet.grant.supportAmount)],
        ["접수 방법", sheet.applyMethod ?? "원문 확인"],
        ["신청 링크", renderMarkdownLink(sheet.deepLink, "공식 페이지")],
        ["자동 제출", sheet.applicationPrep.autoSubmitSupported ? "지원" : "미지원: 공식 포털에서 직접 제출"],
      ],
    ),
    "",
    "## 핵심 혜택",
    "",
    sheet.grant.benefits.length > 0
      ? sheet.grant.benefits.map((benefit) => `- ${benefit.label}`).join("\n")
      : "- 혜택 taxonomy가 명확히 추출되지 않았습니다. 원문 확인이 필요합니다.",
    "",
    "## 준비 현황",
    "",
    markdownTable(
      ["항목", "개수"],
      [
        ["전체 제출서류", String(sheet.applicationPrep.draftCoverage.totalDocuments)],
        ["AI 초안 작성 가능", String(sheet.applicationPrep.draftCoverage.draftableCount)],
        ["기관 발급 필요", String(sheet.applicationPrep.draftCoverage.issuableCount)],
        ["파일 첨부 필요", String(sheet.applicationPrep.draftCoverage.attachableCount)],
        ["원문 확인 필요", String(sheet.applicationPrep.draftCoverage.otherCount)],
        ["첨부/양식 근거 있음", String(sheet.applicationPrep.draftCoverage.withAttachmentContextCount)],
        ["추가 입력 필요", String(sheet.applicationPrep.draftCoverage.missingFieldCount)],
        ["저장된 초안", String(drafts.length)],
      ],
    ),
    "",
  ];

  if (warning) {
    lines.push("> 참고: " + warning, "");
  }

  lines.push(
    "## 제출 서류 Taxonomy",
    "",
    renderDocumentGroups(sheet),
    "",
    "## 원문 첨부와 보관 링크",
    "",
    renderAttachments(sheet.sourceAttachments),
    "",
    "## 복붙 프로필",
    "",
    renderProfileCopyFields(sheet),
    "",
    "## 추가 입력 필요",
    "",
    renderMissingFields(sheet),
    "",
    "## 원문 양식 필드 매핑",
    "",
    renderFormFieldMappings(formFields),
    "",
    "## 초안 프롬프트",
    "",
    renderPlanDraftPrompts(sheet),
    "",
    "## 조건 확인",
    "",
    renderRuleTrace("이미 충족", sheet.satisfied),
    "",
    renderRuleTrace("확인 필요", sheet.needsCheck),
    "",
    "## 저장된 AI 초안",
    "",
    renderDrafts(drafts),
    "",
  );

  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderAttachmentBundleMarkdown(input: {
  sheet: ApplySheet;
  formFields: GrantDocumentFormField[];
  generatedAt: Date;
}): string {
  const { sheet, formFields, generatedAt } = input;
  const attachments = sheet.sourceAttachments;
  const lines: string[] = [
    `# ${sheet.grant.title} 첨부 묶음`,
    "",
    `생성: ${formatDateTime(generatedAt)}`,
    "",
    "> 원문 첨부, R2 보관본, HWP/PDF 변환 Markdown, 연결 제출서류를 한 번에 점검하기 위한 작업용 manifest입니다. 실제 제출 전 공식 포털의 최신 양식을 다시 확인하세요.",
    "",
    "## 첨부 파일",
    "",
    renderAttachmentManifestTable(sheet),
    "",
    "## 제출서류 매핑",
    "",
    renderAttachmentDocumentMapping(sheet),
    "",
    "## 원문 양식 필드 매핑",
    "",
    renderFormFieldMappings(formFields),
    "",
    "## 보관 상태",
    "",
    markdownTable(
      ["항목", "개수"],
      [
        ["전체 첨부", String(attachments.length)],
        ["R2 보관본", String(attachments.filter((attachment) => Boolean(attachment.archiveUrl ?? attachment.url)).length)],
        ["변환 Markdown", String(attachments.filter((attachment) => Boolean(attachment.markdownUrl)).length)],
        ["원문 URL", String(attachments.filter((attachment) => Boolean(attachment.sourceUri ?? attachment.url)).length)],
      ],
    ),
    "",
  ];
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

function renderFormFieldMappings(fields: GrantDocumentFormField[]): string {
  if (fields.length === 0) {
    return "_저장된 원문 양식 필드 매핑이 없습니다. 첨부 Markdown 재추출 후 `extract:grant-document-fields -- --write`를 실행하면 채워집니다._";
  }

  return markdownTable(
    ["문서", "섹션", "필드", "유형", "자동채움", "필수", "근거"],
    fields.map((field) => [
      field.documentName,
      field.section ?? "-",
      field.label,
      fieldTypeLabel(field.fieldType),
      fillStrategyLabel(field.fillStrategy, field.mappedCompanyField),
      field.required ? "필수" : "선택/확인",
      field.sourceSpan ?? "-",
    ]),
  );
}

function renderDocumentGroups(sheet: ApplySheet): string {
  if (sheet.applicationPrep.documentGroups.length === 0) {
    return "_정규화된 제출서류가 없습니다. 공식 공고문을 확인하세요._";
  }

  return sheet.applicationPrep.documentGroups.map((group) => {
    const rows = group.documents.map((document) => [
      document.required ? "필수" : "선택",
      document.canonicalName ?? document.name,
      documentCategoryLabel(document),
      sourceLabel(document.source),
      document.sourceAttachment ?? "-",
      document.sourceSpan ?? document.note ?? "-",
    ]);
    return [
      `### ${group.label}`,
      "",
      group.description,
      "",
      markdownTable(["필수", "문서", "분류", "준비 경로", "연결 첨부", "근거"], rows),
    ].join("\n");
  }).join("\n\n");
}

function renderAttachments(attachments: SourceAttachment[]): string {
  if (attachments.length === 0) {
    return "_보관된 원문 첨부가 없습니다._";
  }

  return markdownTable(
    ["파일", "보관 URL", "원문 URL", "변환 Markdown"],
    attachments.map((attachment) => {
      const archivedUrl = attachment.archiveUrl ?? attachment.url;
      const sourceUrl = attachment.sourceUri ?? (attachment.archiveUrl ? attachment.url : null);
      return [
        attachment.filename,
        renderMarkdownLink(archivedUrl, "열기"),
        renderMarkdownLink(sourceUrl, "원문"),
        renderMarkdownLink(attachment.markdownUrl ?? null, "Markdown"),
      ];
    }),
  );
}

function renderAttachmentManifestTable(sheet: ApplySheet): string {
  if (sheet.sourceAttachments.length === 0) {
    return "_보관된 원문 첨부가 없습니다._";
  }

  return markdownTable(
    ["파일", "R2 보관본", "원문 URL", "변환 Markdown", "연결 제출서류"],
    sheet.sourceAttachments.map((attachment) => [
      attachment.filename,
      renderMarkdownLink(attachmentArchiveUrl(attachment), "보관본"),
      renderMarkdownLink(attachmentSourceUrl(attachment), "원문"),
      renderMarkdownLink(attachment.markdownUrl ?? null, "Markdown"),
      relatedDocumentNames(sheet.documents, attachment).join(", ") || "-",
    ]),
  );
}

function renderAttachmentDocumentMapping(sheet: ApplySheet): string {
  const linkedDocuments = sheet.documents.filter((document) => Boolean(document.sourceAttachment));
  if (linkedDocuments.length === 0) {
    return "_첨부와 직접 연결된 제출서류가 없습니다. 제출서류 taxonomy와 원문 양식을 함께 확인하세요._";
  }

  return markdownTable(
    ["제출서류", "분류", "필수", "연결 첨부", "근거"],
    linkedDocuments.map((document) => [
      document.canonicalName ?? document.name,
      documentCategoryLabel(document),
      document.required ? "필수" : "선택",
      document.sourceAttachment ?? "-",
      document.sourceSpan ?? document.note ?? "-",
    ]),
  );
}

function renderProfileCopyFields(sheet: ApplySheet): string {
  const fields = sheet.applicationPrep.profileCopyFields;
  if (fields.length === 0) {
    return "_복사 가능한 회사 프로필 정보가 없습니다._";
  }
  return markdownTable(
    ["항목", "값", "출처"],
    fields.map((field) => [
      field.label,
      field.value,
      field.source === "company_profile" ? "회사 프로필" : "공고 컨텍스트",
    ]),
  );
}

function renderMissingFields(sheet: ApplySheet): string {
  const fields = sheet.applicationPrep.missingProfileFields;
  if (fields.length === 0) {
    return "_현재 프로필 기준 추가 입력이 필요한 항목이 없습니다._";
  }
  return markdownTable(
    ["항목", "필요 이유", "연결 문서"],
    fields.map((field) => [
      field.label,
      field.reason,
      field.documentName ?? "-",
    ]),
  );
}

function renderPlanDraftPrompts(sheet: ApplySheet): string {
  const prompts = sheet.applicationPrep.planDraftPrompts;
  if (prompts.length === 0) {
    return "_생성된 초안 프롬프트가 없습니다._";
  }

  return prompts.map((prompt) => [
    `### ${prompt.title}`,
    "",
    prompt.prompt,
    "",
    ...prompt.evidence.map((item) => `- ${item}`),
  ].join("\n")).join("\n\n");
}

function renderRuleTrace(title: string, items: RuleTraceChip[]): string {
  if (items.length === 0) {
    return `### ${title}\n\n_해당 조건이 없습니다._`;
  }
  return [
    `### ${title}`,
    "",
    markdownTable(
      ["결과", "조건", "회사값/근거", "다음 액션"],
      items.map((item) => [
        traceResultLabel(item.result),
        item.label,
        item.companyValue ?? item.sourceSpan ?? "-",
        item.action?.label ?? item.unlock?.detail ?? "-",
      ]),
    ),
  ].join("\n");
}

function renderDrafts(drafts: DocumentDraft[]): string {
  if (drafts.length === 0) {
    return "_저장된 AI 초안이 없습니다. 공고 상세의 AI 초안 영역에서 초안을 만든 뒤 다시 내려받으세요._";
  }

  return drafts.map((draft) => [
    `### ${draft.documentName}`,
    "",
    markdownTable(
      ["항목", "내용"],
      [
        ["상태", draftStatusLabel(draft.status)],
        ["문서 분류", draft.documentCategory],
        ["연결 첨부", draft.sourceAttachment ?? "-"],
        ["자동 반영", draft.usedProfileFields.length > 0 ? draft.usedProfileFields.join(", ") : "없음"],
        ["입력 필요", `${draft.missingFields.length}개`],
        ["주의", draft.warnings.length > 0 ? draft.warnings.join(", ") : "없음"],
        ["최종 수정", formatDateTime(new Date(draft.updatedAt))],
      ],
    ),
    "",
    "#### 자동채움 값",
    "",
    renderDraftFilledFields(draft),
    "",
    draft.draftMarkdown.trim() || "_초안 본문이 비어 있습니다._",
  ].join("\n")).join("\n\n---\n\n");
}

function renderDraftFilledFields(draft: DocumentDraft): string {
  const rows = [
    ...Object.entries(draft.filledFields).map(([label, value]) => [label, "값 준비", value]),
    ...draft.missingFields.map((field) => [field.label, "입력 필요", field.reason]),
  ];
  if (rows.length === 0) return "_저장된 자동채움 값이 없습니다._";
  return markdownTable(["문항", "상태", "값/사유"], rows);
}

function markdownTable(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string | null | undefined): string {
  const cleaned = (value ?? "-").trim();
  if (!cleaned) return "-";
  return cleaned
    .replace(/\r?\n/g, "<br>")
    .replace(/\|/g, "\\|");
}

function renderMarkdownLink(url: string | null | undefined, label: string): string {
  if (!url) return "-";
  return `[${label}](${url})`;
}

function attachmentArchiveUrl(attachment: SourceAttachment): string | null {
  return attachment.archiveUrl ?? attachment.url ?? null;
}

function attachmentSourceUrl(attachment: SourceAttachment): string | null {
  if (attachment.sourceUri) return attachment.sourceUri;
  return attachment.archiveUrl ? attachment.url : null;
}

function relatedDocumentNames(documents: RequiredDocument[], attachment: SourceAttachment): string[] {
  const filename = normalizeAttachmentName(attachment.filename);
  return documents
    .filter((document) => {
      const sourceAttachment = normalizeAttachmentName(document.sourceAttachment);
      return sourceAttachment.length > 0
        && (sourceAttachment === filename || sourceAttachment.includes(filename) || filename.includes(sourceAttachment));
    })
    .map((document) => document.canonicalName ?? document.name);
}

function normalizeAttachmentName(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function documentCategoryLabel(document: RequiredDocument): string {
  const category = document.category
    ? grantDocumentCategoryLabel(document.category)
    : preparationTypeLabel(document.preparationType);
  return `${category}${document.templateRequired ? " · 양식 필요" : ""}`;
}

function grantDocumentCategoryLabel(value: string): string {
  const labels: Record<string, string> = {
    application_form: "신청서",
    business_plan: "사업계획서",
    proposal_or_intro: "제안서/소개서",
    consent_or_pledge: "동의서/확약서",
    business_registration: "사업자등록증",
    corporate_register: "법인등기",
    company_confirmation: "기업확인서",
    financial_tax: "재무/세무 증빙",
    employment_insurance: "고용보험 증빙",
    shareholder: "주주/지분 증빙",
    bank_account: "통장 사본",
    estimate_budget: "견적/예산",
    portfolio_catalog: "포트폴리오/카탈로그",
    ip_certification: "지식재산/인증",
    recommendation: "추천서",
    performance_evidence: "실적 증빙",
    other: "기타",
  };
  return labels[value] ?? value;
}

function fieldTypeLabel(value: string): string {
  const labels: Record<string, string> = {
    text: "단문",
    long_text: "장문",
    number: "숫자",
    date: "날짜",
    currency: "금액",
    checkbox: "체크",
    table: "표",
    file: "파일",
    unknown: "확인",
  };
  return labels[value] ?? value;
}

function fillStrategyLabel(strategy: string, mappedCompanyField: string | null): string {
  if (strategy === "copy") return mappedCompanyField ? `프로필 복사: ${mappedCompanyField}` : "프로필 복사";
  if (strategy === "summarize") return mappedCompanyField ? `요약: ${mappedCompanyField}` : "요약";
  if (strategy === "generate") return "AI 작성";
  if (strategy === "ask_user") return "사용자 입력";
  return "수동 확인";
}

function preparationTypeLabel(value: RequiredDocument["preparationType"]): string {
  if (value === "write") return "작성";
  if (value === "issue") return "발급";
  if (value === "attach") return "첨부";
  if (value === "portal") return "포털 입력";
  if (value === "other") return "기타";
  return "미분류";
}

function formatSupportAmount(amount: SupportAmount): string {
  if (amount.label) return amount.label;
  if (!amount.max) return "금액 미확인";
  return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
}

function formatDateRange(start: string | null, end: string | null): string {
  if (!start && !end) return "일정 확인";
  if (!start) return `${end} 마감`;
  if (!end) return `${start} 시작`;
  return `${start} - ${end}`;
}

function formatDday(value: number | null): string {
  if (value === null) return "일정 확인";
  if (value < 0) return "마감 확인";
  if (value === 0) return "오늘 마감";
  return `D-${value}`;
}

function formatDateTime(value: Date): string {
  if (Number.isNaN(value.getTime())) return "일시 확인 필요";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(value);
}

function grantStatusLabel(status: ApplySheet["grant"]["status"]): string {
  if (status === "open") return "접수중";
  if (status === "upcoming") return "예정";
  if (status === "closed") return "마감";
  return "확인 필요";
}

function sourceLabel(source: RequiredDocument["source"]): string {
  if (source === "cert") return "기관 발급";
  if (source === "self") return "직접 작성/준비";
  return "포털/원문 확인";
}

function traceResultLabel(result: RuleTraceChip["result"]): string {
  if (result === "pass") return "충족";
  if (result === "fail") return "미충족";
  if (result === "text_only") return "원문 확인";
  return "확인 필요";
}

function draftStatusLabel(status: DocumentDraft["status"]): string {
  if (status === "needs_input") return "입력 필요";
  if (status === "reviewed") return "검토 완료";
  if (status === "exported") return "내보냄";
  if (status === "archived") return "보관됨";
  return "초안";
}

function stableId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 48) || "grant";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
