import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { createWritingSourceSchema, type WritingPdfOriginal, type WritingSourceSummary } from "@/lib/documents/writingContext";
import { canWriteCompany } from "../auth/companyAccessPolicy";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, withCunoteDbUser, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "../storage/r2ObjectStorage";
import {
  assertWritingMemberInTransaction, canUploadWritingPdf, insertWritingSourceInTransaction,
  sourceSummaryColumns, summarize, WritingContextError,
} from "./writingContext";
import { decryptWritingPdf, encryptWritingPdf, extractWritingPdf, writingPdfEncryptionKey, writingPdfSha256 } from "./writingPdfBytes";

/**
 * 회사 단위 자료함(설정 › 회사 자료, 계획 §5.3 `/api/web/companies/[companyId]/writing-sources`).
 * draft에 결속되지 않은 회사 공통 자료(draft_id IS NULL)를 만들고, 회사의 모든 자료(이번 신청 전용 포함)를 읽는다.
 * 권한은 문서 시트(writingContext)와 같은 membership 검사를 공유한다: 멤버 읽기, owner/admin/member 쓰기, 데모 거부.
 */

export interface CompanyWritingSourceApplication {
  draftId: string;
  grantId: string;
  grantTitle: string | null;
  documentKey: string;
  documentName: string;
}

export interface CompanyWritingSourceRow extends WritingSourceSummary {
  /** 본문 글자 수(char_length). PDF는 추출 텍스트 기준. */
  characters: number;
  /** 이 자료를 선택(source_ids)한 문서(draft) 수. */
  usedByDrafts: number;
  /** 이번 신청 전용 자료일 때만 채운다. 회사 공통 자료는 null. */
  application: CompanyWritingSourceApplication | null;
}

export interface CompanyWritingSources {
  companyId: string;
  sources: CompanyWritingSourceRow[];
  sourcesTruncated: boolean;
  canWrite: boolean;
  canUploadPdf: boolean;
  /** canWrite=false일 때 화면에 표시할 이유. */
  readOnlyReason: string | null;
}

export const COMPANY_SOURCES_READ_ONLY_REASON = "읽기 권한으로 열었어요. 자료를 추가하거나 사용 중단할 수 없어요.";
export const COMPANY_SOURCES_SESSION_REQUIRED = "회사 자료를 보려면 로그인해 주세요.";

/** 회사 자료함의 텍스트 추가 요청. scope는 항상 company이므로 받지 않는다(strict). */
export const companyWritingSourceBodySchema = createWritingSourceSchema.omit({ scope: true }).strict();
export type CompanyWritingSourceBody = z.infer<typeof companyWritingSourceBodySchema>;
/** PDF 업로드 metadata. 문서 시트의 PDF 라우트와 같은 파일명 규칙. */
export const companyWritingPdfMetadataSchema = createWritingSourceSchema.omit({ content: true, kind: true, scope: true }).extend({
  filename: z.string().min(1).max(200).regex(/^[^/\\\u0000-\u001f\u007f]+\.pdf$/iu),
}).strict();

const uuid = z.string().uuid();
function parse<T>(validator: z.ZodType<T>, value: unknown, message = "작성 자료의 형식이나 길이를 확인해 주세요."): T {
  const result = validator.safeParse(value);
  if (!result.success) throw new WritingContextError("invalid_writing_input", message);
  return result.data;
}

/** 순수 권한 판정. DB membership 검사(assertWritingMemberInTransaction)와 같은 규칙을 화면·테스트에서 재사용한다. */
export function resolveCompanySourcePermission(access: Pick<CompanyAccess, "role" | "mode">): { canRead: boolean; canWrite: boolean; reason: string | null } {
  if (access.mode === "demo") return { canRead: false, canWrite: false, reason: COMPANY_SOURCES_SESSION_REQUIRED };
  if (!canWriteCompany(access.role)) return { canRead: true, canWrite: false, reason: COMPANY_SOURCES_READ_ONLY_REASON };
  return { canRead: true, canWrite: true, reason: null };
}

/** 경로의 companyId와 세션이 해석한 회사가 다르면 어느 쪽도 신뢰하지 않는다. requireCompanyAccess({ companyId }) 뒤의 2차 방어다. */
export function assertCompanyPathScope(pathCompanyId: string, access: Pick<CompanyAccess, "companyId">): void {
  if (!uuid.safeParse(pathCompanyId).success) throw new WritingContextError("invalid_company_id", "회사 식별자를 확인해주세요.", 400);
  if (pathCompanyId !== access.companyId) throw new WritingContextError("writing_company_mismatch", "다른 회사의 자료에는 접근할 수 없습니다.", 403);
}

/**
 * writingPdfSources.ts의 encryptionContext와 바이트 단위로 같아야 한다(회사 범위는 draft 자리에 "company").
 * 문서 시트에서 회사 공통으로 올린 PDF를 이 화면에서 내려받고, 그 반대도 성립하게 한다.
 */
