import { createHash } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { saveWritingSectionSchema, generateWritingSectionSchema, type WritingSection, type WritingSections } from "@/lib/documents/writingSections";
import { isManualLabel } from "@/lib/documents/manualFieldPolicy";
import { checkWritingConsistency } from "@/lib/documents/writingConsistency";
import { sectionFailureMessage } from "@/lib/documents/sectionFailure";
import { canonicalJson } from "@/lib/rhwp/documentAgentContract";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, withCunoteDbUser, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { loadConnectedDocumentFields, resolveArchiveStorageKey, type ConnectedDocumentField } from "./documentFieldLink";
import { assertWritingDraftAccessInTransaction, loadWritingGroundingInTransaction, WritingContextError } from "./writingContext";
import { writingContextBinding } from "./writingGroundingSources";
import { generateSectionSuggestions } from "./sectionComposer";

type Scope = { access: CompanyAccess; draftId: string };
type Run = typeof schema.documentWritingSectionRuns.$inferSelect;
const sections = schema.documentWritingSections;
const runs = schema.documentWritingSectionRuns;
const lifetimeMs = 90_000;
export const isWritingSectionAgentEnabled = () => ["1", "true"].includes(process.env.CUNOTE_WRITING_SECTION_AGENT_ENABLED?.trim().toLowerCase() ?? "");
const whereSection = (draftId: string, fieldId: string) => and(eq(sections.draftId, draftId), eq(sections.fieldId, fieldId));
function parse<T>(validator: z.ZodType<T>, body: unknown): T {
  const result = validator.safeParse(body);
  if (!result.success) throw new WritingContextError("invalid_writing_input", "문항 입력의 형식과 길이를 확인해 주세요.");
  return result.data;
}
function scope<T>(input: Scope, write: boolean, action: (tx: CunoteDbSession, writable: boolean) => Promise<T>): Promise<T> {
  return withCunoteDbUser(getCunoteDb(), input.access.userId, async tx => {
    const writable = await assertWritingDraftAccessInTransaction(tx, input.access, input.draftId, write);
    return action(tx, writable);
  });
}

/** 필드 연결 정본을 사용한다. 물리 입력 위치를 추측하거나 파일을 변경하지 않는다. */
async function connected(tx: CunoteDbSession, input: Scope) {
  const [draft] = await tx.select({ grantId: schema.grants.id, source: schema.grants.source, sourceId: schema.grants.sourceId,
    surfaceId: schema.grantDocumentDrafts.surfaceId, attachment: schema.grantDocumentDrafts.sourceAttachment })
    .from(schema.grantDocumentDrafts).innerJoin(schema.grants, eq(schema.grants.id, schema.grantDocumentDrafts.grantId))
    .where(eq(schema.grantDocumentDrafts.id, input.draftId));
  if (!draft) throw new WritingContextError("writing_draft_not_found", "문서를 찾지 못했습니다.", 404);
  const archive = !draft.surfaceId && draft.attachment
    ? await resolveArchiveStorageKey({ ...draft, filename: draft.attachment }, tx) : null;
  const fields = await loadConnectedDocumentFields({ ...draft, sourceAttachment: archive?.storageKey ?? null }, tx);
  return { grantId: draft.grantId, fields: fields.filter(field => field.fieldType === "long_text" && !isManualLabel(field.label)) };
}
const fieldBinding = (field: ConnectedDocumentField) => createHash("sha256").update(canonicalJson({
  id: field.fieldId, label: field.label, guidance: field.guidance, sourceSpan: field.sourceSpan, parserVersion: field.parserVersion,
})).digest("hex");
async function binding(tx: CunoteDbSession, input: Scope): Promise<string | null> {
  try { return writingContextBinding(await loadWritingGroundingInTransaction(tx, input)); }
  catch (error) {
    if (error instanceof WritingContextError && error.code === "writing_source_unavailable") return null;
    throw error;
  }
}
function proposal(run: Run | undefined, revision: number, currentBinding: string | null, field: ConnectedDocumentField | undefined): WritingSection["proposal"] {
  if (!run) return null;
  const expired = run.status === "running" && run.expiresAt.getTime() <= Date.now();
  const stale = run.baseRevision !== revision || run.writingBinding !== currentBinding || !field || run.fieldBinding !== fieldBinding(field);
  return { id: run.id, baseRevision: run.baseRevision, status: expired ? "failed" : run.status, composition: run.composition, stale,
    message: expired ? "요청 시간이 지났어요. 현재 문안을 보존한 채 새로 요청할 수 있어요."
      : run.status === "failed" ? sectionFailureMessage(run.errorCode)
        : stale ? "생성 이후 문안·회사 자료·문항이 변경됐어요. 현재 내용으로 다시 작성해 주세요." : null };
}

export async function loadWritingSections(input: Scope): Promise<WritingSections> {
  return scope(input, false, async (tx, writable) => {
    const { fields } = await connected(tx, input);
    const saved = await tx.select().from(sections).where(eq(sections.draftId, input.draftId));
    // 필드별 최신 요청만 읽어 한 문항의 많은 재시도가 다른 문항 이력을 밀어내지 않는다.
    const latest = await tx.selectDistinctOn([runs.fieldId]).from(runs).where(eq(runs.draftId, input.draftId))
      .orderBy(runs.fieldId, desc(runs.createdAt), desc(runs.id));
    const currentBinding = await binding(tx, input);
    const [brief] = await tx.select({ brief: schema.documentWritingBriefs.brief }).from(schema.documentWritingBriefs)
      .where(eq(schema.documentWritingBriefs.draftId, input.draftId));
    const ids = [...new Set([...fields.map(field => field.fieldId), ...saved.map(row => row.fieldId)])];
    return { canWrite: writable, canGenerate: writable && isWritingSectionAgentEnabled(),
      consistency: checkWritingConsistency({ projectName: brief?.brief.projectName ?? "", budget: brief?.brief.budget ?? "",
        sections: saved.map(row => ({ fieldId: row.fieldId, label: row.label, text: row.content })) }),
      sections: ids.map(fieldId => {
      const field = fields.find(field => field.fieldId === fieldId);
      const row = saved.find(row => row.fieldId === fieldId);
      return { fieldId, label: field?.label ?? row!.label, guidance: field?.guidance ?? null, available: Boolean(field),
        revision: row?.revision ?? 0, text: row?.content ?? "", proposal: proposal(latest.find(run => run.fieldId === fieldId), row?.revision ?? 0, currentBinding, field) };
    }) };
  });
}

