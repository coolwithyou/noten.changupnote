import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { requireCompanyAccess } from "@/lib/server/auth/companyGuard";
import { AuthRequiredError } from "@/lib/server/auth/session";
import { CompanyAccessForbiddenError } from "@/lib/server/auth/companyAccessPolicy";
import { getCunoteDb } from "@/lib/server/db/client";
import * as schema from "@/lib/server/db/schema";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ grantId: string; key: string[] }>;
}

const KEY_PREFIX = "grant-convert/";

/**
 * 사용자용 페이지 이미지 프록시 (Phase 3 Preview Viewer, 설계 결정 2).
 * - 인증: requireCompanyAccess() (미인증 401, 회사 접근 없음 403).
 * - DB 소유 검증: 요청 key 가 **해당 grant 의 surface** 에 속한 page_image artifact 의
 *   storage_key 와 일치할 때만 서빙 (타 grant 로 같은 key 요청 시 404).
 * - `grant-convert/` 프리픽스 밖 임의 키 조회 차단.
 * - R2 스트리밍, `Cache-Control: private, max-age=3600`.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    await requireCompanyAccess();
  } catch (error) {
    if (error instanceof AuthRequiredError) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
    if (error instanceof CompanyAccessForbiddenError) {
      return new NextResponse("Forbidden", { status: 403 });
    }
    return new NextResponse("Not Found", { status: 404 });
  }

  const { grantId, key: segments } = await context.params;
  const key = (segments ?? []).map((segment) => decodeURIComponent(segment)).join("/");

  if (!key.startsWith(KEY_PREFIX)) {
    return new NextResponse("Not Found", { status: 404 });
  }

  if (!(await grantOwnsPageImageKey(grantId, key))) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const storage = createR2ObjectStorageFromEnv();
  if (!storage) {
    return new NextResponse("Storage not configured", { status: 500 });
  }

  try {
    const { body, contentType } = await storage.getObjectBytes(key);
    return new NextResponse(body as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": contentType ?? "image/png",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new NextResponse("Not Found", { status: 404 });
  }
}

/**
 * key 가 이 grant 소유의 page_image artifact storage_key 인지 검증.
 * document_artifacts ⨝ grant_application_surfaces 로 grantId 일치까지 확인한다.
 */
async function grantOwnsPageImageKey(grantId: string, key: string): Promise<boolean> {
  const db = getCunoteDb();
  const rows = await db
    .select({ id: schema.documentArtifacts.id })
    .from(schema.documentArtifacts)
    .innerJoin(
      schema.grantApplicationSurfaces,
      eq(schema.documentArtifacts.surfaceId, schema.grantApplicationSurfaces.id),
    )
    .where(
      and(
        eq(schema.grantApplicationSurfaces.grantId, grantId),
        eq(schema.documentArtifacts.kind, "page_image"),
        eq(schema.documentArtifacts.storageKey, key),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
