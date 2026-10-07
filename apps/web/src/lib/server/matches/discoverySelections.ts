import { and, eq } from "drizzle-orm";
import { deadlineHasPassed } from "@cunote/core";
import { discoverySelectionSchema, type DiscoverySelection } from "@/lib/matches/discoverySelections";
import { canWriteCompany } from "../auth/companyAccessPolicy";
import type { CompanyAccess } from "../auth/companyGuard";
import { getCunoteDb, withCunoteDbUser, type CunoteDbSession } from "../db/client";
import * as schema from "../db/schema";

export class DiscoverySelectionError extends Error {
  constructor(readonly code: string, message: string, readonly status: number) { super(message); }
}
async function withCompany<T>(access: CompanyAccess, write: boolean, run: (tx: CunoteDbSession, canWrite: boolean) => Promise<T>): Promise<T> {
  if (access.mode === "demo") throw new DiscoverySelectionError("discovery_session_required", "저장한 회사로 로그인해 주세요.", 403);
  return withCunoteDbUser(getCunoteDb(), access.userId, async (tx) => {
    const [member] = await tx.select({ role: schema.userCompany.role }).from(schema.userCompany)
      .where(and(eq(schema.userCompany.companyId, access.companyId), eq(schema.userCompany.userId, access.userId))).for("share");
    if (!member || (write && !canWriteCompany(member.role))) throw new DiscoverySelectionError("discovery_forbidden", "회사 탐색 목록에 접근할 권한이 없습니다.", 403);
    return run(tx, canWriteCompany(member.role));
  });
}
export async function loadDiscoverySelections(access: CompanyAccess) {
  return withCompany(access, false, async (tx, canWrite) => ({ canWrite,
    selections: await tx.select({ grantId: schema.companyDiscoverySelections.grantId,
      restored: schema.companyDiscoverySelections.restored, revision: schema.companyDiscoverySelections.revision })
      .from(schema.companyDiscoverySelections).where(eq(schema.companyDiscoverySelections.companyId, access.companyId)),
  }));
}
export async function saveDiscoverySelection(access: CompanyAccess, body: unknown): Promise<DiscoverySelection> {
  const parsed = discoverySelectionSchema.safeParse(body);
  if (!parsed.success) throw new DiscoverySelectionError("invalid_discovery_selection", "공고와 저장 버전을 확인해 주세요.", 422);
  const input = parsed.data;
  return withCompany(access, true, async (tx) => {
    const [grant] = await tx.select({ status: schema.grants.status, applyEnd: schema.grants.applyEnd }).from(schema.grants)
      .where(and(eq(schema.grants.id, input.grantId), eq(schema.grants.servingState, "visible"))).for("share");
    if (!grant) throw new DiscoverySelectionError("discovery_grant_unavailable", "현재 조회할 수 없는 공고입니다.", 404);
    if (input.restored && (grant.status === "closed" || deadlineHasPassed(grant.applyEnd?.toISOString() ?? null, new Date()))) {
      throw new DiscoverySelectionError("discovery_grant_closed", "마감한 공고는 모집 후보로 복원할 수 없습니다. 기존 작성본은 작성 목록에서 열어 주세요.", 409);
    }
    const table = schema.companyDiscoverySelections;
    const values = { restored: input.restored, revision: input.expectedRevision + 1, updatedBy: access.userId, updatedAt: new Date() };
    const returning = { grantId: table.grantId, restored: table.restored, revision: table.revision };
    const rows = input.expectedRevision === 0
      ? await tx.insert(table).values({ companyId: access.companyId, grantId: input.grantId, ...values }).onConflictDoNothing().returning(returning)
      : await tx.update(table).set(values).where(and(eq(table.companyId, access.companyId), eq(table.grantId, input.grantId), eq(table.revision, input.expectedRevision))).returning(returning);
    if (!rows[0]) throw new DiscoverySelectionError("discovery_selection_conflict", "다른 화면에서 목록을 변경했습니다. 새로고침 후 다시 선택해 주세요.", 409);
    return rows[0];
  });
}
