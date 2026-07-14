import type {
  GrantDocumentCategory,
  GrantDocumentPreparationType,
  GrantDocumentSource,
  GrantRequiredDocument,
} from "@cunote/contracts";

export interface DocumentTextSource {
  text: string | null | undefined;
  source?: GrantDocumentSource;
  sourceAttachment?: string;
  sourceField?: string;
}

export interface NormalizeGrantDocumentsInput {
  documents?: GrantRequiredDocument[] | null;
  textSources?: DocumentTextSource[];
}

export interface NormalizeGrantDocumentsResult {
  documents: GrantRequiredDocument[];
  extractedCount: number;
  normalizedCount: number;
  categoryCounts: Record<GrantDocumentCategory, number>;
  preparationCounts: Record<GrantDocumentPreparationType, number>;
}

export interface EnrichGrantDocumentAttachmentsResult {
  documents: GrantRequiredDocument[];
  linkedCount: number;
  ambiguousCount: number;
}

export interface ResolveGrantDocumentAttachmentsResult extends EnrichGrantDocumentAttachmentsResult {
  inferredCount: number;
  /** 결과 documents 각 항목의 원래 existing index. 첨부에서 새로 합성한 항목은 null. */
  existingDocumentIndexes: Array<number | null>;
}

interface DocumentRule {
  category: GrantDocumentCategory;
  preparationType: GrantDocumentPreparationType;
  canonicalName: string;
  source: GrantDocumentSource;
  templateRequired: boolean;
  confidence: number;
  patterns: RegExp[];
}

const DOCUMENT_RULES: DocumentRule[] = [
  {
    category: "application_form",
    preparationType: "write",
    canonicalName: "신청서",
    source: "portal",
    templateRequired: true,
    confidence: 0.9,
    patterns: [/신청서|지원서|참가신청서|사업신청서|입점신청서|융자신청서/],
  },
  {
    category: "business_plan",
    preparationType: "write",
    canonicalName: "사업계획서",
    source: "portal",
    templateRequired: true,
    confidence: 0.9,
    patterns: [/사업\s*계획서|수행계획서|운영계획서|참가계획서|개발계획서|활용계획서|과제수행계획서/],
  },
  {
    category: "proposal_or_intro",
    preparationType: "write",
    canonicalName: "제안서/소개서",
    source: "self",
    templateRequired: true,
    confidence: 0.82,
    patterns: [/제안서|회사소개서|기업소개|사업소개서|영문\s*사업소개서|발표자료|IR|피치덱|포트폴리오/],
  },
  {
    category: "consent_or_pledge",
    preparationType: "write",
    canonicalName: "동의서/서약서",
    source: "portal",
    templateRequired: true,
    confidence: 0.9,
    patterns: [/동의서|서약서|확약서|청렴|중복지원|성실의무|정보\s*활용.*동의/],
  },
  {
    category: "business_registration",
    preparationType: "issue",
    canonicalName: "사업자등록증",
    source: "self",
    templateRequired: false,
    confidence: 0.95,
    patterns: [/사업자등록증(?:명원|명)?/],
  },
  {
    category: "corporate_register",
    preparationType: "issue",
    canonicalName: "법인등기부등본",
    source: "self",
    templateRequired: false,
    confidence: 0.95,
    patterns: [/법인\s*등기|법인등기부등본|등기사항증명서|등기부등본/],
  },
  {
    category: "company_confirmation",
    preparationType: "issue",
    canonicalName: "기업 확인서",
    source: "cert",
    templateRequired: false,
    confidence: 0.9,
    patterns: [/중소기업확인서|소상공인확인서|벤처기업확인서|여성기업확인서|장애인기업확인서|확인서\(소상공인\)/],
  },
  {
    category: "financial_tax",
    preparationType: "issue",
    canonicalName: "재무/세무 증빙",
    source: "self",
    templateRequired: false,
    confidence: 0.88,
    patterns: [/재무제표|표준재무|부가세|국세|지방세|납세|완납|세금|원천징수|과세표준|소득금액증명/],
  },
  {
    category: "employment_insurance",
    preparationType: "issue",
    canonicalName: "4대보험/고용 증빙",
    source: "self",
    templateRequired: false,
    confidence: 0.86,
    patterns: [/4대\s*사회보험|가입자명부|고용보험|건강보험|사업장가입자|보험\s*가입/],
  },
  {
    category: "shareholder",
    preparationType: "attach",
    canonicalName: "주주명부",
    source: "self",
    templateRequired: false,
    confidence: 0.9,
    patterns: [/주주명부|주주\s*현황/],
  },
  {
    category: "bank_account",
    preparationType: "attach",
    canonicalName: "통장사본",
    source: "self",
    templateRequired: false,
    confidence: 0.9,
    patterns: [/통장사본|계좌\s*사본|계좌확인/],
  },
  {
    category: "estimate_budget",
    preparationType: "write",
    canonicalName: "견적/예산/산출내역",
    source: "self",
    templateRequired: false,
    confidence: 0.86,
    patterns: [/견적서|비교견적|산출내역|예산|사업비|소요비용|등록가능성\s*검토의견서/],
  },
  {
    category: "portfolio_catalog",
    preparationType: "attach",
    canonicalName: "제품/회사 소개자료",
    source: "self",
    templateRequired: false,
    confidence: 0.82,
    patterns: [/카탈로그|브로슈어|포트폴리오|룩북|라인시트|제품설명서|제품소개|제품자료/],
  },
  {
    category: "ip_certification",
    preparationType: "issue",
    canonicalName: "인증/IP 증빙",
    source: "cert",
    templateRequired: false,
    confidence: 0.86,
    patterns: [/특허|지식재산|PCT|IP|인증서|인증|확인증|기업부설연구소/],
  },
  {
    category: "recommendation",
    preparationType: "write",
    canonicalName: "추천서",
    source: "self",
    templateRequired: false,
    confidence: 0.88,
    patterns: [/추천서/],
  },
  {
    category: "performance_evidence",
    preparationType: "attach",
    canonicalName: "실적 증빙",
    source: "self",
    templateRequired: false,
    confidence: 0.82,
    patterns: [/실적|수출|매출|납품|이체확인|거래내역|영수증|세금계산서|카드매출전표|참가결과/],
  },
];

