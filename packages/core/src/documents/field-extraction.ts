import type {
  DocumentField,
  DocumentFieldType,
  DocumentFillStrategy,
  GrantDocumentCategory,
  RequiredDocument,
} from "@cunote/contracts";

export const GRANT_DOCUMENT_FIELD_PARSER_VERSION = "grant-document-field-extraction-v1";

export interface GrantDocumentFieldMarkdown {
  filename: string;
  markdown: string | null | undefined;
}

export interface ExtractGrantDocumentFieldsInput {
  documents: RequiredDocument[];
  attachmentMarkdowns?: GrantDocumentFieldMarkdown[];
}

export interface ExtractedGrantDocumentField extends DocumentField {
  documentCategory: GrantDocumentCategory | "other";
  documentName: string;
  parserVersion: string;
}

interface FieldContext {
  document: RequiredDocument;
  category: GrantDocumentCategory | "other";
  documentName: string;
  sourceAttachment: string | null;
}

interface FieldRule {
  key: string;
  mappedCompanyField: string | null;
  fieldType: DocumentFieldType;
  fillStrategy: DocumentFillStrategy;
  patterns: RegExp[];
}

const DRAFTABLE_FIELD_CATEGORIES = new Set<GrantDocumentCategory | "other">([
  "application_form",
  "business_plan",
  "proposal_or_intro",
  "estimate_budget",
  "performance_evidence",
  "recommendation",
  "other",
]);

const FIELD_RULES: FieldRule[] = [
  {
    key: "company.name",
    mappedCompanyField: "name",
    fieldType: "text",
    fillStrategy: "copy",
    patterns: [/기업\s*명|회사\s*명|상호|업체\s*명|신청\s*기업/],
  },
  {
    key: "company.representative",
    mappedCompanyField: "representative_name",
    fieldType: "text",
    fillStrategy: "copy",
    patterns: [/대표자|대표\s*성명|대표\s*명/],
  },
  {
    key: "company.biz_no",
    mappedCompanyField: "biz_no",
    fieldType: "text",
    fillStrategy: "copy",
    patterns: [/사업자\s*등록\s*번호|사업자번호|등록번호/],
  },
  {
    key: "company.region",
    mappedCompanyField: "region",
    fieldType: "text",
    fillStrategy: "copy",
    patterns: [/소재지|주소|사업장\s*소재지|본사\s*주소/],
  },
  {
    key: "company.industries",
    mappedCompanyField: "industries",
    fieldType: "text",
    fillStrategy: "summarize",
    patterns: [/업종|업태|산업|분야|주요\s*사업/],
  },
  {
    key: "company.revenue",
    mappedCompanyField: "revenue",
    fieldType: "currency",
    fillStrategy: "copy",
    patterns: [/매출|매출액|재무\s*현황|최근\s*매출/],
  },
  {
    key: "company.employees",
    mappedCompanyField: "employees",
    fieldType: "number",
    fillStrategy: "copy",
    patterns: [/임직원|직원|고용|상시\s*근로자|종업원/],
  },
  {
    key: "company.certifications",
    mappedCompanyField: "certifications",
    fieldType: "long_text",
    fillStrategy: "summarize",
    patterns: [/인증|특허|지식재산|IP|수상|실적/],
  },
  {
    key: "business.product_summary",
    mappedCompanyField: null,
    fieldType: "long_text",
    fillStrategy: "ask_user",
    patterns: [/제품|서비스|아이템|솔루션|사업\s*개요|과제\s*개요|개발\s*내용/],
  },
  {
    key: "business.apply_goal",
    mappedCompanyField: null,
    fieldType: "long_text",
    fillStrategy: "ask_user",
    patterns: [/지원\s*동기|신청\s*목적|지원\s*목적|필요성|추진\s*배경|목표/],
  },
  {
    key: "business.execution_plan",
    mappedCompanyField: null,
    fieldType: "long_text",
    fillStrategy: "generate",
    patterns: [/추진\s*계획|수행\s*계획|활용\s*계획|세부\s*계획|일정|로드맵/],
  },
  {
    key: "business.expected_outcomes",
    mappedCompanyField: null,
    fieldType: "long_text",
    fillStrategy: "generate",
    patterns: [/기대\s*효과|성과|파급\s*효과|고용\s*창출|매출\s*증대|시장\s*확대/],
  },
  {
    key: "business.budget_items",
    mappedCompanyField: null,
    fieldType: "table",
    fillStrategy: "ask_user",
    patterns: [/예산|사업비|산출\s*내역|소요\s*비용|견적|집행\s*계획/],
  },
  {
    key: "manual.attachment",
    mappedCompanyField: null,
    fieldType: "file",
    fillStrategy: "manual",
    patterns: [/첨부|파일|증빙\s*자료|제출\s*자료/],
  },
  {
    key: "manual.signature",
    mappedCompanyField: null,
    fieldType: "text",
    fillStrategy: "manual",
    patterns: [/서명|날인|직인|확약|동의|서약/],
  },
];