export const writingPdfEncryptionContext = (companyId: string, draftId: string | null, requestId: string, sha: string) =>
  `cunote-writing-pdf-v1:${companyId}:${draftId ?? "company"}:${requestId}:${sha}`;

type RawSourceRow = Pick<typeof schema.companyWritingSources.$inferSelect, keyof typeof sourceSummaryColumns> & {
  characters: number;
  draftGrantId: string | null;
  documentKey: string | null;
  documentName: string | null;
  grantTitle: string | null;
};

/** 목록 행 조립(순수). usage는 source id → 사용 중인 draft 수. */
export function buildCompanyWritingSourceRows(rows: readonly RawSourceRow[], usage: ReadonlyMap<string, number>): CompanyWritingSourceRow[] {
  return rows.map((row) => ({
    ...summarize(row),
    characters: Number(row.characters) || 0,
    usedByDrafts: usage.get(row.id) ?? 0,
    application: row.draftId && row.draftGrantId && row.documentKey !== null && row.documentName !== null
      ? { draftId: row.draftId, grantId: row.draftGrantId, grantTitle: row.grantTitle, documentKey: row.documentKey, documentName: row.documentName }
      : null,
  }));
}

async function withCompany<T>(access: CompanyAccess, write: boolean, run: (tx: CunoteDbSession, writable: boolean) => Promise<T>): Promise<T> {
  return withCunoteDbUser(getCunoteDb(), access.userId, async (tx) => {
    const writable = await assertWritingMemberInTransaction(tx, access, write);
    return run(tx, writable);
  });
}

async function loadUsage(tx: CunoteDbSession, companyId: string): Promise<Map<string, number>> {
  // brief 한 행이 draft 하나다. source_ids jsonb 배열을 펼쳐 자료별 사용 문서 수를 1회 쿼리로 센다.
  const rows = await tx.execute<{ source_id: string; drafts: number }>(sql`
    select elem as source_id, count(distinct b.draft_id)::int as drafts
    from document_writing_briefs b, jsonb_array_elements_text(b.source_ids) as elem
    where b.company_id = ${companyId}
    group by elem
  `);
  return new Map(Array.from(rows, (row) => [row.source_id, Number(row.drafts) || 0]));
}

export function listCompanyWritingSources(input: { access: CompanyAccess }): Promise<CompanyWritingSources> {
  return withCompany(input.access, false, async (tx, writable) => {
    const rows = await tx.select({
      ...sourceSummaryColumns,
      characters: sql<number>`char_length(${schema.companyWritingSources.content})`,
      draftGrantId: schema.grantDocumentDrafts.grantId,
      documentKey: schema.grantDocumentDrafts.documentKey,
      documentName: schema.grantDocumentDrafts.documentName,
      grantTitle: schema.grants.title,
    }).from(schema.companyWritingSources)
      .leftJoin(schema.grantDocumentDrafts, eq(schema.grantDocumentDrafts.id, schema.companyWritingSources.draftId))
      .leftJoin(schema.grants, eq(schema.grants.id, schema.grantDocumentDrafts.grantId))
      .where(eq(schema.companyWritingSources.companyId, input.access.companyId))
      .orderBy(desc(schema.companyWritingSources.createdAt), desc(schema.companyWritingSources.id)).limit(201);
    const usage = await loadUsage(tx, input.access.companyId);
    return {
      companyId: input.access.companyId,
      sources: buildCompanyWritingSourceRows(rows.slice(0, 200), usage),
      sourcesTruncated: rows.length > 200,
      canWrite: writable,
      canUploadPdf: writable && canUploadWritingPdf(),
      readOnlyReason: writable ? null : COMPANY_SOURCES_READ_ONLY_REASON,
    };
  });
}

export async function createCompanyWritingSource(input: { access: CompanyAccess; body: unknown }): Promise<WritingSourceSummary> {
  const body = parse(companyWritingSourceBodySchema, input.body);
  return withCompany(input.access, true, (tx) => insertWritingSourceInTransaction(tx, {
    access: input.access, draftId: null, body: { ...body, scope: "company" },
  }));
}

const sourceOf = (access: CompanyAccess, sourceId: string) => and(
  eq(schema.companyWritingSources.companyId, access.companyId), eq(schema.companyWritingSources.id, sourceId),
);

/** 사용 중단한 자료도 본문은 보여 준다(이후 초안 생성에만 전달되지 않는다). 다른 회사의 자료는 존재 여부도 알리지 않는다. */
export function readCompanyWritingSource(input: { access: CompanyAccess; sourceId: string }) {
  parse(uuid, input.sourceId);
  return withCompany(input.access, false, async (tx) => {
    const [row] = await tx.select().from(schema.companyWritingSources).where(sourceOf(input.access, input.sourceId));
    if (!row) throw new WritingContextError("writing_source_unavailable", "자료를 찾지 못했습니다.", 404);
    return { ...summarize(row), content: row.content };
  });
}

