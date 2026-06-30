import type {
  ApplicationPrep,
  CompanyProfile,
  DocumentAutofillResult,
  DraftCoverage,
  DraftableDocument,
  GrantDocumentCategory,
  GrantDocumentPreparationType,
  MissingFieldQuestion,
  PlanDraftPrompt,
  ProfileCopyField,
  RequiredDocument,
} from "@cunote/contracts";

export interface BuildDocumentPreparationInput {
  documents: RequiredDocument[];
  profileCopyFields: ProfileCopyField[];
  planDraftPrompts: PlanDraftPrompt[];
  company?: CompanyProfile;
}

const DRAFTABLE_CATEGORIES = new Set<GrantDocumentCategory | "other">([
  "application_form",
  "business_plan",
  "proposal_or_intro",
  "estimate_budget",
  "performance_evidence",
  "recommendation",
]);

export function buildDocumentPreparation(input: BuildDocumentPreparationInput): ApplicationPrep {
  const documentGroups = buildDocumentGroups(input.documents);
  const draftableDocuments = input.documents
    .filter(isDraftableDocument)
    .map((document, index) => toDraftableDocument(document, index, input.company));
  const issuableDocuments = input.documents.filter((document) => document.preparationType === "issue");
  const attachableDocuments = input.documents.filter((document) => document.preparationType === "attach");
  const missingProfileFields = buildMissingFieldQuestions(draftableDocuments, input.company);
  const draftCoverage = buildDraftCoverage({
    documents: input.documents,
    draftableDocuments,
    missingProfileFields,
  });

  return {
    autoSubmitSupported: false,
    profileCopyFields: input.profileCopyFields,
    planDraftPrompts: input.planDraftPrompts,
    documentGroups,
    draftableDocuments,
    issuableDocuments,
    attachableDocuments,
    missingProfileFields,
    draftCoverage,
  };
}

export function autofillDraftFields(input: {
  document: DraftableDocument;
  profileCopyFields: ProfileCopyField[];
  missingProfileFields: MissingFieldQuestion[];
  answers?: Record<string, string>;
}): DocumentAutofillResult {
  const filledFields: Record<string, string> = {};
  const usedProfileFields: string[] = [];
  for (const field of input.profileCopyFields) {
    filledFields[field.label] = field.value;
    if (field.source === "company_profile") usedProfileFields.push(field.label);
  }

  const answers = input.answers ?? {};
  for (const [key, value] of Object.entries(answers)) {
    const cleaned = value.trim();
    if (cleaned) filledFields[key] = cleaned;
  }

  const missingFields = input.missingProfileFields.filter((field) => {
    if (field.documentName && field.documentName !== input.document.name) return false;
    return !filledFields[field.label] && !filledFields[field.fieldKey];
  });

  return {
    filledFields,
    missingFields,
    usedProfileFields,
  };
}

function buildDocumentGroups(documents: RequiredDocument[]): ApplicationPrep["documentGroups"] {
  const groups: Array<{
    preparationType: GrantDocumentPreparationType | "unknown";
    label: string;
    description: string;
    documents: RequiredDocument[];
  }> = [
    {
      preparationType: "write",
      label: "AI 초안 작성",
      description: "신청서, 사업계획서처럼 내용을 작성해야 하는 문서입니다.",
      documents: [],
    },
    {
      preparationType: "issue",
      label: "발급 필요",
      description: "기관이나 홈택스 등에서 발급받아야 하는 증빙입니다.",
      documents: [],
    },
    {
      preparationType: "attach",
      label: "파일 첨부",
      description: "이미 보유한 파일이나 실적 자료를 첨부해야 합니다.",
      documents: [],
    },
    {
      preparationType: "other",
      label: "원문 확인",
      description: "자동 분류 신뢰도가 낮아 공고 원문 확인이 필요합니다.",
      documents: [],
    },
  ];
  const fallback = groups.at(-1)!;
  for (const document of documents) {
    const group = groups.find((candidate) => candidate.preparationType === document.preparationType) ?? fallback;
    group.documents.push(document);
  }
  return groups.filter((group) => group.documents.length > 0);
}