const CATEGORY_DEFAULT_LABELS: Record<string, string[]> = {
  application_form: ["기업명", "대표자", "사업자등록번호", "소재지", "업종/분야", "제품/서비스 설명"],
  business_plan: ["제품/서비스 설명", "이번 지원으로 달성할 목표", "추진 계획", "기대 효과", "예산 항목과 산출근거"],
  proposal_or_intro: ["기업명", "제품/서비스 설명", "차별성", "협력 제안"],
  estimate_budget: ["예산 항목과 산출근거", "집행 계획", "견적 근거"],
  performance_evidence: ["대표 실적 요약", "증빙 계획"],
  recommendation: ["기업명", "추천 요청 목적", "추천 사유"],
};

const FIELD_LABEL_KEYWORDS = [
  "기업",
  "회사",
  "대표",
  "사업자",
  "소재",
  "주소",
  "업종",
  "분야",
  "제품",
  "서비스",
  "사업",
  "과제",
  "지원",
  "목표",
  "계획",
  "성과",
  "효과",
  "예산",
  "사업비",
  "견적",
  "실적",
  "인증",
  "특허",
  "고용",
  "매출",
  "추천",
  "서명",
  "날인",
];

const NON_FIELD_PATTERNS = [
  /지원\s*내용$/,
  /지원\s*대상$/,
  /모집\s*개요$/,
  /제출\s*서류$/,
  /접수\s*기간$/,
  /접수\s*방법$/,
  /멘토링\s*지원/,
  /IR\s*자료\s*제작/,
  /자료\s*제작\s*및\s*업그레이드/,
  /교육\s*지원/,
  /컨설팅\s*지원/,
];

const HEADER_LABELS = new Set(["항목", "내용", "작성내용", "세부내용", "구분", "비고", "작성란"]);

export function extractGrantDocumentFields(input: ExtractGrantDocumentFieldsInput): ExtractedGrantDocumentField[] {
  return input.documents.flatMap((document) =>
    extractGrantDocumentFieldsForDocument({
      document,
      attachmentMarkdowns: input.attachmentMarkdowns ?? [],
    })
  );
}

export function extractGrantDocumentFieldsForDocument(input: {
  document: RequiredDocument;
  attachmentMarkdowns?: GrantDocumentFieldMarkdown[];
}): ExtractedGrantDocumentField[] {
  if (!isFieldExtractableDocument(input.document)) return [];

  const context = documentContext(input.document);
  const fields: ExtractedGrantDocumentField[] = [];
  const seen = new Set<string>();
  const add = (label: string, sourceSpan: string | null, confidence: number) => {
    const normalized = cleanFieldLabel(label);
    if (!normalized || !isLikelyFieldLabel(normalized, context.category)) return;
    const field = buildField(normalized, context, sourceSpan, confidence);
    const key = `${field.fieldKey}:${field.label}`;
    if (seen.has(key)) return;
    seen.add(key);
    fields.push(field);
  };

  addFieldsFromDocumentEvidence(context, add);
  for (const markdown of matchingMarkdowns(context, input.attachmentMarkdowns ?? [])) {
    for (const candidate of fieldCandidatesFromMarkdown(markdown.markdown ?? "")) {
      add(candidate.label, candidate.sourceSpan, candidate.confidence);
    }
  }
  for (const label of CATEGORY_DEFAULT_LABELS[context.category] ?? []) {
    add(label, null, 0.5);
  }

  return fields;
}