export function normalizeGrantDocuments(input: NormalizeGrantDocumentsInput): NormalizeGrantDocumentsResult {
  const existing = (input.documents ?? []).map(normalizeGrantRequiredDocument);
  const extracted = extractGrantRequiredDocumentCandidates(input.textSources ?? []);
  const documents = mergeGrantRequiredDocuments(existing, extracted);

  return {
    documents,
    extractedCount: extracted.length,
    normalizedCount: documents.length,
    categoryCounts: countBy(documents, "category"),
    preparationCounts: countBy(documents, "preparation_type"),
  };
}

/**
 * 기존 제출서류의 순서·분류·documentKey 재료는 그대로 두고, 첨부 근거가 하나로 확정되는 항목에만
 * 원본 파일명을 연결한다. ApplySheet 조립 시 수집 첨부와 required_documents 를 잇는 런타임 브리지다.
 *
 * 같은 canonical 문서에 서로 다른 첨부가 둘 이상이면 임의로 고르지 않는다. 원본 파일명은 이후
 * grant_attachment_archives 에서 R2 storage key 로 해석된다.
 */
export function enrichGrantRequiredDocumentAttachments(
  input: NormalizeGrantDocumentsInput,
): EnrichGrantDocumentAttachmentsResult {
  const existing = (input.documents ?? []).map(normalizeGrantRequiredDocument);
  const extracted = extractGrantRequiredDocumentCandidates(input.textSources ?? []);
  return enrichMissingSourceAttachments(existing, extracted);
}

/**
 * 작성 서류가 비어 있는 공고는 수집·보관된 원본 양식이 있어도 워크스페이스에 진입할 수 없다.
 * HWP/HWPX 첨부 파일명 자체가 신청서 또는 사업계획서임을 명확히 드러내는 경우에만 런타임
 * 작성 서류를 합성한다. 공고문·안내문과 PDF/DOCX는 이 경로에서 추정하지 않는다.
 *
 * 기존 required_documents가 같은 canonical 문서를 이미 기술하면 해당 문서를 우선하며,
 * 서로 다른 대상용 양식은 source_attachment 단위로 각각 유지한다.
 */
