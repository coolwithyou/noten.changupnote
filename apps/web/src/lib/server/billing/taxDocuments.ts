import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { and, count, desc, eq } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import { getCunoteDb, withCunoteDbUser } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";

export type BillingTaxDocumentKind =
  | "business_registration"
  | "bank_account"
  | "tax_invoice_certificate"
  | "other";

export type BillingTaxDocumentStatus = "active" | "archived";

export interface BillingTaxDocumentItem {
  id: string;
  companyId: string;
  documentKind: BillingTaxDocumentKind;
  documentKindLabel: string;
  filename: string;
  contentType: string;
  bytes: number;
  sizeLabel: string;
  sha256: string;
  storageKey: string;
  archiveUrl: string;
  status: BillingTaxDocumentStatus;
  statusLabel: string;
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminBillingTaxDocumentItem extends BillingTaxDocumentItem {
  companyName: string;
}

export interface BillingTaxDocumentUploadResult {
  persisted: boolean;
  storageConfigured: boolean;
  document: BillingTaxDocumentItem | null;
  message: string;
}

export interface BillingTaxDocumentArchiveResult {
  persisted: boolean;
  document: BillingTaxDocumentItem | null;
}

export interface BillingTaxDocumentUploadFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class BillingTaxDocumentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "BillingTaxDocumentError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".hwp", ".hwpx", ".doc", ".docx"]);

export async function listBillingTaxDocuments(input: {
  access: CompanyAccess;
  limit?: number;
}): Promise<BillingTaxDocumentItem[]> {
  if (input.access.mode === "demo" || !hasDatabaseUrl()) return [];
  const safeLimit = Math.max(1, Math.min(20, input.limit ?? 10));
  try {
    const db = getCunoteDb();
    const rows = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .select()
      .from(schema.billingTaxDocuments)
      .where(and(
        eq(schema.billingTaxDocuments.companyId, input.access.companyId),
        eq(schema.billingTaxDocuments.status, "active"),
      ))
      .orderBy(desc(schema.billingTaxDocuments.updatedAt))
      .limit(safeLimit));
    return rows.map(rowToDocument);
  } catch {
    return [];
  }
}