function isFieldExtractableDocument(document: RequiredDocument): boolean {
  const category = document.category ?? "other";
  if (document.preparationType !== "write") return false;
  if (category === "consent_or_pledge") return false;
  return DRAFTABLE_FIELD_CATEGORIES.has(category);
}

function documentContext(document: RequiredDocument): FieldContext {
  return {
    document,
    category: document.category ?? "other",
    documentName: document.canonicalName ?? document.name,
    sourceAttachment: document.sourceAttachment ?? null,
  };
}

function addFieldsFromDocumentEvidence(
  context: FieldContext,
  add: (label: string, sourceSpan: string | null, confidence: number) => void,
) {
  add(context.documentName, context.document.sourceSpan ?? null, 0.58);
  if (context.document.sourceSpan) {
    for (const label of splitCompositeLabel(context.document.sourceSpan)) {
      add(label, context.document.sourceSpan, 0.6);
    }
  }
}

function fieldCandidatesFromMarkdown(markdown: string): Array<{ label: string; sourceSpan: string; confidence: number }> {
  const lines = markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const candidates: Array<{ label: string; sourceSpan: string; confidence: number }> = [];

  for (const line of lines) {
    if (isMarkdownTableSeparator(line)) continue;
    for (const label of labelsFromTableLine(line)) {
      candidates.push({ label, sourceSpan: line, confidence: 0.82 });
    }
    const label = labelFromPlainLine(line);
    if (label) candidates.push({ label, sourceSpan: line, confidence: 0.74 });
  }

  return candidates;
}

function labelsFromTableLine(line: string): string[] {
  if (!line.includes("|")) return [];
  const cells = line
    .split("|")
    .map((cell) => cleanFieldLabel(cell))
    .filter((cell): cell is string => Boolean(cell));
  if (cells.length < 2) return [];

  const labels: string[] = [];
  const [first, second] = cells;
  if (first && !HEADER_LABELS.has(first) && isLikelyFieldLabel(first, "other")) labels.push(first);
  if (second && !HEADER_LABELS.has(second) && isLikelyFieldLabel(second, "other") && !looksLikeFilledValue(second)) {
    labels.push(second);
  }
  return labels;
}

function labelFromPlainLine(line: string): string | null {
  const cleaned = cleanFieldLabel(line);
  if (!cleaned) return null;
  if (containsBlankMarker(line) || /[:：]\s*$/.test(line)) return cleaned;

  const numbered = cleaned.match(/^(?:\d{1,2}[.)]|[가-힣][.)]|[IVX]+[.)])\s*(?<label>.+)$/i)?.groups?.label;
  if (numbered) return cleanFieldLabel(numbered);

  const heading = cleaned.match(/^#{1,4}\s*(?<label>.+)$/)?.groups?.label;
  if (heading) return cleanFieldLabel(heading);

  return null;
}

function buildField(
  label: string,
  context: FieldContext,
  sourceSpan: string | null,
  confidence: number,
): ExtractedGrantDocumentField {
  const rule = FIELD_RULES.find((candidate) => candidate.patterns.some((pattern) => pattern.test(label)));
  const fieldKey = rule?.key ?? `manual.${slug(label)}`;
  return {
    documentCategory: context.category,
    documentName: context.documentName,
    fieldKey,
    label,
    section: inferSection(label, context.category),
    fieldType: rule?.fieldType ?? defaultFieldType(label),
    required: context.document.required,
    sourceSpan,
    sourceAttachment: context.sourceAttachment,
    mappedCompanyField: rule?.mappedCompanyField ?? null,
    fillStrategy: rule?.fillStrategy ?? defaultFillStrategy(label),
    confidence: clampConfidence(confidence + (rule ? 0.08 : 0)),
    parserVersion: GRANT_DOCUMENT_FIELD_PARSER_VERSION,
  };
}