export function resolveGrantRequiredDocumentsFromAttachments(
  input: NormalizeGrantDocumentsInput,
): ResolveGrantDocumentAttachmentsResult {
  const existing = (input.documents ?? []).map(normalizeGrantRequiredDocument);
  const extracted = extractGrantRequiredDocumentCandidates(input.textSources ?? []);
  const attachmentFilenameSources = (input.textSources ?? []).filter(isHwpAttachmentFilenameSource);
  const hwpTemplateCandidates = extractGrantRequiredDocumentCandidates(attachmentFilenameSources);
  const enriched = enrichMissingSourceAttachments(existing, extracted);
  const hwpCandidatesByCanonical = groupDraftTemplateCandidates(hwpTemplateCandidates);
  const documents: GrantRequiredDocument[] = [];
  const existingDocumentIndexes: Array<number | null> = [];

  for (const [index, document] of enriched.documents.entries()) {
    const canonicalCandidates = hwpCandidatesByCanonical.get(canonicalDocumentKey(document)) ?? [];
    // 일반형 "신청서" 하나와 대상별 양식 여러 개가 충돌하면 첨부 없는 일반형을 남기지 않고
    // 아래에서 각 원본 양식으로 대체한다. 임의로 하나를 골라 연결하는 것보다 안전하다.
    if (!cleanText(document.source_attachment) && canonicalCandidates.length > 1) continue;
    documents.push(document);
    existingDocumentIndexes.push(index);
  }

  const inferredKeys = new Set<string>();
  const inferred: GrantRequiredDocument[] = [];

  for (const candidate of hwpTemplateCandidates.map(normalizeGrantRequiredDocument)) {
    if (!isInferredDraftTemplateCandidate(candidate)) continue;

    const sourceAttachment = cleanText(candidate.source_attachment);
    if (!sourceAttachment) continue;
    const alreadyCovered = documents.some((document) =>
      canonicalDocumentKey(document) === canonicalDocumentKey(candidate)
      && keyPart(document.source_attachment ?? "") === keyPart(sourceAttachment)
    );
    if (alreadyCovered) continue;
    const inferredKey = `${candidate.category}:${keyPart(sourceAttachment)}`;
    if (inferredKeys.has(inferredKey)) continue;
    inferredKeys.add(inferredKey);
    inferred.push(candidate);
  }

  return {
    ...enriched,
    documents: [...documents, ...inferred],
    inferredCount: inferred.length,
    existingDocumentIndexes: [...existingDocumentIndexes, ...inferred.map(() => null)],
  };
}

export function normalizeGrantRequiredDocuments(
  documents: GrantRequiredDocument[] | null | undefined,
): GrantRequiredDocument[] | null {
  if (!documents || documents.length === 0) return null;
  const normalized = mergeGrantRequiredDocuments(documents.map(normalizeGrantRequiredDocument), []);
  return normalized.length > 0 ? normalized : null;
}

export function normalizeGrantRequiredDocument(document: GrantRequiredDocument): GrantRequiredDocument {
  const name = cleanText(document.name) ?? "제출서류";
  const evidence = cleanText(document.source_span) ?? cleanText(document.note) ?? name;
  const rule = findDocumentRule(name) ?? findDocumentRule(evidence);
  const category = document.category ?? rule?.category ?? "other";
  const preparationType = document.preparation_type ?? rule?.preparationType ?? "other";
  const canonicalName = cleanText(document.canonical_name) ?? rule?.canonicalName ?? name;
  const templateRequired = document.template_required ?? rule?.templateRequired ?? preparationType === "write";
  const confidence = clampConfidence(document.confidence ?? rule?.confidence ?? 0.55);

  return {
    ...document,
    name,
    source: document.source ?? rule?.source ?? "self",
    category,
    preparation_type: preparationType,
    canonical_name: canonicalName,
    template_required: templateRequired,
    confidence,
  };
}

export function extractGrantRequiredDocumentsFromText(textSources: DocumentTextSource[]): GrantRequiredDocument[] {
  return mergeGrantRequiredDocuments([], extractGrantRequiredDocumentCandidates(textSources));
}

function extractGrantRequiredDocumentCandidates(textSources: DocumentTextSource[]): GrantRequiredDocument[] {
  const documents: GrantRequiredDocument[] = [];

  for (const source of textSources) {
    const text = cleanRawText(source.text);
    if (!text) continue;
    const candidateLines = documentCandidateLines(text, source.sourceField);

    for (const sourceSpan of candidateLines) {
      for (const rule of DOCUMENT_RULES) {
        const pattern = rule.patterns.find((candidate) => candidate.test(sourceSpan));
        if (!pattern) continue;
        documents.push(normalizeGrantRequiredDocument({
          name: documentNameFromEvidence(sourceSpan, rule),
          required: true,
          source: source.source ?? rule.source,
          category: rule.category,
          preparation_type: rule.preparationType,
          canonical_name: rule.canonicalName,
          template_required: rule.templateRequired,
          ...(source.sourceAttachment ? { source_attachment: source.sourceAttachment } : {}),
          source_span: sourceSpan,
          ...(source.sourceField ? { note: `source_field: ${source.sourceField}` } : {}),
          confidence: rule.confidence,
        }));
      }
    }
  }

  return documents;
}

