import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createWritingSourceSchema, emptyWritingBrief, saveWritingBriefSchema,
  type WritingContext, type WritingSourceSummary,
} from "@/lib/documents/writingContext";
import { canWriteCompany } from "../auth/companyAccessPolicy";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, withCunoteDbUser, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";

export class WritingContextError extends Error {
  constructor(readonly code: string, message: string, readonly status = 422) { super(message); }
}
const uuid = z.string().uuid();
function parse<T>(validator: z.ZodType<T>, value: unknown): T {
  const result = validator.safeParse(value);
  if (!result.success) throw new WritingContextError("invalid_writing_input", "작성 자료의 형식이나 길이를 확인해 주세요.");
  return result.data;
}
const sourceScope = (access: CompanyAccess, draftId: string) => and(
  eq(schema.companyWritingSources.companyId, access.companyId),
  or(isNull(schema.companyWritingSources.draftId), eq(schema.companyWritingSources.draftId, draftId)),
);

/** RLS 우회 가능한 서버 연결에서도 현재 membership과 draft 소속을 다시 검증한다. */
async function withDraft<T>(access: CompanyAccess, draftId: string, write: boolean,
  run: (tx: CunoteDbSession, writable: boolean) => Promise<T>): Promise<T> {
  return withCunoteDbUser(getCunoteDb(), access.userId, async (tx) => {
    const writable = await assertWritingDraftAccessInTransaction(tx, access, draftId, write);
    return run(tx, writable);
  });
}

export async function assertWritingDraftAccessInTransaction(tx: CunoteDbSession, access: CompanyAccess, draftId: string, write: boolean): Promise<boolean> {
  parse(uuid, draftId);
  if (access.mode === "demo") throw new WritingContextError("writing_session_required", "회사 자료를 저장하려면 로그인해 주세요.", 403);
  const [member] = await tx.select({ role: schema.userCompany.role }).from(schema.userCompany)
    .where(and(eq(schema.userCompany.companyId, access.companyId), eq(schema.userCompany.userId, access.userId))).for("share");
  if (!member || (write && !canWriteCompany(member.role))) {
    throw new WritingContextError("writing_forbidden", "작성 자료에 접근할 권한이 없습니다.", 403);
  }
  const [draft] = await tx.select({ id: schema.grantDocumentDrafts.id }).from(schema.grantDocumentDrafts)
    .where(and(eq(schema.grantDocumentDrafts.id, draftId), eq(schema.grantDocumentDrafts.companyId, access.companyId)))
    .for(write ? "update" : "share");
  if (!draft) throw new WritingContextError("writing_draft_not_found", "작성 문서를 찾지 못했습니다.", 404);
  return canWriteCompany(member.role);
}

const sourceSummaryColumns = { id: schema.companyWritingSources.id, title: schema.companyWritingSources.title,
  draftId: schema.companyWritingSources.draftId, kind: schema.companyWritingSources.kind,
  contentSha256: schema.companyWritingSources.contentSha256, observedDate: schema.companyWritingSources.observedDate,
  createdAt: schema.companyWritingSources.createdAt, withdrawnAt: schema.companyWritingSources.withdrawnAt };

function summarize(row: Pick<typeof schema.companyWritingSources.$inferSelect, keyof typeof sourceSummaryColumns>): WritingSourceSummary {
  return { id: row.id, title: row.title, scope: row.draftId ? "application" : "company", kind: row.kind,
    sha256: row.contentSha256, observedDate: row.observedDate, createdAt: row.createdAt.toISOString(), withdrawn: row.withdrawnAt !== null };
}

