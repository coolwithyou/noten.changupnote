import { canVerifySourceCorrection, sourceCorrectionIsOpen, type SourceCorrectionRecord, type SourceCorrectionStatus } from "@cunote/contracts";
import type postgres from "postgres";
import { getAdminSql } from "../db/client";
import type { AdminSession } from "../auth/adminSession";
import { requireAdminRole } from "../auth/adminRole";

export function sourceCorrectionError(code: string, message: string, status = 400) {
  return Object.assign(new Error(message), { code, status });
}
const projection = `id, ticket_id as "ticketId", company_id as "companyId", user_id as "userId", dimension, status, baseline, statement, observation, events, revision`;
export async function loadAdminSourceCorrections(admin: AdminSession, sql = getAdminSql()) {
  requireAdminRole(admin, "support");
  return sql.unsafe<SourceCorrectionRecord[]>(`select ${projection} from profile_source_corrections order by updated_at desc limit 100`);
}

export async function reviewSourceCorrection(input: { admin: AdminSession; id: string; revision: number; action: unknown; note: unknown }, sql: postgres.Sql = getAdminSql()) {
  requireAdminRole(input.admin, "support");
  const states: Record<string, SourceCorrectionStatus> = { review: "reviewing", wait: "waiting_source", verify: "resolved", reject: "rejected" };
  const status = typeof input.action === "string" ? states[input.action] : undefined;
  if (!status || typeof input.note !== "string" || input.note.trim().length < 10 || input.note.length > 2000) {
    throw sourceCorrectionError("invalid_review", "처리 유형과 근거를 10~2,000자로 입력해주세요.");
  }
  return sql.begin(async (tx) => {
    const [record] = await tx.unsafe<SourceCorrectionRecord[]>(`select ${projection} from profile_source_corrections where id=$1 for update`, [input.id]);
    if (!record) throw sourceCorrectionError("source_correction_not_found", "정정 요청을 찾지 못했습니다.", 404);
    if (record.revision !== input.revision || !sourceCorrectionIsOpen(record.status)) throw sourceCorrectionError("source_correction_conflict", "처리 상태가 바뀌었습니다. 다시 조회해주세요.", 409);
    if (status === "resolved" && (record.status !== "reviewing" || !canVerifySourceCorrection(record))) {
      throw sourceCorrectionError("source_observation_required", "검토 중 상태에서 서비스가 재확인한 공식 갱신값이 있어야 완료할 수 있습니다.", 409);
    }
    const now = new Date();
    const events = [...record.events, { at: now.toISOString(), actor: input.admin.user.id, action: String(input.action), note: (input.note as string).trim() }];
    await tx`update profile_source_corrections set status=${status}, events=${tx.json(events.map((event) => ({ ...event })))},
      revision=revision+1, updated_at=${now} where id=${record.id}`;
    const ticketStatus = status === "resolved" || status === "rejected" ? "resolved" : status === "waiting_source" ? "waiting" : "in_progress";
    await tx`update support_tickets set status=${ticketStatus}, updated_at=${now} where id=${record.ticketId}`;
    // Public rationale is available through the existing user support transcript; no automatic email send.
    await tx`insert into support_ticket_messages(ticket_id,author_type,author_email,body,visibility,metadata)
      values (${record.ticketId},'admin',${input.admin.user.email},${(input.note as string).trim()},'public','{}')`;
    return { ...record, status, events, revision: record.revision + 1 };
  });
}