function matchingMarkdowns(
  context: FieldContext,
  markdowns: GrantDocumentFieldMarkdown[],
): GrantDocumentFieldMarkdown[] {
  const usable = markdowns.filter((markdown) => Boolean(markdown.markdown?.trim()));
  if (usable.length === 0) return [];
  if (context.sourceAttachment) {
    const exact = usable.filter((markdown) => sameFilename(markdown.filename, context.sourceAttachment!));
    if (exact.length > 0) return exact;
  }
  const documentName = keyText(context.documentName);
  const loose = usable.filter((markdown) => {
    const filename = keyText(markdown.filename);
    return filename.includes(documentName) || documentName.includes(filename.replace(/\.(hwp|hwpx|docx|pdf|md)$/i, ""));
  });
  if (loose.length > 0) return loose;
  return usable.length === 1 ? usable : [];
}

function splitCompositeLabel(value: string): string[] {
  return value
    .split(/[,，·ㆍ/]|및|또는|각\s*\d부|\n/)
    .map((item) => cleanFieldLabel(item))
    .filter((item): item is string => Boolean(item));
}

function cleanFieldLabel(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/^#+\s*/, "")
    .replace(/^\s*(?:[-*•·]|□|■|○|◦|▶)\s*/, "")
    .replace(/^\s*(?:\d{1,2}[.)]|[가-힣][.)]|[IVX]+[.)])\s*/i, "")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*필수[^)]*\)/g, " ")
    .replace(/\([^)]*선택[^)]*\)/g, " ")
    .replace(/[_＿]{2,}/g, " ")
    .replace(/\s*[:：]\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length < 2 || cleaned.length > 80) return null;
  return cleaned;
}

function isLikelyFieldLabel(label: string, category: GrantDocumentCategory | "other"): boolean {
  if (NON_FIELD_PATTERNS.some((pattern) => pattern.test(label))) return false;
  if (HEADER_LABELS.has(label)) return false;
  if (FIELD_RULES.some((rule) => rule.patterns.some((pattern) => pattern.test(label)))) return true;
  if (FIELD_LABEL_KEYWORDS.some((keyword) => label.includes(keyword))) return true;
  return category === "business_plan" && /개요|계획|효과|성과|예산|목표/.test(label);
}

function defaultFieldType(label: string): DocumentFieldType {
  if (/예산|사업비|산출|견적/.test(label)) return "table";
  if (/매출|금액|비용/.test(label)) return "currency";
  if (/인원|직원|고용/.test(label)) return "number";
  if (/첨부|파일|증빙/.test(label)) return "file";
  if (label.length > 16 || /계획|효과|성과|개요|목표|소개|설명/.test(label)) return "long_text";
  return "text";
}

function defaultFillStrategy(label: string): DocumentFillStrategy {
  if (/서명|날인|직인|첨부|파일|증빙/.test(label)) return "manual";
  if (/기업명|회사명|대표|소재|주소|사업자/.test(label)) return "copy";
  if (/인증|특허|실적|업종|분야/.test(label)) return "summarize";
  if (/계획|효과|성과|동기|목표|소개|설명/.test(label)) return "generate";
  return "ask_user";
}

function inferSection(label: string, category: GrantDocumentCategory | "other"): string | null {
  if (/기업|회사|대표|사업자|소재|주소|업종/.test(label)) return "기본 정보";
  if (/예산|사업비|견적|산출/.test(label)) return "예산";
  if (/성과|효과|실적/.test(label)) return "성과";
  if (/계획|목표|동기|제품|서비스|개요/.test(label)) return category === "business_plan" ? "사업계획" : "작성 내용";
  return null;
}

function looksLikeFilledValue(value: string): boolean {
  return /\d{2,}|년|월|원|개|명|%|http/.test(value) && !FIELD_LABEL_KEYWORDS.some((keyword) => value.includes(keyword));
}

function containsBlankMarker(value: string): boolean {
  return /_{2,}|＿{2,}|\(\s*\)|\[\s*]/.test(value);
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function sameFilename(left: string, right: string): boolean {
  return keyText(left) === keyText(right);
}

function keyText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, "").trim();
}

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^0-9a-z가-힣]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return normalized || "field";
}

function clampConfidence(value: number): number {
  return Math.max(0.1, Math.min(0.98, Number(value.toFixed(2))));
}
