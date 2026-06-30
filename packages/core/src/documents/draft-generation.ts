import type {
  DocumentAutofillResult,
  DocumentDraftStatus,
  DraftableDocument,
  GrantDetail,
  MissingFieldQuestion,
  ProfileCopyField,
  SupportAmount,
} from "@cunote/contracts";
import { autofillDraftFields } from "./preparation.js";

export const DOCUMENT_DRAFT_MODEL_VER = "deterministic-document-draft-v1";
export const DOCUMENT_DRAFT_PROMPT_VER = "document-draft-template-v1";
export const DOCUMENT_DRAFT_PARSER_VER = "document-autofill-v1";

export interface GenerateDocumentDraftInput {
  grant: GrantDetail;
  document: DraftableDocument;
  profileCopyFields: ProfileCopyField[];
  missingProfileFields: MissingFieldQuestion[];
  answers?: Record<string, string>;
}

export interface GeneratedDocumentDraftContent {
  draftMarkdown: string;
  autofill: DocumentAutofillResult;
  assumptions: string[];
  warnings: string[];
  status: DocumentDraftStatus;
  modelVer: string;
  promptVer: string;
  parserVersion: string;
}

export function generateDocumentDraftContent(input: GenerateDocumentDraftInput): GeneratedDocumentDraftContent {
  const autofill = autofillDraftFields({
    document: input.document,
    profileCopyFields: input.profileCopyFields,
    missingProfileFields: input.missingProfileFields,
    ...(input.answers ? { answers: input.answers } : {}),
  });
  const assumptions = buildAssumptions(input);
  const warnings = buildWarnings(input, autofill);
  const draftMarkdown = [
    `# ${input.document.canonicalName} 초안`,
    "",
    "## 기본 정보",
    ...baseInfoLines(input),
    "",
    ...documentBody(input, autofill),
    "",
    "## 확인 필요",
    ...confirmationLines(autofill.missingFields, warnings),
  ].join("\n");

  return {
    draftMarkdown,
    autofill,
    assumptions,
    warnings,
    status: autofill.missingFields.length > 0 ? "needs_input" : "draft",
    modelVer: DOCUMENT_DRAFT_MODEL_VER,
    promptVer: DOCUMENT_DRAFT_PROMPT_VER,
    parserVersion: DOCUMENT_DRAFT_PARSER_VER,
  };
}

function baseInfoLines(input: GenerateDocumentDraftInput): string[] {
  return [
    `- 지원사업명: ${input.grant.title}`,
    `- 운영기관: ${input.grant.agency ?? "원문 확인 필요"}`,
    `- 문서 유형: ${documentCategoryLabel(input.document.category)}`,
    `- 연결 첨부: ${input.document.sourceAttachment ?? "연결 첨부 없음"}`,
    `- 지원 규모: ${formatSupportAmount(input.grant.supportAmount)}`,
  ];
}

function documentBody(input: GenerateDocumentDraftInput, autofill: DocumentAutofillResult): string[] {
  if (input.document.category === "application_form") return applicationFormBody(input, autofill);
  if (input.document.category === "business_plan") return businessPlanBody(input, autofill);
  if (input.document.category === "proposal_or_intro") return proposalBody(input, autofill);
  if (input.document.category === "estimate_budget") return estimateBody(input, autofill);
  if (input.document.category === "performance_evidence") return performanceBody(input, autofill);
  if (input.document.category === "recommendation") return recommendationBody(input, autofill);
  return genericBody(input, autofill);
}

function applicationFormBody(input: GenerateDocumentDraftInput, autofill: DocumentAutofillResult): string[] {
  return [
    "## 신청 개요",
    `- 신청 기업: ${field(autofill, "기업명")}`,
    `- 소재지: ${field(autofill, "소재지")}`,
    `- 업종/분야: ${field(autofill, "업종/분야")}`,
    "",
    "## 지원 적합성",
    `${field(autofill, "기업명", "당사")}는 ${input.grant.title}의 지원 취지에 맞춰 보유 역량과 사업화 계획을 정리해 신청합니다.`,
  ];
}

function businessPlanBody(input: GenerateDocumentDraftInput, autofill: DocumentAutofillResult): string[] {
  return [
    "## 1. 사업 개요",
    `${field(autofill, "기업명", "당사")}는 ${field(autofill, "업종/분야", "관련 분야")}에서 ${answer(autofill, "제품/서비스 설명", "제품/서비스의 핵심 가치와 고객 문제를 구체화해야 합니다.")}`,
    "",
    "## 2. 추진 계획",
    `${input.grant.title}을 통해 ${answer(autofill, "이번 지원으로 달성할 목표", "지원금/프로그램을 활용한 실행 목표를 보완해야 합니다.")}`,
    "",
    "## 3. 기대 효과",
    "지원 이후 매출, 고객 확보, 인증, 고용, 후속 투자 등 측정 가능한 성과 지표를 기준으로 결과를 관리하겠습니다.",
  ];
}

