import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getGrantSimulationAdminIdentity } from "@/lib/server/adminGrantSimulation";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { sanitizeDownloadFilename } from "@/lib/server/documents/downloadHeaders";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ grantId: string; attachmentId: string }>;
}

/** 관리자 시뮬레이션 목록의 첨부 원본 프록시. R2 key는 클라이언트에 노출하지 않는다. */
export async function GET(_request: Request, context: RouteContext) {
  const identity = await getGrantSimulationAdminIdentity();
  if (!identity) return new NextResponse("Not Found", { status: 404 });

  const { grantId, attachmentId } = await context.params;
  const [attachment] = await getCunoteDb()
    .select({
      filename: schema.grantAttachmentArchives.filename,
      sourceUri: schema.grantAttachmentArchives.sourceUri,
      storageKey: schema.grantAttachmentArchives.storageKey,
      contentType: schema.grantAttachmentArchives.contentType,
    })
    .from(schema.grants)
    .innerJoin(schema.grantAttachmentArchives, and(
      eq(schema.grantAttachmentArchives.source, schema.grants.source),
      eq(schema.grantAttachmentArchives.sourceId, schema.grants.sourceId),
    ))
    .where(and(
      eq(schema.grants.id, grantId),
      eq(schema.grantAttachmentArchives.id, attachmentId),
    ))
    .limit(1);
  if (!attachment) return new NextResponse("Not Found", { status: 404 });

  if (!attachment.storageKey) {
    const sourceUrl = safeHttpUrl(attachment.sourceUri);
    return sourceUrl
      ? NextResponse.redirect(sourceUrl)
      : new NextResponse("Not Found", { status: 404 });
  }
  if (!attachment.storageKey.startsWith("grant-archive/")) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) return new NextResponse("Storage not configured", { status: 503 });

  try {
    const { body, contentType } = await storage.getObjectBytes(attachment.storageKey);
    const filename = sanitizeDownloadFilename(attachment.filename, `cunote-attachment-${attachmentId.slice(0, 8)}`);
    const resolvedContentType = safeContentType(contentType ?? attachment.contentType);
    const disposition = canRenderInline(resolvedContentType) ? "inline" : "attachment";
    return new NextResponse(new Uint8Array(body), {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "content-type": resolvedContentType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}

function safeHttpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function safeContentType(value: string | null): string {
  if (!value || /[\r\n]/u.test(value)) return "application/octet-stream";
  return value;
}

function canRenderInline(contentType: string): boolean {
  return contentType === "application/pdf" || contentType.startsWith("image/");
}
