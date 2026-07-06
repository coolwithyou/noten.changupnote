import { and, desc, eq } from "drizzle-orm";
import { generateDocumentDraftContent } from "@cunote/core";
import type {
  CompanyProfile,
  DocumentDraft,
  DocumentDraftFeedbackKind,
  DocumentDraftFeedbackRequest,
  DocumentDraftFeedbackResult,
  DocumentDraftSectionRegenerationRequest,
  DocumentDraftStatus,
  DraftGenerationRequest,
  DraftGenerationResult,
  MissingFieldQuestion,
} from "@cunote/contracts";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "../db/client";
import * as schema from "../db/schema";
import { getServiceRepositories, loadServiceApplySheet } from "../serviceData";
import { KOREA_REGION_OPTIONS } from "@/lib/regions";

const DOCUMENT_DRAFT_FEEDBACK_KINDS: DocumentDraftFeedbackKind[] = [
  "incorrect_fact",
  "missing_context",
  "format_issue",
  "too_generic",
  "other",
];

export class DocumentDraftError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
    readonly field?: string,
  ) {
    super(message);
    this.name = "DocumentDraftError";
  }
}

export async function createGrantDocumentDraft(input: {
  grantId: string;
  access: CompanyAccess;
  request: DraftGenerationRequest;
}): Promise<DraftGenerationResult> {
  const sheet = await loadServiceApplySheet(input.grantId, {
    companyId: input.access.companyId,
    userId: input.access.userId,
  });
  if (!sheet) throw new DocumentDraftError("grant_not_found", "공고를 찾지 못했습니다.", 404, "grantId");
  if (!isUuid(sheet.grant.id)) {
    throw new DocumentDraftError("grant_not_persisted", "저장된 공고만 초안을 만들 수 있습니다.", 409, "grantId");
  }

  const document = sheet.applicationPrep.draftableDocuments.find((candidate) =>
    candidate.documentKey === input.request.documentKey
  );
  if (!document) {
    throw new DocumentDraftError("document_not_draftable", "초안 작성 가능한 서류를 찾지 못했습니다.", 404, "documentKey");
  }

  const generated = generateDocumentDraftContent({
    grant: sheet.grant,
    document,
    profileCopyFields: sheet.applicationPrep.profileCopyFields,
    missingProfileFields: sheet.applicationPrep.missingProfileFields,
    ...(input.request.answers ? { answers: input.request.answers } : {}),
  });

  const db = getCunoteDb();
  const existing = await findLatestDocumentDraft({
    grantId: sheet.grant.id,
    companyId: input.access.companyId,
    userId: input.access.userId,
    documentKey: document.documentKey,
  });
  const draftValues = {
    grantId: sheet.grant.id,
    companyId: input.access.companyId,
    userId: input.access.userId,
    documentKey: document.documentKey,
    documentCategory: document.category,
    documentName: document.name,
    sourceAttachment: document.sourceAttachment,
    draftMarkdown: generated.draftMarkdown,
    filledFields: generated.autofill.filledFields,
    missingFields: generated.autofill.missingFields as unknown as Array<Record<string, unknown>>,
    usedProfileFields: generated.autofill.usedProfileFields,
    assumptions: generated.assumptions,
    warnings: generated.warnings,
    status: generated.status,
    modelVer: generated.modelVer,
    promptVer: generated.promptVer,
    parserVersion: generated.parserVersion,
    updatedAt: new Date(),
  } satisfies Partial<typeof schema.grantDocumentDrafts.$inferInsert>;

  const [row] = existing
    ? await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .update(schema.grantDocumentDrafts)
      .set(draftValues)
      .where(and(
        eq(schema.grantDocumentDrafts.id, existing.id),
        eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
      ))
      .returning())
    : await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .insert(schema.grantDocumentDrafts)
      .values(draftValues as typeof schema.grantDocumentDrafts.$inferInsert)
      .returning());
  if (!row) throw new DocumentDraftError("draft_create_failed", "초안을 저장하지 못했습니다.", 500);

  await appendDraftEvent({
    draftId: row.id,
    actorUserId: input.access.userId,
    userId: input.access.userId,
    event: existing ? "regenerated" : "created",
    payload: {
      documentKey: document.documentKey,
      status: generated.status,
      missingFieldCount: generated.autofill.missingFields.length,
    },
  });

  await promoteDraftAnswersToCompanyProfile({
    access: input.access,
    answers: input.request.answers,
    missingProfileFields: sheet.applicationPrep.missingProfileFields,
  });

  return { draft: toDocumentDraft(row) };
}