function mergeGrantRequiredDocuments(
  existing: GrantRequiredDocument[],
  extracted: GrantRequiredDocument[],
): GrantRequiredDocument[] {
  const enriched = enrichMissingSourceAttachments(existing, extracted).documents;
  const merged: GrantRequiredDocument[] = [];
  const exactKeys = new Set<string>();
  const canonicalKeys = new Set<string>();

  const push = (document: GrantRequiredDocument, mode: "existing" | "extracted") => {
    const normalized = normalizeGrantRequiredDocument(document);
    const exactKey = keyPart(normalized.name);
    const canonicalKey = [
      normalized.category ?? "other",
      keyPart(normalized.canonical_name ?? normalized.name),
    ].join(":");
    if (exactKeys.has(exactKey)) return;
    if (mode === "extracted" && canonicalKeys.has(canonicalKey)) return;
    exactKeys.add(exactKey);
    canonicalKeys.add(canonicalKey);
    merged.push(normalized);
  };

  for (const document of enriched) push(document, "existing");
  for (const document of extracted) push(document, "extracted");
  return merged;
}

function enrichMissingSourceAttachments(
  existing: GrantRequiredDocument[],
  extracted: GrantRequiredDocument[],
): EnrichGrantDocumentAttachmentsResult {
  const candidates = extracted
    .map(normalizeGrantRequiredDocument)
    .filter((document): document is GrantRequiredDocument & { source_attachment: string } =>
      Boolean(cleanText(document.source_attachment))
    );
  let linkedCount = 0;
  let ambiguousCount = 0;

  const documents = existing.map((document) => {
    const normalized = normalizeGrantRequiredDocument(document);
    if (cleanText(normalized.source_attachment)) return normalized;

    const exactCandidates = candidates.filter((candidate) =>
      keyPart(candidate.name) === keyPart(normalized.name)
    );
    const canonicalCandidates = candidates.filter((candidate) =>
      canonicalDocumentKey(candidate) === canonicalDocumentKey(normalized)
    );
    const exactAttachment = uniqueSourceAttachment(exactCandidates);
    const canonicalAttachment = uniqueSourceAttachment(canonicalCandidates);
    const sourceAttachment = exactAttachment.value ?? canonicalAttachment.value;

    if (sourceAttachment) {
      linkedCount += 1;
      return { ...normalized, source_attachment: sourceAttachment };
    }
    if (exactAttachment.ambiguous || canonicalAttachment.ambiguous) ambiguousCount += 1;
    return normalized;
  });

  return { documents, linkedCount, ambiguousCount };
}

function uniqueSourceAttachment(
  documents: Array<GrantRequiredDocument & { source_attachment: string }>,
): { value: string | null; ambiguous: boolean } {
  const values = [...new Set(documents.map((document) => cleanText(document.source_attachment)).filter(Boolean))];
  return {
    value: values.length === 1 ? values[0]! : null,
    ambiguous: values.length > 1,
  };
}

function canonicalDocumentKey(document: GrantRequiredDocument): string {
  return [
    document.category ?? "other",
    keyPart(document.canonical_name ?? document.name),
  ].join(":");
}

function isHwpAttachmentFilenameSource(source: DocumentTextSource): boolean {
  if (source.sourceField !== "attachment_filename") return false;
  const filename = cleanText(source.sourceAttachment) ?? cleanText(source.text);
  return Boolean(filename && /\.(?:hwp|hwpx)$/iu.test(filename));
}

function isInferredDraftTemplateCandidate(document: GrantRequiredDocument): boolean {
  return document.preparation_type === "write"
    && document.template_required === true
    && (document.category === "application_form" || document.category === "business_plan");
}

function groupDraftTemplateCandidates(
  documents: GrantRequiredDocument[],
): Map<string, GrantRequiredDocument[]> {
  const groups = new Map<string, GrantRequiredDocument[]>();
  const seen = new Set<string>();
  for (const document of documents.map(normalizeGrantRequiredDocument)) {
    if (!isInferredDraftTemplateCandidate(document)) continue;
    const sourceAttachment = cleanText(document.source_attachment);
    if (!sourceAttachment) continue;
    const canonicalKey = canonicalDocumentKey(document);
    const uniqueKey = `${canonicalKey}:${keyPart(sourceAttachment)}`;
    if (seen.has(uniqueKey)) continue;
    seen.add(uniqueKey);
    groups.set(canonicalKey, [...(groups.get(canonicalKey) ?? []), document]);
  }
  return groups;
}

function findDocumentRule(value: string): DocumentRule | undefined {
  return DOCUMENT_RULES.find((rule) => rule.patterns.some((pattern) => pattern.test(value)));
}

