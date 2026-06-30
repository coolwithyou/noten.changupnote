import { createHash } from "node:crypto";
import { basename, extname } from "node:path";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { CompanyAccess } from "@/lib/server/auth/companyGuard";
import type { WebSession } from "@/lib/server/auth/session";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv, type R2ObjectStorage } from "@/lib/server/storage/r2ObjectStorage";

export interface SupportTicketAttachmentItem {
  id: string;
  ticketId: string;
  messageId: string | null;
  filename: string;
  contentType: string;
  bytes: number;
  sizeLabel: string;
  sha256: string;
  archiveUrl: string;
  visibility: "public" | "internal";
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
}

export interface SupportTicketAttachmentUploadResult {
  persisted: boolean;
  storageConfigured: boolean;
  attachment: SupportTicketAttachmentItem | null;
  message: string;
}

export interface SupportTicketAttachmentArchiveResult {
  persisted: boolean;
  attachment: SupportTicketAttachmentItem | null;
  message: string;
}

export interface SupportTicketAttachmentUploadFile {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export class SupportTicketAttachmentError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field: string | undefined;

  constructor(code: string, message: string, status = 400, field?: string) {
    super(message);
    this.name = "SupportTicketAttachmentError";
    this.code = code;
    this.status = status;
    if (field !== undefined) this.field = field;
  }
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".png", ".jpg", ".jpeg", ".webp", ".txt", ".log", ".csv", ".hwp", ".hwpx", ".doc", ".docx"]);

