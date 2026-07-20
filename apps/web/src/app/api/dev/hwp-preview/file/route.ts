import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { getCunoteDb } from "@/lib/server/db/client";
import { grantAttachmentArchives } from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id 쿼리 필요" }, { status: 400 });
  }

  const db = getCunoteDb();
  const [row] = await db
    .select({
      storageKey: grantAttachmentArchives.storageKey,
      filename: grantAttachmentArchives.filename,
      contentType: grantAttachmentArchives.contentType,
    })
    .from(grantAttachmentArchives)
    .where(eq(grantAttachmentArchives.id, id))
    .limit(1);
  if (!row?.storageKey || !row.storageKey.startsWith("grant-archive/")) {
    return NextResponse.json({ error: "첨부를 찾을 수 없음" }, { status: 404 });
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    return NextResponse.json({ error: "R2 환경변수 미설정" }, { status: 503 });
  }
  const { body } = await storage.getObjectBytes(row.storageKey);
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
      "cache-control": "no-store",
    },
  });
}