function documentCandidateLines(text: string, sourceField: string | undefined): string[] {
  if (sourceField === "attachment_filename") return [text.slice(0, 240)];

  const lines = text
    .split(/\r?\n/)
    .map((line) => cleanEvidenceLine(line))
    .filter(Boolean);
  if (lines.length === 0) return [];
  if (isCompactDocumentText(text, lines, sourceField)) {
    return uniqueLines(lines.filter(isDocumentCandidateLine));
  }

  const candidates: string[] = [];
  let sectionLineBudget = 0;
  for (const line of lines) {
    if (isDocumentSectionHeader(line)) {
      sectionLineBudget = 36;
      continue;
    }
    if (sectionLineBudget > 0) {
      if (isLikelyNextSectionHeader(line) && !isDocumentCandidateLine(line)) {
        sectionLineBudget = 0;
        continue;
      }
      if (isDocumentCandidateLine(line)) candidates.push(line.slice(0, 240));
      sectionLineBudget -= 1;
      continue;
    }
    if (isExplicitDocumentLine(line)) candidates.push(line.slice(0, 240));
  }
  return uniqueLines(candidates);
}

function isCompactDocumentText(text: string, lines: string[], sourceField: string | undefined): boolean {
  if (sourceField === "apply_method") return true;
  if (sourceField === "attachment_markdown") return false;
  return text.length <= 700 && lines.length <= 12;
}

function isDocumentSectionHeader(value: string): boolean {
  return /제출\s*서류|신청\s*서류|구비\s*서류|첨부\s*서류|제출\s*문서|제출\s*양식|신청\s*양식|제출\s*목록|제출\s*자료|필수\s*서류|증빙\s*서류/.test(value);
}

function isLikelyNextSectionHeader(value: string): boolean {
  return /^#{1,6}\s*\S/.test(value)
    || /^[-=]{3,}$/.test(value)
    || /^(지원내용|지원\s*내용|신청방법|접수방법|문의처|유의사항|평가방법|선정방법|추진절차|사업개요|모집개요|지원대상|신청자격)\b/.test(value);
}

function isDocumentCandidateLine(value: string): boolean {
  return DOCUMENT_RULES.some((rule) => rule.patterns.some((pattern) => pattern.test(value)));
}

function isExplicitDocumentLine(value: string): boolean {
  if (!isDocumentCandidateLine(value)) return false;
  return /제출|첨부|구비|서류|양식|서식|발급|증빙|사본|원본|각\s*\d+\s*부/.test(value);
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const line of lines) {
    const key = keyPart(line);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return unique;
}

function documentNameFromEvidence(evidence: string | undefined, rule: DocumentRule): string {
  if (!evidence) return rule.canonicalName;
  const candidate = evidence
    .replace(/^[\s*\-•·\d.)()[\]①-⑳]+/u, "")
    .replace(/^(붙임|첨부|서식)\s*\d*[\s.)_-]*/u, "")
    .replace(/\.(hwp|hwpx|pdf|docx?|xlsx?|zip)$/iu, "")
    .trim();
  if (candidateHasMultipleDocumentTypes(candidate)) return rule.canonicalName;
  if (candidate.length >= 2 && candidate.length <= 48 && rule.patterns.some((pattern) => pattern.test(candidate))) {
    return candidate;
  }
  return rule.canonicalName;
}

function candidateHasMultipleDocumentTypes(value: string): boolean {
  if (/[,，、]/.test(value)) return true;
  const matchedRuleCount = DOCUMENT_RULES.filter((rule) => rule.patterns.some((pattern) => pattern.test(value))).length;
  return matchedRuleCount > 1;
}

function cleanEvidenceLine(value: string): string {
  return value
    .replace(/<[^>]+>/g, " ")
    .replace(/[|`#>*_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function cleanRawText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\r\n/g, "\n").trim();
  return cleaned.length > 0 ? cleaned : null;
}

function keyPart(value: string): string {
  return value.replace(/\s+/g, "").toLowerCase();
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.55;
  return Math.max(0, Math.min(1, value));
}

function countBy<TKey extends "category" | "preparation_type">(
  documents: GrantRequiredDocument[],
  field: TKey,
): Record<TKey extends "category" ? GrantDocumentCategory : GrantDocumentPreparationType, number> {
  const counts: Record<string, number> = {};
  for (const document of documents) {
    const key = document[field] ?? "other";
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts as Record<TKey extends "category" ? GrantDocumentCategory : GrantDocumentPreparationType, number>;
}