function isDraftableDocument(document: RequiredDocument): boolean {
  const category = document.category ?? "other";
  if (category === "consent_or_pledge") return false;
  return document.preparationType === "write" && DRAFTABLE_CATEGORIES.has(category);
}

function toDraftableDocument(
  document: RequiredDocument,
  index: number,
  company: CompanyProfile | undefined,
): DraftableDocument {
  const category = document.category ?? "other";
  const canonicalName = document.canonicalName ?? document.name;
  const hasMissingFields = buildMissingFieldQuestionsForDocument({
    documentName: document.name,
    category,
    ...(company ? { company } : {}),
  }).length > 0;
  return {
    documentKey: documentKey(document, index),
    name: document.name,
    category,
    canonicalName,
    sourceAttachment: document.sourceAttachment ?? null,
    templateRequired: document.templateRequired ?? true,
    confidence: document.confidence ?? null,
    status: hasMissingFields ? "needs_user_input" : "not_started",
  };
}

function buildDraftCoverage(input: {
  documents: RequiredDocument[];
  draftableDocuments: DraftableDocument[];
  missingProfileFields: MissingFieldQuestion[];
}): DraftCoverage {
  return {
    totalDocuments: input.documents.length,
    draftableCount: input.draftableDocuments.length,
    issuableCount: input.documents.filter((document) => document.preparationType === "issue").length,
    attachableCount: input.documents.filter((document) => document.preparationType === "attach").length,
    otherCount: input.documents.filter((document) => !document.preparationType || document.preparationType === "other").length,
    withAttachmentContextCount: input.draftableDocuments.filter((document) => Boolean(document.sourceAttachment)).length,
    missingFieldCount: input.missingProfileFields.length,
  };
}

function buildMissingFieldQuestions(
  draftableDocuments: DraftableDocument[],
  company: CompanyProfile | undefined,
): MissingFieldQuestion[] {
  return dedupeQuestions(draftableDocuments.flatMap((document) =>
    buildMissingFieldQuestionsForDocument({
      documentName: document.name,
      category: document.category,
      ...(company ? { company } : {}),
    })
  ));
}

function buildMissingFieldQuestionsForDocument(input: {
  documentName: string;
  category: GrantDocumentCategory | "other";
  company?: CompanyProfile;
}): MissingFieldQuestion[] {
  const questions: MissingFieldQuestion[] = [];
  const add = (fieldKey: string, label: string, reason: string) => {
    questions.push({
      fieldKey,
      label,
      reason,
      documentName: input.documentName,
      category: input.category,
    });
  };

  if (!input.company?.name) add("company.name", "기업명", "신청서 기본정보에 필요합니다.");
  if (!input.company?.region) add("company.region", "소재지", "지원 대상과 신청서 기본정보에 필요합니다.");
  if (!input.company?.industries || input.company.industries.length === 0) {
    add("company.industries", "업종/분야", "사업 내용과 지원 적합성 설명에 필요합니다.");
  }

  if (input.category === "business_plan" || input.category === "proposal_or_intro") {
    add("business.product_summary", "제품/서비스 설명", "사업계획서와 제안서의 핵심 본문에 필요합니다.");
    add("business.apply_goal", "이번 지원으로 달성할 목표", "지원 동기와 기대효과를 구체화하는 데 필요합니다.");
  }
  if (input.category === "estimate_budget") {
    add("business.budget_items", "예산 항목과 산출근거", "예산/산출내역 초안에 필요합니다.");
  }
  if (input.category === "performance_evidence") {
    add("business.performance_summary", "대표 실적 요약", "실적 증빙 설명문에 필요합니다.");
  }

  return questions;
}

function dedupeQuestions(questions: MissingFieldQuestion[]): MissingFieldQuestion[] {
  const seen = new Set<string>();
  const result: MissingFieldQuestion[] = [];
  for (const question of questions) {
    const key = `${question.documentName ?? ""}:${question.fieldKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(question);
  }
  return result;
}

function documentKey(document: RequiredDocument, index: number): string {
  return [
    document.category ?? "other",
    document.canonicalName ?? document.name,
    document.sourceAttachment ?? "",
    index,
  ].map((value) => String(value).replace(/\s+/g, " ").trim()).join("::");
}