/** 회사 공통 자료만 이 화면에서 중단한다. 이번 신청 전용 자료는 해당 문서의 작성 화면(draft API)에서 관리한다. */
export function withdrawCompanyWritingSource(input: { access: CompanyAccess; sourceId: string }) {
  parse(uuid, input.sourceId);
  return withCompany(input.access, true, async (tx) => {
    const [row] = await tx.select().from(schema.companyWritingSources).where(sourceOf(input.access, input.sourceId)).for("update");
    if (!row) throw new WritingContextError("writing_source_unavailable", "자료를 찾지 못했습니다.", 404);
    if (row.draftId) throw new WritingContextError("writing_source_scope_mismatch", "이번 신청 전용 자료는 해당 문서의 작성 화면에서 관리해요.", 409);
    if (!row.withdrawnAt) await tx.update(schema.companyWritingSources).set({ withdrawnAt: new Date() })
      .where(eq(schema.companyWritingSources.id, row.id));
    return { id: row.id, withdrawn: true as const };
  });
}

/** 공개 URL을 반환하지 않는다. 원본 다운로드 서비스 안에서만 사용하는 회사 권한 검사다. */
export function readCompanyWritingPdfReference(input: { access: CompanyAccess; sourceId: string }) {
  parse(uuid, input.sourceId);
  return withCompany(input.access, false, async (tx) => {
    const [row] = await tx.select({ original: schema.companyWritingSources.originalPdf, requestId: schema.companyWritingSources.requestId,
      draftId: schema.companyWritingSources.draftId }).from(schema.companyWritingSources).where(sourceOf(input.access, input.sourceId));
    if (!row?.original) throw new WritingContextError("writing_source_unavailable", "원본 자료가 없습니다.", 404);
    return { ...row, original: row.original };
  });
}

type PdfDependencies = { storage?: R2ObjectStorage; encryptionKey?: Buffer; extract?: typeof extractWritingPdf };
function storageFor(deps: PdfDependencies) {
  const storage = deps.storage ?? createR2ObjectStorageFromEnv();
  if (!storage) throw new WritingContextError("writing_pdf_unavailable", "PDF 자료 보관 기능을 사용할 수 없습니다.", 503);
  return storage;
}

export async function createCompanyWritingPdfSource(input: { access: CompanyAccess; metadata: unknown; bytes: Buffer }, deps: PdfDependencies = {}) {
  const metadata = parse(companyWritingPdfMetadataSchema, input.metadata, "PDF 파일명·자료 이름·기준일을 확인해 주세요.");
  // 추출·암호화 전에 쓰기 권한을 먼저 거부한다.
  await withCompany(input.access, true, async () => undefined);
  const key = deps.encryptionKey ?? writingPdfEncryptionKey();
  const storage = storageFor(deps);
  const extracted = await (deps.extract ?? extractWritingPdf)(input.bytes);
  const sha256 = writingPdfSha256(input.bytes);
  const context = writingPdfEncryptionContext(input.access.companyId, null, metadata.requestId, sha256);
  const keyId = writingPdfSha256(key);
  // 회사명·원본 파일명·평문을 public key/URL에 넣지 않는다. 암호문만 저장한다.
  const storageKey = `writing-private/v1/${input.access.companyId}/${keyId}/${writingPdfSha256(Buffer.from(context))}.bin`;
  await storage.putObject({ key: storageKey, body: encryptWritingPdf(input.bytes, key, context), contentType: "application/octet-stream" });
  return withCompany(input.access, true, (tx) => insertWritingSourceInTransaction(tx, {
    access: input.access, draftId: null,
    body: { requestId: metadata.requestId, title: metadata.title, scope: "company", observedDate: metadata.observedDate, kind: "company_document", content: extracted.text },
    originalPdf: { storageKey, sha256, bytes: input.bytes.length, filename: metadata.filename, pages: extracted.pages, keyId },
  }));
}

export async function readCompanyWritingPdfSource(input: { access: CompanyAccess; sourceId: string }, deps: PdfDependencies = {}) {
  const reference = await readCompanyWritingPdfReference(input);
  const key = deps.encryptionKey ?? writingPdfEncryptionKey();
  if (reference.original.keyId !== writingPdfSha256(key)) throw new WritingContextError("writing_pdf_key_unavailable", "이 원본 자료의 보관 키를 확인해야 합니다.", 503);
  const stored = await storageFor(deps).getObjectBytes(reference.original.storageKey);
  let bytes: Buffer;
  try {
    bytes = decryptWritingPdf(stored.body, key, writingPdfEncryptionContext(input.access.companyId, reference.draftId, reference.requestId, reference.original.sha256));
    if (bytes.length !== reference.original.bytes || writingPdfSha256(bytes) !== reference.original.sha256) throw new Error("original PDF mismatch");
  } catch { throw new WritingContextError("writing_pdf_integrity_failed", "원본 자료의 무결성을 확인하지 못했습니다.", 409); }
  // 저장소를 기다리는 동안 권한을 잃었으면 내용을 반환하지 않는다.
  await readCompanyWritingPdfReference(input);
  return { bytes, filename: reference.original.filename };
}