function proposalBody(input: GenerateDocumentDraftInput, autofill: DocumentAutofillResult): string[] {
  return [
    "## 회사 및 제품 소개",
    `${field(autofill, "기업명", "당사")}는 ${answer(autofill, "제품/서비스 설명", "제품/서비스 설명을 보완해야 합니다.")}`,
    "",
    "## 협력 제안",
    `${input.grant.agency ?? "운영기관"}의 프로그램과 연결해 시장 검증, 고객 접점 확대, 기술 고도화를 추진하겠습니다.`,
  ];
}

function estimateBody(_input: GenerateDocumentDraftInput, autofill: DocumentAutofillResult): string[] {
  return [
    "## 예산 산출 근거",
    answer(autofill, "예산 항목과 산출근거", "항목별 단가, 수량, 공급처, 집행 목적을 입력해야 합니다."),
    "",
    "## 집행 관리",
    "선정 이후 기관 지침에 맞춰 증빙 가능한 항목만 집행하고, 견적서와 거래 증빙을 함께 보관하겠습니다.",
  ];
}

function performanceBody(_input: GenerateDocumentDraftInput, autofill: DocumentAutofillResult): string[] {
  return [
    "## 대표 실적",
    answer(autofill, "대표 실적 요약", "매출, 납품, 수출, PoC, 인증 등 확인 가능한 실적을 입력해야 합니다."),
    "",
    "## 증빙 계획",
    "실적별 계약서, 세금계산서, 수출신고필증, 인증서 등 확인 가능한 자료를 첨부하겠습니다.",
  ];
}

function recommendationBody(input: GenerateDocumentDraftInput, autofill: DocumentAutofillResult): string[] {
  return [
    "## 추천 요청 초안",
    `${field(autofill, "기업명", "당사")}의 ${input.grant.title} 신청을 위해 추천서 발급을 요청드립니다.`,
    "추천서에는 기업 역량, 협력 이력, 성장 가능성, 지원사업과의 적합성을 중심으로 작성해 주시면 됩니다.",
  ];
}

function genericBody(input: GenerateDocumentDraftInput, autofill: DocumentAutofillResult): string[] {
  return [
    "## 작성 초안",
    `${field(autofill, "기업명", "당사")}는 ${input.grant.title} 신청을 위해 본 문서를 준비합니다.`,
    "공고 원문과 첨부 양식을 확인한 뒤 기관이 요구하는 항목명에 맞춰 내용을 조정해야 합니다.",
  ];
}

function confirmationLines(missingFields: MissingFieldQuestion[], warnings: string[]): string[] {
  const lines: string[] = [];
  if (missingFields.length === 0 && warnings.length === 0) return ["- 제출 전 공고 원문과 첨부 양식을 최종 확인하세요."];
  for (const field of missingFields) {
    lines.push(`- ${field.label}: ${field.reason}`);
  }
  for (const warning of warnings) {
    lines.push(`- ${warning}`);
  }
  return lines;
}

function buildAssumptions(input: GenerateDocumentDraftInput): string[] {
  return [
    "회사 프로필과 공고에서 확인된 정보만 사용했습니다.",
    input.document.sourceAttachment
      ? "연결 첨부의 markdown 문맥을 기준으로 문서 유형을 판단했습니다."
      : "연결 첨부가 없어 공고의 제출서류명과 매칭 조건을 기준으로 초안을 만들었습니다.",
  ];
}

function buildWarnings(input: GenerateDocumentDraftInput, autofill: DocumentAutofillResult): string[] {
  const warnings = ["AI 초안은 제출 전 사용자 검토가 필요합니다."];
  if (!input.document.sourceAttachment) warnings.push("원본 양식 연결이 없어 기관 양식의 항목 순서를 직접 확인해야 합니다.");
  if (autofill.missingFields.length > 0) warnings.push("누락된 정보가 있어 일부 문장은 보완 후 제출해야 합니다.");
  return warnings;
}

function field(autofill: DocumentAutofillResult, label: string, fallback = "미입력"): string {
  return autofill.filledFields[label] ?? fallback;
}

function answer(autofill: DocumentAutofillResult, label: string, fallback: string): string {
  return autofill.filledFields[label] ?? fallback;
}

function documentCategoryLabel(category: DraftableDocument["category"]): string {
  if (category === "application_form") return "신청서";
  if (category === "business_plan") return "사업계획서";
  if (category === "proposal_or_intro") return "제안서/소개서";
  if (category === "estimate_budget") return "예산/산출내역";
  if (category === "performance_evidence") return "실적 설명";
  if (category === "recommendation") return "추천서";
  return "작성 문서";
}

function formatSupportAmount(amount: SupportAmount): string {
  if (amount.label) return amount.label;
  if (amount.max) return `${new Intl.NumberFormat("ko-KR").format(amount.max)}원`;
  return "금액 미확인";
}