async function readContext(tx: CunoteDbSession, access: CompanyAccess, draftId: string, writable: boolean): Promise<WritingContext> {
  const [saved] = await tx.select().from(schema.documentWritingBriefs)
    .where(and(eq(schema.documentWritingBriefs.draftId, draftId), eq(schema.documentWritingBriefs.companyId, access.companyId)));
  const sources = await tx.select(sourceSummaryColumns).from(schema.companyWritingSources).where(sourceScope(access, draftId))
    .orderBy(desc(schema.companyWritingSources.createdAt), desc(schema.companyWritingSources.id)).limit(201);
  const visible = sources.slice(0, 200);
  const missing = (saved?.sourceIds ?? []).filter((id) => !visible.some((source) => source.id === id));
  if (missing.length) visible.push(...await tx.select(sourceSummaryColumns).from(schema.companyWritingSources)
    .where(and(sourceScope(access, draftId), inArray(schema.companyWritingSources.id, missing))));
  return { revision: saved?.revision ?? 0, brief: saved?.brief ?? emptyWritingBrief(), sourceIds: saved?.sourceIds ?? [],
    sources: visible.map(summarize), sourcesTruncated: sources.length > 200, canWrite: writable };
}

export function loadWritingContext(input: { access: CompanyAccess; draftId: string }) {
  return withDraft(input.access, input.draftId, false, (tx, writable) => readContext(tx, input.access, input.draftId, writable));
}

export async function createWritingSource(input: { access: CompanyAccess; draftId: string; body: unknown }): Promise<WritingSourceSummary> {
  const body = parse(createWritingSourceSchema, input.body);
  const contentSha256 = createHash("sha256").update(body.content).digest("hex");
  const draftId = body.scope === "application" ? input.draftId : null;
  return withDraft(input.access, input.draftId, true, async (tx) => {
    const values = { companyId: input.access.companyId, draftId, requestId: body.requestId, title: body.title,
      content: body.content, contentSha256, kind: body.kind, observedDate: body.observedDate, createdBy: input.access.userId };
    const [created] = await tx.insert(schema.companyWritingSources).values(values).onConflictDoNothing({
      target: [schema.companyWritingSources.companyId, schema.companyWritingSources.requestId],
    }).returning();
    if (created) return summarize(created);
    const [prior] = await tx.select().from(schema.companyWritingSources).where(and(
      eq(schema.companyWritingSources.companyId, input.access.companyId), eq(schema.companyWritingSources.requestId, body.requestId),
    ));
    if (!prior || prior.draftId !== draftId || prior.contentSha256 !== contentSha256 || prior.title !== body.title
      || prior.kind !== body.kind || prior.observedDate !== body.observedDate) {
      throw new WritingContextError("writing_request_conflict", "같은 저장 요청의 내용이 변경되었습니다. 새 요청으로 저장해 주세요.", 409);
    }
    // 재시도로 철회한 자료를 되살리지 않는다.
    return summarize(prior);
  });
}

export function readWritingSource(input: { access: CompanyAccess; draftId: string; sourceId: string }) {
  parse(uuid, input.sourceId);
  return withDraft(input.access, input.draftId, false, async (tx) => {
    const [row] = await tx.select().from(schema.companyWritingSources).where(and(sourceScope(input.access, input.draftId),
      eq(schema.companyWritingSources.id, input.sourceId), isNull(schema.companyWritingSources.withdrawnAt)));
    if (!row) throw new WritingContextError("writing_source_unavailable", "자료가 없거나 철회되었습니다.", 404);
    return { ...summarize(row), content: row.content };
  });
}

export function withdrawWritingSource(input: { access: CompanyAccess; draftId: string; sourceId: string }) {
  parse(uuid, input.sourceId);
  return withDraft(input.access, input.draftId, true, async (tx) => {
    const [row] = await tx.select().from(schema.companyWritingSources).where(and(sourceScope(input.access, input.draftId),
      eq(schema.companyWritingSources.id, input.sourceId))).for("update");
    if (!row) throw new WritingContextError("writing_source_unavailable", "자료를 찾지 못했습니다.", 404);
    if (!row.withdrawnAt) await tx.update(schema.companyWritingSources).set({ withdrawnAt: new Date() })
      .where(eq(schema.companyWritingSources.id, row.id));
    return { id: row.id, withdrawn: true as const };
  });
}

