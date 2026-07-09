import { getAdminSql } from "@/lib/server/db/client";
import type { AdminSession } from "@/lib/server/auth/adminSession";

export interface AuditLogInput {
  action: string;
  actorSession: AdminSession;
  targetType: string;
  targetId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

export async function insertCreditAuditLog(input: AuditLogInput): Promise<void> {
  const sql = getAdminSql();
  await sql`
    INSERT INTO credit_audit_logs
      (action, actor_type, actor_id, actor_email, actor_role,
       target_type, target_id, before, after, reason,
       ip_address, user_agent, request_id)
    VALUES (
      ${input.action}, 'admin', ${input.actorSession.user.id},
      ${input.actorSession.user.email}, ${input.actorSession.user.role},
      ${input.targetType}, ${input.targetId},
      ${input.before ? JSON.stringify(input.before) : null},
      ${input.after ? JSON.stringify(input.after) : null},
      ${input.reason ?? null},
      ${input.ipAddress ?? null}, ${input.userAgent ?? null}, ${input.requestId ?? null}
    )
  `;
}
