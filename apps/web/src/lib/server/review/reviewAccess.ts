/**
 * 리뷰어 워크스페이스(/internal/review) 접근 게이트.
 *
 * v1 규약(docs/plans/2026-07-03-reviewer-workspace-v1.md):
 *   next-auth 세션 이메일이 admin_users(status='active')에 존재해야 한다.
 *   서버 컴포넌트/route handler 양쪽에서 검사하고, 미인가는 404 로 취급한다.
 */
import { and, eq } from "drizzle-orm";
import { getCunoteDb } from "../db/client";
import * as schema from "../db/schema";
import { getOptionalWebSession } from "../auth/session";

export interface ReviewerIdentity {
  email: string;
  name: string | null;
  adminUserId: string;
}

/**
 * 인가된 리뷰어면 신원을 반환, 아니면 null.
 * null 을 받은 호출부는 404(notFound / 404 응답)로 처리한다.
 */
export async function getReviewerIdentity(): Promise<ReviewerIdentity | null> {
  const session = await getOptionalWebSession();
  const email = session?.user.email?.trim();
  if (!email) return null;

  const db = getCunoteDb();
  const rows = await db
    .select({ id: schema.adminUsers.id, name: schema.adminUsers.name })
    .from(schema.adminUsers)
    .where(and(eq(schema.adminUsers.email, email), eq(schema.adminUsers.status, "active")))
    .limit(1);

  const admin = rows[0];
  if (!admin) return null;
  return { email, name: admin.name ?? session?.user.name ?? null, adminUserId: admin.id };
}