export async function saveWritingBrief(input: { access: CompanyAccess; draftId: string; body: unknown }): Promise<WritingContext> {
  const body = parse(saveWritingBriefSchema, input.body);
  return withDraft(input.access, input.draftId, true, async (tx, writable) => {
    const [current] = await tx.select().from(schema.documentWritingBriefs).where(eq(schema.documentWritingBriefs.draftId, input.draftId));
    if ((current?.revision ?? 0) !== body.expectedRevision) {
      throw new WritingContextError("writing_brief_conflict", "다른 곳에서 사업 설명이 변경되었습니다. 입력을 보존한 채 최신 저장본을 확인해 주세요.", 409);
    }
    if (body.sourceIds.length) {
      const sources = await tx.select({ id: schema.companyWritingSources.id, characters: sql<number>`char_length(${schema.companyWritingSources.content})` }).from(schema.companyWritingSources)
        .where(and(sourceScope(input.access, input.draftId), inArray(schema.companyWritingSources.id, body.sourceIds),
          isNull(schema.companyWritingSources.withdrawnAt))).orderBy(schema.companyWritingSources.id).for("share");
      if (sources.reduce((total, source) => total + source.characters, 0) > 60000) {
        throw new WritingContextError("writing_sources_too_large", "한 문서에서 사용할 자료는 합계 60,000자 이내로 선택해 주세요.");
      }
      if (sources.length !== body.sourceIds.length) {
        throw new WritingContextError("writing_source_unavailable", "선택한 자료가 철회되었거나 이 문서에서 사용할 수 없습니다.");
      }
    }
    const values = { companyId: input.access.companyId, revision: body.expectedRevision + 1, brief: body.brief,
      sourceIds: body.sourceIds, updatedBy: input.access.userId, updatedAt: new Date() };
    await tx.insert(schema.documentWritingBriefs).values({ draftId: input.draftId, ...values }).onConflictDoUpdate({
      target: schema.documentWritingBriefs.draftId, set: values,
    });
    return readContext(tx, input.access, input.draftId, writable);
  });
}

/** 생성할 때마다 철회와 scope를 재검사한다. 저장된 sourceIds를 검증 없이 모델에 전달하지 않는다. */
export function loadWritingGrounding(input: { access: CompanyAccess; draftId: string }) {
  return withDraft(input.access, input.draftId, false, (tx) => loadWritingGroundingInTransaction(tx, input));
}

/** 호출자는 같은 transaction에서 draft 권한과 저장 잠금을 확보한다. */
export async function loadWritingGroundingInTransaction(tx: CunoteDbSession, input: { access: CompanyAccess; draftId: string }) {
    const [saved] = await tx.select().from(schema.documentWritingBriefs).where(and(eq(schema.documentWritingBriefs.draftId, input.draftId), eq(schema.documentWritingBriefs.companyId, input.access.companyId))).for("share");
    const ids = saved?.sourceIds ?? [];
    const sources = ids.length ? await tx.select().from(schema.companyWritingSources)
      .where(and(sourceScope(input.access, input.draftId), inArray(schema.companyWritingSources.id, ids),
        isNull(schema.companyWritingSources.withdrawnAt))).orderBy(schema.companyWritingSources.id).for("share") : [];
    if (sources.reduce((total, source) => total + source.content.length, 0) > 60000) throw new WritingContextError("writing_sources_too_large", "선택한 자료의 분량을 줄여 주세요.");
    if (sources.length !== ids.length) throw new WritingContextError("writing_source_unavailable", "철회된 자료를 선택 해제한 뒤 다시 작성해 주세요.");
    return { revision: saved?.revision ?? 0, brief: saved?.brief ?? emptyWritingBrief(),
      sources: sources.map((source) => ({ ...summarize(source), content: source.content })) };
}