export async function uploadBillingTaxDocument(input: {
  access: CompanyAccess;
  file: BillingTaxDocumentUploadFile;
  documentKind: unknown;
  storage?: R2ObjectStorage | null;
  now?: Date;
}): Promise<BillingTaxDocumentUploadResult> {
  const documentKind = normalizeDocumentKind(input.documentKind);
  const filename = normalizeFilename(input.file.name);
  const contentType = normalizeContentType(input.file.type, filename);
  validateFile({ filename, contentType, size: input.file.size });
  const storage = input.storage ?? createR2ObjectStorageFromEnv();
  if (input.access.mode === "demo" || !hasDatabaseUrl()) {
    return {
      persisted: false,
      storageConfigured: Boolean(storage),
      document: null,
      message: "DB 연결 전이라 청구 증빙 파일을 보관하지 않았습니다.",
    };
  }
  if (!storage) {
    return {
      persisted: false,
      storageConfigured: false,
      document: null,
      message: "R2 저장소 설정 후 청구 증빙 파일을 보관할 수 있습니다.",
    };
  }

  const body = Buffer.from(await input.file.arrayBuffer());
  if (body.byteLength !== input.file.size) {
    throw new BillingTaxDocumentError("billing_tax_document_size_mismatch", "파일 크기를 확인해주세요.", 400, "file");
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const now = input.now ?? new Date();
  const storageKey = buildStorageKey({
    companyId: input.access.companyId,
    filename,
    sha256,
    now,
  });
  const uploaded = await storage.putObject({
    key: storageKey,
    body,
    contentType,
  });

  try {
    const db = getCunoteDb();
    const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .insert(schema.billingTaxDocuments)
      .values({
        companyId: input.access.companyId,
        documentKind,
        filename,
        contentType,
        bytes: body.byteLength,
        sha256,
        storageKey: uploaded.key,
        archiveUrl: uploaded.url,
        status: "active",
        metadata: {
          source: "web_billing_tax_document_upload",
          uploadedByRole: input.access.role,
        },
        uploadedBy: input.access.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning());
    if (!row) {
      throw new BillingTaxDocumentError("billing_tax_document_save_failed", "청구 증빙 파일을 저장하지 못했습니다.", 500);
    }
    return {
      persisted: true,
      storageConfigured: true,
      document: rowToDocument(row),
      message: "청구 증빙 파일을 R2에 보관했습니다.",
    };
  } catch (error) {
    if (error instanceof BillingTaxDocumentError) throw error;
    return {
      persisted: false,
      storageConfigured: true,
      document: null,
      message: "파일 업로드 후 DB 반영을 확인하지 못했습니다. 운영자 확인이 필요합니다.",
    };
  }
}

export async function archiveBillingTaxDocument(input: {
  access: CompanyAccess;
  documentId: string;
}): Promise<BillingTaxDocumentArchiveResult> {
  if (!isUuid(input.documentId)) {
    throw new BillingTaxDocumentError("billing_tax_document_invalid_id", "증빙 파일 id를 확인해주세요.", 400, "documentId");
  }
  if (input.access.mode === "demo" || !hasDatabaseUrl()) {
    return { persisted: false, document: null };
  }
  try {
    const db = getCunoteDb();
    const [row] = await withCunoteDbUser(db, input.access.userId, async (tx) => tx
      .update(schema.billingTaxDocuments)
      .set({
        status: "archived",
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.billingTaxDocuments.id, input.documentId),
        eq(schema.billingTaxDocuments.companyId, input.access.companyId),
      ))
      .returning());
    if (!row) throw new BillingTaxDocumentError("billing_tax_document_not_found", "증빙 파일을 찾지 못했습니다.", 404, "documentId");
    return { persisted: true, document: rowToDocument(row) };
  } catch (error) {
    if (error instanceof BillingTaxDocumentError) throw error;
    return { persisted: false, document: null };
  }
}

export async function countAdminBillingTaxDocuments(): Promise<number> {
  if (!hasDatabaseUrl()) return 0;
  try {
    const db = getCunoteDb();
    return (await db.select({ value: count() }).from(schema.billingTaxDocuments))[0]?.value ?? 0;
  } catch {
    return 0;
  }
}

export async function listAdminBillingTaxDocuments(limit = 8): Promise<AdminBillingTaxDocumentItem[]> {
  if (!hasDatabaseUrl()) return [];
  const safeLimit = Math.max(1, Math.min(20, limit));
  try {
    const db = getCunoteDb();
    const rows = await db
      .select({
        id: schema.billingTaxDocuments.id,
        companyId: schema.billingTaxDocuments.companyId,
        documentKind: schema.billingTaxDocuments.documentKind,
        filename: schema.billingTaxDocuments.filename,
        contentType: schema.billingTaxDocuments.contentType,
        bytes: schema.billingTaxDocuments.bytes,
        sha256: schema.billingTaxDocuments.sha256,
        storageKey: schema.billingTaxDocuments.storageKey,
        archiveUrl: schema.billingTaxDocuments.archiveUrl,
        status: schema.billingTaxDocuments.status,
        metadata: schema.billingTaxDocuments.metadata,
        uploadedBy: schema.billingTaxDocuments.uploadedBy,
        createdAt: schema.billingTaxDocuments.createdAt,
        updatedAt: schema.billingTaxDocuments.updatedAt,
        companyName: schema.companies.name,
      })
      .from(schema.billingTaxDocuments)
      .leftJoin(schema.companies, eq(schema.companies.id, schema.billingTaxDocuments.companyId))
      .orderBy(desc(schema.billingTaxDocuments.updatedAt))
      .limit(safeLimit);
    return rows.map((row) => ({
      ...rowToDocument(row),
      companyName: row.companyName ?? "이름 없는 회사",
    }));
  } catch {
    return [];
  }
}

export function documentKindLabel(kind: BillingTaxDocumentKind): string {
  if (kind === "business_registration") return "사업자등록증";
  if (kind === "bank_account") return "통장사본";
  if (kind === "tax_invoice_certificate") return "세금계산서 증빙";
  return "기타 청구 증빙";
}

function rowToDocument(row: typeof schema.billingTaxDocuments.$inferSelect): BillingTaxDocumentItem {
  const documentKind = normalizeDocumentKind(row.documentKind);
  const status = row.status === "archived" ? "archived" : "active";
  return {
    id: row.id,
    companyId: row.companyId,
    documentKind,
    documentKindLabel: documentKindLabel(documentKind),
    filename: row.filename,
    contentType: row.contentType,
    bytes: row.bytes,
    sizeLabel: formatBytes(row.bytes),
    sha256: row.sha256,
    storageKey: row.storageKey,
    archiveUrl: row.archiveUrl,
    status,
    statusLabel: status === "active" ? "보관중" : "보관 해제",
    uploadedBy: row.uploadedBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function normalizeDocumentKind(value: unknown): BillingTaxDocumentKind {
  if (value === "business_registration" || value === "bank_account" || value === "tax_invoice_certificate" || value === "other") {
    return value;
  }
  return "other";
}

function normalizeFilename(value: string): string {
  const base = basename(value || "billing-document").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const normalized = base.replace(/\s+/g, " ").slice(0, 180);
  if (!normalized || normalized === "." || normalized === "..") return "billing-document";
  return normalized;
}

function normalizeContentType(value: string, filename: string): string {
  const clean = value.trim().toLowerCase();
  if (clean) return clean.slice(0, 120);
  const ext = extname(filename).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".hwp") return "application/x-hwp";
  if (ext === ".hwpx") return "application/hwp+zip";
  return "application/octet-stream";
}

function validateFile(input: { filename: string; contentType: string; size: number }) {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new BillingTaxDocumentError("billing_tax_document_empty", "업로드할 파일을 선택해주세요.", 400, "file");
  }
  if (input.size > MAX_FILE_BYTES) {
    throw new BillingTaxDocumentError("billing_tax_document_too_large", "10MB 이하 파일만 업로드할 수 있습니다.", 400, "file");
  }
  const ext = extname(input.filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext) && !input.contentType.startsWith("image/") && input.contentType !== "application/pdf") {
    throw new BillingTaxDocumentError("billing_tax_document_unsupported_type", "PDF, 이미지, HWP/HWPX, DOC/DOCX 파일만 업로드할 수 있습니다.", 400, "file");
  }
}

function buildStorageKey(input: {
  companyId: string;
  filename: string;
  sha256: string;
  now: Date;
}): string {
  const year = input.now.getUTCFullYear();
  const safeFilename = input.filename
    .normalize("NFKD")
    .replace(/[^\w.\-가-힣]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120) || "billing-document";
  return [
    "billing-tax-documents",
    input.companyId,
    String(year),
    `${input.sha256.slice(0, 16)}-${safeFilename}`,
  ].join("/");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10}KB`;
  return `${Math.round(bytes / 1024 / 102.4) / 10}MB`;
}

function hasDatabaseUrl(): boolean {
  return Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