export async function uploadSupportTicketAttachment(input: {
  ticketId: string;
  file: SupportTicketAttachmentUploadFile;
  access?: CompanyAccess | null;
  session?: WebSession | null;
  email?: unknown;
  storage?: R2ObjectStorage | null;
  now?: Date;
}): Promise<SupportTicketAttachmentUploadResult> {
  if (!isUuid(input.ticketId)) {
    throw new SupportTicketAttachmentError("support_ticket_attachment_invalid_ticket", "문의 접수번호를 확인해주세요.", 400, "ticketId");
  }
  const email = normalizeEmail(input.email);
  const filename = normalizeFilename(input.file.name);
  const contentType = normalizeContentType(input.file.type, filename);
  validateFile({ filename, contentType, size: input.file.size });
  const storage = input.storage ?? createR2ObjectStorageFromEnv();
  if (!hasDatabaseUrl()) {
    return {
      persisted: false,
      storageConfigured: Boolean(storage),
      attachment: null,
      message: "DB 연결 전이라 첨부 파일을 보관하지 않았습니다.",
    };
  }

  const db = getCunoteDb();
  const [ticket] = await db
    .select()
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.id, input.ticketId))
    .limit(1);
  if (!ticket || !canAccessTicket(ticket, input.access, input.session, email)) {
    throw new SupportTicketAttachmentError("support_ticket_not_found", "문의 기록을 찾지 못했습니다.", 404, "ticketId");
  }
  if (!storage) {
    return {
      persisted: false,
      storageConfigured: false,
      attachment: null,
      message: "R2 저장소 설정 후 문의 첨부 파일을 보관할 수 있습니다.",
    };
  }

  const body = Buffer.from(await input.file.arrayBuffer());
  if (body.byteLength !== input.file.size) {
    throw new SupportTicketAttachmentError("support_ticket_attachment_size_mismatch", "파일 크기를 확인해주세요.", 400, "file");
  }
  const sha256 = createHash("sha256").update(body).digest("hex");
  const now = input.now ?? new Date();
  const storageKey = buildStorageKey({
    ticketId: ticket.id,
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
    const [row] = await db
      .insert(schema.supportTicketAttachments)
      .values({
        ticketId: ticket.id,
        companyId: ticket.companyId,
        userId: ticket.userId,
        filename,
        contentType,
        bytes: body.byteLength,
        sha256,
        storageKey: uploaded.key,
        archiveUrl: uploaded.url,
        visibility: "public",
        status: "active",
        metadata: {
          source: "web_support_ticket_attachment",
          accessMode: input.access?.mode ?? "public",
        },
        uploadedBy: uuidOrNull(input.session?.user.id ?? input.access?.userId),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!row) {
      throw new SupportTicketAttachmentError("support_ticket_attachment_save_failed", "첨부 파일을 저장하지 못했습니다.", 500);
    }
    await db
      .update(schema.supportTickets)
      .set({
        metadata: {
          ...ticket.metadata,
          lastAttachmentAt: now.toISOString(),
        },
        updatedAt: now,
      })
      .where(eq(schema.supportTickets.id, ticket.id));
    return {
      persisted: true,
      storageConfigured: true,
      attachment: rowToAttachment(row),
      message: "문의 첨부 파일을 R2에 보관했습니다.",
    };
  } catch (error) {
    if (error instanceof SupportTicketAttachmentError) throw error;
    return {
      persisted: false,
      storageConfigured: true,
      attachment: null,
      message: "파일 업로드 후 DB 반영을 확인하지 못했습니다. 운영자 확인이 필요합니다.",
    };
  }
}

export async function listSupportTicketAttachmentsForTickets(input: {
  ticketIds: string[];
  visibility?: "public" | "internal" | "all";
  includeArchived?: boolean;
}): Promise<Map<string, SupportTicketAttachmentItem[]>> {
  const ticketIds = input.ticketIds.filter(isUuid);
  if (ticketIds.length === 0 || !hasDatabaseUrl()) return new Map();
  try {
    const db = getCunoteDb();
    const rows = await db
      .select()
      .from(schema.supportTicketAttachments)
      .where(and(
        inArray(schema.supportTicketAttachments.ticketId, ticketIds),
        ...(input.includeArchived ? [] : [eq(schema.supportTicketAttachments.status, "active")]),
        ...(input.visibility && input.visibility !== "all" ? [eq(schema.supportTicketAttachments.visibility, input.visibility)] : []),
      ))
      .orderBy(desc(schema.supportTicketAttachments.createdAt));
    const grouped = new Map<string, SupportTicketAttachmentItem[]>();
    for (const row of rows) {
      const bucket = grouped.get(row.ticketId) ?? [];
      bucket.push(rowToAttachment(row));
      grouped.set(row.ticketId, bucket);
    }
    return grouped;
  } catch {
    return new Map();
  }
}

export async function archiveSupportTicketAttachment(input: {
  ticketId: string;
  attachmentId: string;
  access?: CompanyAccess | null;
  session?: WebSession | null;
  email?: unknown;
  now?: Date;
}): Promise<SupportTicketAttachmentArchiveResult> {
  if (!isUuid(input.ticketId)) {
    throw new SupportTicketAttachmentError("support_ticket_attachment_invalid_ticket", "문의 접수번호를 확인해주세요.", 400, "ticketId");
  }
  if (!isUuid(input.attachmentId)) {
    throw new SupportTicketAttachmentError("support_ticket_attachment_invalid_id", "첨부 파일 번호를 확인해주세요.", 400, "attachmentId");
  }
  if (!hasDatabaseUrl()) {
    return {
      persisted: false,
      attachment: null,
      message: "DB 연결 전이라 첨부 파일 보관 상태를 변경하지 않았습니다.",
    };
  }

  const db = getCunoteDb();
  const [ticket] = await db
    .select()
    .from(schema.supportTickets)
    .where(eq(schema.supportTickets.id, input.ticketId))
    .limit(1);
  const email = normalizeEmail(input.email);
  if (!ticket || !canAccessTicket(ticket, input.access, input.session, email)) {
    throw new SupportTicketAttachmentError("support_ticket_not_found", "문의 기록을 찾지 못했습니다.", 404, "ticketId");
  }

  const [attachment] = await db
    .select()
    .from(schema.supportTicketAttachments)
    .where(and(
      eq(schema.supportTicketAttachments.id, input.attachmentId),
      eq(schema.supportTicketAttachments.ticketId, ticket.id),
    ))
    .limit(1);
  if (!attachment) {
    throw new SupportTicketAttachmentError("support_ticket_attachment_not_found", "첨부 파일을 찾지 못했습니다.", 404, "attachmentId");
  }
  if (attachment.status === "archived") {
    return {
      persisted: true,
      attachment: rowToAttachment(attachment),
      message: "이미 보관 해제된 첨부 파일입니다.",
    };
  }

  const now = input.now ?? new Date();
  const [row] = await db
    .update(schema.supportTicketAttachments)
    .set({
      status: "archived",
      metadata: {
        ...attachment.metadata,
        archivedAt: now.toISOString(),
        archivedBy: input.session?.user.id ?? input.access?.userId ?? null,
      },
      updatedAt: now,
    })
    .where(and(
      eq(schema.supportTicketAttachments.id, attachment.id),
      eq(schema.supportTicketAttachments.ticketId, ticket.id),
    ))
    .returning();
  if (!row) {
    throw new SupportTicketAttachmentError("support_ticket_attachment_archive_failed", "첨부 파일 보관 상태를 변경하지 못했습니다.", 500);
  }
  await db
    .update(schema.supportTickets)
    .set({
      metadata: {
        ...ticket.metadata,
        lastAttachmentArchivedAt: now.toISOString(),
      },
      updatedAt: now,
    })
    .where(eq(schema.supportTickets.id, ticket.id));

  return {
    persisted: true,
    attachment: rowToAttachment(row),
    message: "첨부 파일을 사용자 화면에서 숨겼습니다.",
  };
}

export async function listSupportTicketAttachmentsForTicket(input: {
  ticketId: string;
  visibility?: "public" | "internal" | "all";
  includeArchived?: boolean;
}): Promise<SupportTicketAttachmentItem[]> {
  const options: {
    ticketIds: string[];
    visibility?: "public" | "internal" | "all";
    includeArchived?: boolean;
  } = {
    ticketIds: [input.ticketId],
  };
  if (input.visibility !== undefined) options.visibility = input.visibility;
  if (input.includeArchived !== undefined) options.includeArchived = input.includeArchived;
  return (await listSupportTicketAttachmentsForTickets(options)).get(input.ticketId) ?? [];
}

function rowToAttachment(row: typeof schema.supportTicketAttachments.$inferSelect): SupportTicketAttachmentItem {
  const status = row.status === "archived" ? "archived" : "active";
  return {
    id: row.id,
    ticketId: row.ticketId,
    messageId: row.messageId,
    filename: row.filename,
    contentType: row.contentType,
    bytes: row.bytes,
    sizeLabel: formatBytes(row.bytes),
    sha256: row.sha256,
    archiveUrl: row.archiveUrl,
    visibility: row.visibility,
    status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function canAccessTicket(
  ticket: typeof schema.supportTickets.$inferSelect,
  access?: CompanyAccess | null,
  session?: WebSession | null,
  email?: string | null,
): boolean {
  if (access?.companyId && ticket.companyId === access.companyId) return true;
  if (ticket.userId && ticket.userId === (session?.user.id ?? access?.userId)) return true;
  const sessionEmail = session?.user.email?.trim().toLowerCase();
  const ticketEmail = ticket.email.trim().toLowerCase();
  return Boolean(
    (sessionEmail && ticketEmail === sessionEmail)
    || (email && ticketEmail === email)
  );
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed) ? trimmed : null;
}

function normalizeFilename(value: string): string {
  const base = basename(value || "support-attachment").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  const normalized = base.replace(/\s+/g, " ").slice(0, 180);
  if (!normalized || normalized === "." || normalized === "..") return "support-attachment";
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
  if (ext === ".txt" || ext === ".log") return "text/plain";
  if (ext === ".csv") return "text/csv";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".hwp") return "application/x-hwp";
  if (ext === ".hwpx") return "application/hwp+zip";
  return "application/octet-stream";
}

function validateFile(input: { filename: string; contentType: string; size: number }) {
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new SupportTicketAttachmentError("support_ticket_attachment_empty", "업로드할 파일을 선택해주세요.", 400, "file");
  }
  if (input.size > MAX_FILE_BYTES) {
    throw new SupportTicketAttachmentError("support_ticket_attachment_too_large", "10MB 이하 파일만 업로드할 수 있습니다.", 400, "file");
  }
  const ext = extname(input.filename).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext) && !input.contentType.startsWith("image/") && input.contentType !== "application/pdf") {
    throw new SupportTicketAttachmentError("support_ticket_attachment_unsupported_type", "PDF, 이미지, 텍스트, 로그, HWP/HWPX, DOC/DOCX 파일만 업로드할 수 있습니다.", 400, "file");
  }
}

function buildStorageKey(input: {
  ticketId: string;
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
    .slice(0, 120) || "support-attachment";
  return [
    "support-ticket-attachments",
    input.ticketId,
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
  return Boolean(process.env.DATABASE_URL ?? process.env.SUPABASE_DB_URL ?? process.env.DIRECT_URL);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function uuidOrNull(value: string | undefined): string | null {
  return value && isUuid(value) ? value : null;
}