export async function getGrantDocumentDraft(input: {
  draftId: string;
  access: CompanyAccess;
}): Promise<DocumentDraft> {
  assertDraftId(input.draftId);
  const db = getCunoteDb();
  const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
    .select()
    .from(schema.grantDocumentDrafts)
    .where(and(
      eq(schema.grantDocumentDrafts.id, input.draftId),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .limit(1));
  if (!row) throw new DocumentDraftError("draft_not_found", "초안을 찾지 못했습니다.", 404, "draftId");
  return toDocumentDraft(row);
}

export async function listGrantDocumentDraftsForGrant(input: {
  grantId: string;
  access: CompanyAccess;
}): Promise<DocumentDraft[]> {
  if (!isUuid(input.grantId)) return [];
  const db = getCunoteDb();
  const rows = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
    .select()
    .from(schema.grantDocumentDrafts)
    .where(and(
      eq(schema.grantDocumentDrafts.grantId, input.grantId),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .orderBy(desc(schema.grantDocumentDrafts.updatedAt), desc(schema.grantDocumentDrafts.createdAt)));
  return uniqueLatestDraftRows(rows).map(toDocumentDraft);
}

export async function updateGrantDocumentDraft(input: {
  draftId: string;
  access: CompanyAccess;
  draftMarkdown?: string;
  filledFields?: Record<string, string>;
  status?: DocumentDraftStatus;
}): Promise<DocumentDraft> {
  assertDraftId(input.draftId);
  const db = getCunoteDb();
  const current = input.filledFields !== undefined
    ? await getGrantDocumentDraftRow({ draftId: input.draftId, access: input.access })
    : null;
  const values: Partial<typeof schema.grantDocumentDrafts.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.draftMarkdown !== undefined) values.draftMarkdown = input.draftMarkdown;
  if (input.filledFields !== undefined) {
    const filledFields = normalizeFilledFields(input.filledFields);
    values.filledFields = filledFields;
    values.missingFields = filterResolvedMissingFields(current?.missingFields ?? [], filledFields);
    if (!input.status && current?.status === "needs_input" && values.missingFields.length === 0) {
      values.status = "draft";
    }
  }
  if (input.status !== undefined) values.status = input.status;
  if (Object.keys(values).length <= 1) {
    return getGrantDocumentDraft({ draftId: input.draftId, access: input.access });
  }

  const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
    .update(schema.grantDocumentDrafts)
    .set(values)
    .where(and(
      eq(schema.grantDocumentDrafts.id, input.draftId),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .returning());
  if (!row) throw new DocumentDraftError("draft_not_found", "초안을 찾지 못했습니다.", 404, "draftId");

  await appendDraftEvent({
    draftId: row.id,
    actorUserId: input.access.userId,
    userId: input.access.userId,
    event: "updated",
    payload: {
      status: row.status,
      draftMarkdownChanged: input.draftMarkdown !== undefined,
      filledFieldsChanged: input.filledFields !== undefined,
      filledFieldCount: Object.keys(row.filledFields).length,
      missingFieldCount: row.missingFields.length,
    },
  });

  return toDocumentDraft(row);
}

export async function regenerateGrantDocumentDraftSection(input: {
  draftId: string;
  access: CompanyAccess;
  request: DocumentDraftSectionRegenerationRequest;
}): Promise<DocumentDraft> {
  assertDraftId(input.draftId);
  const sectionTitle = normalizedRequiredText(input.request.sectionTitle, 120, "sectionTitle");
  const current = await getGrantDocumentDraftRow({ draftId: input.draftId, access: input.access });
  const sheet = await loadServiceApplySheet(current.grantId, {
    companyId: input.access.companyId,
    userId: input.access.userId,
  });
  if (!sheet) throw new DocumentDraftError("grant_not_found", "공고를 찾지 못했습니다.", 404, "grantId");
  const document = sheet.applicationPrep.draftableDocuments.find((candidate) =>
    candidate.documentKey === current.documentKey
  );
  if (!document) {
    throw new DocumentDraftError("document_not_draftable", "초안 작성 가능한 서류를 찾지 못했습니다.", 404, "documentKey");
  }

  const generated = generateDocumentDraftContent({
    grant: sheet.grant,
    document,
    profileCopyFields: sheet.applicationPrep.profileCopyFields,
    missingProfileFields: sheet.applicationPrep.missingProfileFields,
    ...(input.request.answers ? { answers: stringRecord(input.request.answers, 2000) } : {}),
  });
  const baseMarkdown = normalizedOptionalDraftMarkdown(input.request.draftMarkdown) ?? current.draftMarkdown;
  const draftMarkdown = replaceMarkdownSection({
    baseMarkdown,
    generatedMarkdown: generated.draftMarkdown,
    sectionTitle,
  });
  const filledFields = normalizeFilledFields({
    ...current.filledFields,
    ...generated.autofill.filledFields,
    ...(input.request.filledFields ? stringRecord(input.request.filledFields, 4000) : {}),
  });
  const missingFields = filterResolvedMissingFields(
    generated.autofill.missingFields as unknown as Array<Record<string, unknown>>,
    filledFields,
  );
  const db = getCunoteDb();
  const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
    .update(schema.grantDocumentDrafts)
    .set({
      draftMarkdown,
      filledFields,
      missingFields,
      usedProfileFields: generated.autofill.usedProfileFields,
      assumptions: generated.assumptions,
      warnings: generated.warnings,
      status: missingFields.length > 0 ? "needs_input" : "draft",
      modelVer: generated.modelVer,
      promptVer: generated.promptVer,
      parserVersion: generated.parserVersion,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.grantDocumentDrafts.id, current.id),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .returning());
  if (!row) throw new DocumentDraftError("draft_not_found", "초안을 찾지 못했습니다.", 404, "draftId");

  await appendDraftEvent({
    draftId: row.id,
    actorUserId: input.access.userId,
    userId: input.access.userId,
    event: "section_regenerated",
    payload: {
      sectionTitle,
      documentKey: row.documentKey,
      status: row.status,
      filledFieldCount: Object.keys(row.filledFields).length,
      missingFieldCount: row.missingFields.length,
    },
  });

  await promoteDraftAnswersToCompanyProfile({
    access: input.access,
    answers: input.request.answers,
    missingProfileFields: sheet.applicationPrep.missingProfileFields,
  });

  return toDocumentDraft(row);
}

export async function submitGrantDocumentDraftFeedback(input: {
  draftId: string;
  access: CompanyAccess;
  request: DocumentDraftFeedbackRequest;
}): Promise<DocumentDraftFeedbackResult> {
  assertDraftId(input.draftId);
  const current = await getGrantDocumentDraftRow({ draftId: input.draftId, access: input.access });
  const feedback = normalizeDraftFeedback(input.request);
  const event = await appendDraftEvent({
    draftId: current.id,
    actorUserId: input.access.userId,
    userId: input.access.userId,
    event: "quality_feedback",
    payload: {
      kind: feedback.kind,
      message: feedback.message,
      selectedText: feedback.selectedText,
      fieldLabel: feedback.fieldLabel,
      documentKey: current.documentKey,
      documentName: current.documentName,
      documentCategory: current.documentCategory,
      status: current.status,
      modelVer: current.modelVer,
      promptVer: current.promptVer,
      parserVersion: current.parserVersion,
    },
  });

  return {
    draftId: current.id,
    eventId: event.id,
    kind: feedback.kind,
    receivedAt: event.createdAt.toISOString(),
  };
}

export async function recordGrantDocumentDraftExport(input: {
  draftId: string;
  access: CompanyAccess;
  format: "markdown" | "html" | "docx" | "pdf";
}): Promise<DocumentDraft> {
  assertDraftId(input.draftId);
  const current = await getGrantDocumentDraftRow({ draftId: input.draftId, access: input.access });
  const nextStatus: DocumentDraftStatus = current.status === "archived" ? "archived" : "exported";
  const db = getCunoteDb();
  const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
    .update(schema.grantDocumentDrafts)
    .set({
      status: nextStatus,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.grantDocumentDrafts.id, current.id),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .returning());
  if (!row) throw new DocumentDraftError("draft_not_found", "초안을 찾지 못했습니다.", 404, "draftId");

  await appendDraftEvent({
    draftId: row.id,
    actorUserId: input.access.userId,
    userId: input.access.userId,
    event: "exported",
    payload: {
      format: input.format,
      previousStatus: current.status,
      status: row.status,
      documentKey: row.documentKey,
      documentName: row.documentName,
      documentCategory: row.documentCategory,
      filledFieldCount: Object.keys(row.filledFields).length,
      missingFieldCount: row.missingFields.length,
      modelVer: row.modelVer,
      promptVer: row.promptVer,
      parserVersion: row.parserVersion,
    },
  });

  return toDocumentDraft(row);
}

const BUSINESS_NARRATIVE_FIELD_KEYS = [
  "business.product_summary",
  "business.apply_goal",
  "business.budget_items",
  "business.performance_summary",
] as const;

// KOREA_REGION_OPTIONS 짧은 라벨(서울/경기/…)에 더해 정식 명칭도 prefix 매칭 후보로 둔다.
const REGION_FORMAL_NAMES: Record<string, readonly string[]> = {
  서울: ["서울특별시"],
  부산: ["부산광역시"],
  대구: ["대구광역시"],
  인천: ["인천광역시"],
  광주: ["광주광역시"],
  대전: ["대전광역시"],
  울산: ["울산광역시"],
  세종: ["세종특별자치시", "세종시"],
  경기: ["경기도"],
  강원: ["강원도", "강원특별자치도"],
  충북: ["충청북도"],
  충남: ["충청남도"],
  전북: ["전라북도", "전북특별자치도"],
  전남: ["전라남도"],
  경북: ["경상북도"],
  경남: ["경상남도"],
  제주: ["제주도", "제주특별자치도"],
};

/**
 * 초안 생성 시 사용자가 입력한 추가 답변(label 키)을 회사 프로필로 승격한다.
 * 비치명: 실패해도 초안 결과는 정상 반환되도록 내부에서 예외를 삼킨다.
 * saveCompanyProfile은 전체 재기록이므로 반드시 resolveCompanyProfile 결과 위에 병합해 저장한다.
 */
async function promoteDraftAnswersToCompanyProfile(input: {
  access: CompanyAccess;
  answers: Record<string, string> | undefined;
  missingProfileFields: MissingFieldQuestion[];
}): Promise<void> {
  try {
    const answers = input.answers;
    if (!answers || Object.keys(answers).length === 0) return;

    // answers는 label 키 → missingProfileFields로 label→fieldKey 역매핑.
    const fieldKeyByLabel = new Map<string, string>();
    for (const question of input.missingProfileFields) {
      if (question.label && question.fieldKey && !fieldKeyByLabel.has(question.label)) {
        fieldKeyByLabel.set(question.label, question.fieldKey);
      }
    }

    const valueByFieldKey = new Map<string, string>();
    for (const [label, raw] of Object.entries(answers)) {
      const fieldKey = fieldKeyByLabel.get(label);
      if (!fieldKey) continue;
      const cleaned = typeof raw === "string" ? raw.trim() : "";
      if (!cleaned) continue;
      if (!valueByFieldKey.has(fieldKey)) valueByFieldKey.set(fieldKey, cleaned);
    }
    if (valueByFieldKey.size === 0) return;

    const repositories = getServiceRepositories();
    const profile = await repositories.companies.resolveCompanyProfile({
      companyId: input.access.companyId,
      userId: input.access.userId,
    });
    if (!profile) return;

    const next: CompanyProfile = { ...profile };
    let changed = false;

    const nameValue = valueByFieldKey.get("company.name");
    if (nameValue && !next.name) {
      const name = nameValue.slice(0, 80);
      if (name) {
        next.name = name;
        changed = true;
      }
    }

    const regionValue = valueByFieldKey.get("company.region");
    if (regionValue && !next.region) {
      const resolved = resolveRegionFromText(regionValue);
      if (resolved) {
        next.region = resolved;
        next.confidence = { ...(next.confidence ?? {}), region: 0.6 };
        changed = true;
      }
    }

    const industriesValue = valueByFieldKey.get("company.industries");
    if (industriesValue && (!next.industries || next.industries.length === 0)) {
      const tags = splitIndustryTags(industriesValue);
      if (tags.length > 0) {
        next.industries = tags;
        next.confidence = { ...(next.confidence ?? {}), industry: 0.5 };
        changed = true;
      }
    }

    const otherConditions: Record<string, unknown> = { ...(next.other_conditions ?? {}) };
    let otherChanged = false;
    for (const fieldKey of BUSINESS_NARRATIVE_FIELD_KEYS) {
      const value = valueByFieldKey.get(fieldKey);
      if (!value) continue;
      const narrative = value.slice(0, 2000);
      if (!narrative) continue;
      // 같은 키는 항상 최신값으로 덮어쓴다.
      otherConditions[fieldKey] = narrative;
      otherChanged = true;
    }
    if (otherChanged) {
      next.other_conditions = otherConditions;
      changed = true;
    }

    if (!changed) return;

    await repositories.companies.saveCompanyProfile({
      companyId: input.access.companyId,
      userId: input.access.userId,
      profile: next,
    });
  } catch (error) {
    console.warn(
      `초안 추가 입력의 회사 프로필 승격 실패: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function resolveRegionFromText(text: string): { code: string; label: string } | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const option of KOREA_REGION_OPTIONS) {
    const candidates = [option.label, ...(REGION_FORMAL_NAMES[option.label] ?? [])];
    if (candidates.some((candidate) => trimmed.startsWith(candidate))) {
      return { code: option.code, label: option.label };
    }
  }
  return null;
}

function splitIndustryTags(value: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of value.split(/[,·;/]/)) {
    const tag = part.trim().slice(0, 60);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
    if (tags.length >= 10) break;
  }
  return tags;
}

async function getGrantDocumentDraftRow(input: {
  draftId: string;
  access: CompanyAccess;
}): Promise<DraftRow> {
  assertDraftId(input.draftId);
  const db = getCunoteDb();
  const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
    .select()
    .from(schema.grantDocumentDrafts)
    .where(and(
      eq(schema.grantDocumentDrafts.id, input.draftId),
      eq(schema.grantDocumentDrafts.companyId, input.access.companyId),
    ))
    .limit(1));
  if (!row) throw new DocumentDraftError("draft_not_found", "초안을 찾지 못했습니다.", 404, "draftId");
  return row;
}

async function findLatestDocumentDraft(input: {
  grantId: string;
  companyId: string;
  userId: string;
  documentKey: string;
}): Promise<DraftRow | null> {
  const db = getCunoteDb();
  const [row] = await withCunoteDbUser(db, input.userId, async (tx) => tx
    .select()
    .from(schema.grantDocumentDrafts)
    .where(and(
      eq(schema.grantDocumentDrafts.grantId, input.grantId),
      eq(schema.grantDocumentDrafts.companyId, input.companyId),
      eq(schema.grantDocumentDrafts.documentKey, input.documentKey),
    ))
    .orderBy(desc(schema.grantDocumentDrafts.updatedAt), desc(schema.grantDocumentDrafts.createdAt))
    .limit(1));
  return row ?? null;
}

async function appendDraftEvent(input: {
  draftId: string;
  actorUserId: string;
  userId: string;
  event: string;
  payload: Record<string, unknown>;
}): Promise<typeof schema.grantDocumentDraftEvents.$inferSelect> {
  const db = getCunoteDb();
  const [row] = await withCunoteDbUser(db, input.userId, async (tx) => tx
    .insert(schema.grantDocumentDraftEvents)
    .values({
      draftId: input.draftId,
      actorUserId: input.actorUserId,
      event: input.event,
      payload: input.payload,
    })
    .returning());
  if (!row) throw new DocumentDraftError("draft_event_failed", "초안 이벤트를 저장하지 못했습니다.", 500);
  return row;
}

type DraftRow = typeof schema.grantDocumentDrafts.$inferSelect;

function uniqueLatestDraftRows(rows: DraftRow[]): DraftRow[] {
  const seen = new Set<string>();
  const unique: DraftRow[] = [];
  for (const row of rows) {
    if (seen.has(row.documentKey)) continue;
    seen.add(row.documentKey);
    unique.push(row);
  }
  return unique;
}

function toDocumentDraft(row: DraftRow): DocumentDraft {
  return {
    id: row.id,
    grantId: row.grantId,
    companyId: row.companyId,
    documentKey: row.documentKey,
    documentCategory: row.documentCategory as DocumentDraft["documentCategory"],
    documentName: row.documentName,
    sourceAttachment: row.sourceAttachment,
    draftMarkdown: row.draftMarkdown,
    filledFields: row.filledFields,
    missingFields: row.missingFields as unknown as MissingFieldQuestion[],
    usedProfileFields: row.usedProfileFields,
    assumptions: row.assumptions,
    warnings: row.warnings,
    status: row.status as DocumentDraftStatus,
    modelVer: row.modelVer,
    promptVer: row.promptVer,
    parserVersion: row.parserVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeFilledFields(value: Record<string, string>): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const label = key.trim().slice(0, 160);
    const filled = item.trim().slice(0, 4000);
    if (label && filled) normalized[label] = filled;
  }
  return normalized;
}

function filterResolvedMissingFields(
  fields: Array<Record<string, unknown>>,
  filledFields: Record<string, string>,
): Array<Record<string, unknown>> {
  return fields.filter((field) => {
    const label = stringValue(field.label);
    const fieldKey = stringValue(field.fieldKey);
    if (label && filledFields[label]) return false;
    if (fieldKey && filledFields[fieldKey]) return false;
    return true;
  });
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeDraftFeedback(request: DocumentDraftFeedbackRequest): {
  kind: DocumentDraftFeedbackKind;
  message: string | null;
  selectedText: string | null;
  fieldLabel: string | null;
} {
  if (!DOCUMENT_DRAFT_FEEDBACK_KINDS.includes(request.kind)) {
    throw new DocumentDraftError("invalid_feedback_kind", "피드백 유형이 올바르지 않습니다.", 400, "kind");
  }
  return {
    kind: request.kind,
    message: normalizedOptionalText(request.message, 2000),
    selectedText: normalizedOptionalText(request.selectedText, 1000),
    fieldLabel: normalizedOptionalText(request.fieldLabel, 160),
  };
}

function normalizedOptionalText(value: string | null | undefined, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.trim().replace(/\s+\n/g, "\n").slice(0, maxLength);
  return cleaned.length > 0 ? cleaned : null;
}

function normalizedRequiredText(value: unknown, maxLength: number, field: string): string {
  if (typeof value !== "string") {
    throw new DocumentDraftError("invalid_section_title", "재생성할 섹션을 선택해주세요.", 400, field);
  }
  const cleaned = value.trim().replace(/\s+/g, " ").slice(0, maxLength);
  if (!cleaned) {
    throw new DocumentDraftError("invalid_section_title", "재생성할 섹션을 선택해주세요.", 400, field);
  }
  return cleaned;
}

function normalizedOptionalDraftMarkdown(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\r\n?/g, "\n").slice(0, 80_000);
  return cleaned.trim().length > 0 ? cleaned : null;
}

function stringRecord(value: Record<string, string>, maxValueLength: number): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.trim().slice(0, 160);
    const normalizedValue = item.trim().slice(0, maxValueLength);
    if (normalizedKey && normalizedValue) result[normalizedKey] = normalizedValue;
  }
  return result;
}

function replaceMarkdownSection(input: {
  baseMarkdown: string;
  generatedMarkdown: string;
  sectionTitle: string;
}): string {
  const generated = markdownSection(input.generatedMarkdown, input.sectionTitle);
  if (!generated) {
    throw new DocumentDraftError("section_not_found", "재생성할 섹션을 초안에서 찾지 못했습니다.", 404, "sectionTitle");
  }
  const current = markdownSection(input.baseMarkdown, input.sectionTitle);
  if (!current) {
    return `${input.baseMarkdown.trimEnd()}\n\n${generated.text.trimEnd()}\n`;
  }
  return [
    input.baseMarkdown.slice(0, current.start).trimEnd(),
    generated.text.trimEnd(),
    input.baseMarkdown.slice(current.end).trimStart(),
  ].filter((part) => part.length > 0).join("\n\n").trimEnd() + "\n";
}

function markdownSection(markdown: string, sectionTitle: string): {
  start: number;
  end: number;
  text: string;
} | null {
  const normalized = markdown.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  let offset = 0;
  let startLine = -1;
  let startOffset = -1;
  let level = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = markdownHeading(line);
    if (heading && heading.text === sectionTitle) {
      startLine = index;
      startOffset = offset;
      level = heading.level;
      break;
    }
    offset += line.length + 1;
  }
  if (startLine < 0) return null;

  let endOffset = normalized.length;
  offset = startOffset + (lines[startLine]?.length ?? 0) + 1;
  for (let index = startLine + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const heading = markdownHeading(line);
    if (heading && heading.level <= level) {
      endOffset = offset;
      break;
    }
    offset += line.length + 1;
  }
  return {
    start: startOffset,
    end: endOffset,
    text: normalized.slice(startOffset, endOffset),
  };
}

function markdownHeading(line: string): { level: number; text: string } | null {
  const match = /^(#{2,4})\s+(.+?)\s*$/.exec(line.trim());
  if (!match) return null;
  return { level: match[1]!.length, text: match[2]!.trim().replace(/\s+/g, " ") };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function assertDraftId(value: string): void {
  if (!isUuid(value)) {
    throw new DocumentDraftError("invalid_draft_id", "초안 id 형식이 올바르지 않습니다.", 400, "draftId");
  }
}