export async function saveWritingSection(input: Scope & { body: unknown }) {
  const body = parse(saveWritingSectionSchema, input.body);
  return scope(input, true, async tx => {
    const [current] = await tx.select().from(sections).where(whereSection(input.draftId, body.fieldId));
    if ((current?.revision ?? 0) !== body.expectedRevision) throw new WritingContextError("writing_section_conflict", "다른 곳에서 문안이 변경됐어요. 현재 입력을 유지한 채 최신 저장본을 비교해 주세요.", 409);
    const { fields } = await connected(tx, input);
    const field = fields.find(field => field.fieldId === body.fieldId);
    if (!field && !current) throw new WritingContextError("writing_field_unavailable", "현재 문서의 작성 문항을 찾지 못했습니다.", 404);
    const values = { companyId: input.access.companyId, label: field?.label ?? current!.label, revision: body.expectedRevision + 1,
      content: body.text, updatedBy: input.access.userId, updatedAt: new Date() };
    await tx.insert(sections).values({ draftId: input.draftId, fieldId: body.fieldId, ...values })
      .onConflictDoUpdate({ target: [sections.draftId, sections.fieldId], set: values });
    return { revision: values.revision, text: values.content };
  });
}

/** 요청 원장을 먼저 저장하고 모델 호출 중에는 DB 잠금을 잡지 않는다. 중복 요청은 재실행하지 않는다. */
export async function requestWritingSection(input: Scope & { body: unknown }, deps: {
  generate?: typeof generateSectionSuggestions;
} = {}) {
  if (!isWritingSectionAgentEnabled()) throw new WritingContextError("writing_generation_unavailable", "문항 AI 작성 기능을 사용할 수 없습니다.", 404);
  const body = parse(generateWritingSectionSchema, input.body);
  const prepared = await scope(input, true, async tx => {
    const [prior] = await tx.select().from(runs).where(and(eq(runs.id, body.requestId), eq(runs.draftId, input.draftId)));
    if (prior) {
      if (prior.fieldId !== body.fieldId || prior.baseRevision !== body.expectedRevision) throw new WritingContextError("writing_request_conflict", "같은 생성 요청의 문항이나 기준이 변경됐습니다.", 409);
      return null;
    }
    const [current] = await tx.select().from(sections).where(whereSection(input.draftId, body.fieldId));
    if ((current?.revision ?? 0) !== body.expectedRevision) throw new WritingContextError("writing_section_conflict", "최신 문안을 확인한 뒤 다시 요청해 주세요.", 409);
    const { fields, grantId } = await connected(tx, input);
    const field = fields.find(field => field.fieldId === body.fieldId);
    if (!field) throw new WritingContextError("writing_field_unavailable", "현재 문서의 작성 문항을 찾지 못했습니다.", 404);
    const [active] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.draftId, input.draftId), eq(runs.fieldId, body.fieldId),
      eq(runs.status, "running"), sql`${runs.expiresAt} > now()`));
    if (active) throw new WritingContextError("writing_generation_running", "이 문항의 초안을 작성 중이에요. 최신 결과를 확인해 주세요.", 409);
    const writing = await loadWritingGroundingInTransaction(tx, input);
    const writingBinding = writingContextBinding(writing);
    const [created] = await tx.insert(runs).values({ id: body.requestId, draftId: input.draftId, fieldId: body.fieldId,
      companyId: input.access.companyId, baseRevision: body.expectedRevision, writingBinding, fieldBinding: fieldBinding(field), status: "running",
      createdBy: input.access.userId, expiresAt: new Date(Date.now() + lifetimeMs) }).onConflictDoNothing().returning({ id: runs.id });
    if (!created) throw new WritingContextError("writing_request_conflict", "새 생성 요청으로 다시 시도해 주세요.", 409);
    return { field, grantId, writing, sourceText: current?.content ?? "", writingBinding };
  });
  if (prepared) {
    let composition: Run["composition"] = null;
    let errorCode: string | null = null;
    try {
      composition = (await (deps.generate ?? generateSectionSuggestions)({ ...input, grantId: prepared.grantId,
        fieldLabel: prepared.field.label, guidance: prepared.field.guidance ?? null, sourceSpan: prepared.field.sourceSpan,
        sourceText: prepared.sourceText, writing: prepared.writing, requestId: body.requestId })).composition;
    } catch (error) { errorCode = error instanceof WritingContextError ? error.code : "generation_failed"; }
    await scope(input, true, async tx => {
      const { fields } = await connected(tx, input);
      const field = fields.find(field => field.fieldId === body.fieldId);
      if (await binding(tx, input) !== prepared.writingBinding || !field || fieldBinding(field) !== fieldBinding(prepared.field)) {
        composition = null; errorCode = "writing_context_changed";
      }
      await tx.update(runs).set({ status: errorCode ? "failed" : "ready", composition, errorCode })
        .where(and(eq(runs.id, body.requestId), eq(runs.status, "running"), sql`${runs.expiresAt} > now()`));
    });
  }
  return loadWritingSections(input);
}
