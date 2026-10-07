import { and, desc, eq } from "drizzle-orm";
import { getCunoteDb, withCunoteDbUser } from "../db/client";
import * as schema from "../db/schema";
import { summarizeDraftResume, type DraftResumeSummary } from "@/lib/documents/draftResume";

export {
  formatDraftResumeCaption,
  formatDraftSavedAt,
  summarizeDraftResume,
  type DraftResumeRow,
  type DraftResumeSummary,
} from "@/lib/documents/draftResume";

/**
 * 공고 요약 화면의 "문서 열기" 재개 CTA 근거(디자인 2라운드 03 장면 F) — 서버 조회.
 * 집계 규칙과 문구는 `@/lib/documents/draftResume`(순수 모듈)에 있다.
 * 조회는 반드시 `withCunoteDbUser` 로 RLS 사용자 컨텍스트를 세운 뒤 수행한다.
 */
export async function loadDraftResume(input: {
  grantId: string;
  companyId: string;
  userId: string;
}): Promise<DraftResumeSummary | null> {
  if (!isUuid(input.grantId) || !isUuid(input.companyId)) return null;
  const db = getCunoteDb();
  const rows = await withCunoteDbUser(db, input.userId, async (tx) => tx
    .select({
      documentKey: schema.grantDocumentDrafts.documentKey,
      status: schema.grantDocumentDrafts.status,
      updatedAt: schema.grantDocumentDrafts.updatedAt,
      headSavedAt: schema.grantDocumentRevisions.createdAt,
    })
    .from(schema.grantDocumentDrafts)
    .leftJoin(
      schema.grantDocumentRevisionHeads,
      eq(schema.grantDocumentRevisionHeads.draftId, schema.grantDocumentDrafts.id),
    )
    .leftJoin(
      schema.grantDocumentRevisions,
      eq(schema.grantDocumentRevisions.id, schema.grantDocumentRevisionHeads.revisionId),
    )
    .where(and(
      eq(schema.grantDocumentDrafts.grantId, input.grantId),
      eq(schema.grantDocumentDrafts.companyId, input.companyId),
    ))
    .orderBy(desc(schema.grantDocumentDrafts.updatedAt), desc(schema.grantDocumentDrafts.createdAt)));
  return summarizeDraftResume(rows);
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
