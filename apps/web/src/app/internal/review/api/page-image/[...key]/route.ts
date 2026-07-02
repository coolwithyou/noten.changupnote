import { NextResponse } from "next/server";
import { createR2ObjectStorageFromEnv } from "@/lib/server/storage/r2ObjectStorage";
import { getReviewerIdentity } from "@/lib/server/review/reviewAccess";
import { reviewDocOwnsImageKey } from "@/lib/server/review/reviewDocsRepo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ key: string[] }>;
}

/**
 * 검수 페이지 이미지 프록시.
 * - 접근 게이트: admin_users(status=active) 이메일 세션. 미인가는 404.
 * - R2 GetObject 스트리밍 (public 버킷 불필요).
 * - 임의 키 조회 방지: label-review 접두어 + 실제 검수 문서 소유 키만 허용.
 */
export async function GET(_request: Request, context: RouteContext) {
  const reviewer = await getReviewerIdentity();
  if (!reviewer) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const { key: segments } = await context.params;
  const key = (segments ?? []).map((s) => decodeURIComponent(s)).join("/");

  if (!(await reviewDocOwnsImageKey(key))) {
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
